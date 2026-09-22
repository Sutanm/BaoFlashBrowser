// CDP password capture — keep debugger attached (aligned with working demos)
import type { WebContents } from 'electron';
import log from 'electron-log';
import { getMainWindow } from './window';
import { getMetaForHost, isAutoCaptureEnabled, isCaptureExcluded } from './password-store';
import { credentialOrigin, redactUrlForLog } from '@shared/utils/url-privacy';
import { acquireCdpLease, type CdpLease } from './cdp-lease';
import { extractCredentialParams, extractCredentialPayload } from './password-capture-params';

interface CaptureState {
  wc: WebContents;
  destroyed: boolean;
  injectTimer: ReturnType<typeof setTimeout> | null;
  contexts: Set<number>;
  injectedContexts: Set<number>;
  retryContexts: Set<number>;
  messageListener: (_event: Electron.Event, method: string, params: any) => void;
  capturedSet: Set<string>;
  cdpLease: CdpLease;
}

export function addBoundedCaptureKey(keys: Set<string>, key: string, maxSize = 200): void {
  if (maxSize <= 0) return;
  if (!keys.has(key) && keys.size >= maxSize) {
    const oldest = keys.values().next().value;
    if (oldest) keys.delete(oldest);
  }
  keys.add(key);
}

const captures = new Map<number, CaptureState>();

/** Snapshot of frame execution contexts already discovered by the capture CDP session. */
export function getCaptureContextIds(wc: WebContents): number[] {
  const state = captures.get(wc.id);
  if (!state || state.destroyed) return [];
  return [...state.contexts];
}

// 待保存凭据 —— 模块级全局，不受 state 重建影响（JSONP 捕获后 detach → teardown → setupCapture，旧 state 的 pendingCreds 不丢）
const globalPendingCredentials = new Map<string, { host: string; username: string; password: string; origin: string; title: string; timestamp: number }>();

// 已弹出 toast 的 host+username 去重 —— 模块级全局，跨 detach→re-attach 会话
// 防止同一登录在 capture session 重建后被重复捕获并再次弹出 toast
const shownToastKeys = new Map<string, { captureId: string; timestamp: number }>();

// 密码 5 分钟 TTL 自动过期清理，防止内存泄漏
setInterval(() => {
  const now = Date.now();
  for (const [id, cred] of globalPendingCredentials.entries()) {
    if (now - cred.timestamp > 5 * 60 * 1000) {
      globalPendingCredentials.delete(id);
    }
  }
  for (const [key, val] of shownToastKeys.entries()) {
    if (now - val.timestamp > 5 * 60 * 1000) {
      shownToastKeys.delete(key);
    }
  }
}, 60 * 1000);

function sendToRenderer(channel: string, payload: Record<string, unknown>): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function detachQuietly(state: CaptureState): void {
  try { state.cdpLease.release(); } catch { /* ignore duplicate detach */ }
}

export const CAPTURE_SCRIPT = `
(function() {
  if (window.__baop_pw_capture) return;
  window.__baop_pw_capture = true;
  function _baopEmit(payload){try{window.__baopReport(JSON.stringify(payload));}catch(e){}}
  _baopEmit({_type:'baop_diag',msg:'script loaded host='+location.hostname});
  // 监听器环境自检（只读诊断，零副作用）。
  //
  // ⚠️ 历史：2026-09-21 这里曾用"造一个同源 about:blank iframe、取其中未被改写的
  // addEventListener 来兜底"的写法，假设站点会劫持 addEventListener 屏蔽外部监听。
  // 该假设从未被任何实测证实（7k7k 两个页面与 4399 实测 patched=false），而代价是确定的：
  // 注入按"新执行上下文创建"触发 → 我们建的 iframe 会跑同一段脚本 → 再建子帧……
  // 实测同一页面：生产脚本 71 次 script loaded（其中 69 个是我们自造的空帧）、
  // 页面报 57 次 "Maximum call stack size exceeded"；而最小脚本只有 2 次、0 次报错。
  // 且空帧里该探测恒返回不可用。已于 2026-09-22 整段删除，不要再加回来。
  var _baopSelfTestHit = false;
  (function() {
    var probe = function() { _baopSelfTestHit = true; };
    try { document.addEventListener('__baop_probe', probe, true); } catch(e) {}
    try { document.dispatchEvent(new Event('__baop_probe', { bubbles: true })); } catch(e) {}
    try { document.removeEventListener('__baop_probe', probe, true); } catch(e) {}
  })();
  // 劫持的两条便宜的旁证：实现源码长度（被包装/替换会变）与实例级改写。
  var _baopAddFnLen = 0, _baopInstOverridden = false;
  try { _baopAddFnLen = String(EventTarget.prototype.addEventListener).length; } catch(e) {}
  try { _baopInstOverridden = document.addEventListener !== EventTarget.prototype.addEventListener; } catch(e) {}
  function _baopOn(target, type, handler) {
    try { target.addEventListener(type, handler, true); } catch(e) {}
  }
  _baopEmit({_type:'baop_diag',msg:'listener env selftest='+_baopSelfTestHit+' addFnLen='+_baopAddFnLen+' instOverridden='+_baopInstOverridden+' host='+location.hostname});
  var _rawUser='',_rawPass='';
  var extractCredentialParams = (${extractCredentialParams.toString()});
  var extractCredentialPayload = (${extractCredentialPayload.toString()});
  // 不可作为账号框的 input 类型。历史坑（2026-09-22 修）：选择器里有
  // input[name*="login"] / input[id*="user"] 这类宽匹配，而旧守卫只排除了 password 与 hidden，
  // 于是登录页账号框一为空（先输密码、或站点 JS 后填）就会命中 type=submit 的提交按钮，
  // 把按钮文字当用户名上报 —— 实测 7k7k 登录页 3 条 capture 的 user 全是按钮上的"提交"，
  // 会存成垃圾账号，并带歪 skip already-saved 的查重键（host+user）。
  var _BAOP_NON_TEXT_INPUTS = {password:1,hidden:1,submit:1,button:1,image:1,reset:1,checkbox:1,radio:1,file:1,range:1,color:1};
  function findUserInput(container) {
    var s=['input[type="text"]','input[type="email"]','input[type="tel"]','input[name*="user"]','input[name*="login"]','input[name*="account"]','input[name*="username"]','input[name*="name"]','input[id*="user"]','input[id*="login"]','input[id*="name"]','input[autocomplete="username"]'];
    for(var i=0;i<s.length;i++){
      var e=container.querySelector(s[i]);
      if(!e||!e.value)continue;
      if(_BAOP_NON_TEXT_INPUTS[String(e.type||'').toLowerCase()])continue;
      return e;
    }
    return null;
  }
  function report(src) {
    if(!_rawPass||_rawPass.length<2)return;
    _baopEmit({_type:'baop_capture',user:_rawUser||'',pass:_rawPass,host:location.hostname,origin:location.href,title:document.title,source:src});
    _rawPass='';_rawUser='';
  }
  _baopOn(document,'input',function(e){
    if(e.target.type!=='password')return;
    _rawPass=e.target.value;
    var c=e.target.closest('form')||e.target.closest('[class*="login"]')||e.target.closest('[class*="con"]')||e.target.closest('[class*="pop"]')||document;
    var u=findUserInput(c);if(u&&u.value)_rawUser=u.value;
    _baopEmit({_type:'baop_diag',msg:'input pw len='+_rawPass.length+' host='+location.hostname});
  });
  // 诊断（每 frame 一次）：记录"首次非密码输入"落在哪个元素上 ——
  // 若站点把密码框换成 type=text + CSS 遮罩（规避密码管理器），这里是唯一能看到证据的地方。
  var _firstInputDiagDone = false;
  _baopOn(document,'input',function(e){
    try {
      if (_firstInputDiagDone) return;
      var t = (e && e.target) || {};
      if (String(t.type || '').toLowerCase() === 'password') return;
      _firstInputDiagDone = true;
      _baopEmit({_type:'baop_diag',msg:'first input tag='+(t.tagName||'?')+' type='+(t.type||'-')
        +' id='+(t.id||'-')+' name='+(t.name||'-')+' host='+location.hostname});
    } catch(err) {}
  });
  // 诊断兜底（每 frame 只报一次）：若页面在 window 捕获阶段 stopPropagation 吞掉 input
  // 事件，本 frame 将完全没有证据，排查只能靠猜。记录"首次键盘输入落在哪个元素上"，
  // 即可判定键盘输入是否真的进到本 frame 的 DOM（以及落在什么类型元素上）。
  var _firstKeyDiagDone = false;
  _baopOn(window,'keydown',function(e) {
    try {
      if (_firstKeyDiagDone) return;
      _firstKeyDiagDone = true;
      var t = (e && e.target) || {};
      _baopEmit({_type:'baop_diag',msg:'first keydown tag='+(t.tagName||'?')+' type='+(t.type||'-')
        +' pwDoc='+document.querySelectorAll('input[type="password"]').length+' host='+location.hostname});
    } catch(err) {}
  });
  _baopOn(document,'submit',function(e){
    var p=e.target.querySelector('input[type="password"]');
    _baopEmit({_type:'baop_diag',msg:'submit form='+e.target.tagName+' hasPw='+(!!p)+' host='+location.hostname});
    if(!p||!p.value||p.value.length<2)return;
    var u=findUserInput(e.target);
    _baopEmit({_type:'baop_capture',user:u?u.value:'',pass:p.value,host:location.hostname,origin:location.href,title:document.title,source:'submit'});
  },true);
  _baopOn(window,'beforeunload',function(){
    _baopEmit({_type:'baop_diag',msg:'beforeunload pwLen='+(_rawPass?_rawPass.length:0)+' host='+location.hostname});
    if(_rawPass&&_rawPass.length>=2)report('beforeunload');
  });

  // Strategy B: 500ms 轮询，检测密码框被清空或被加密值替换（适配 AJAX 登录）
  var _lastLen = 0;
  var _iter = 0;
  setInterval(function() {
    _iter++;
    var pw = document.querySelector('input[type="password"]');
    if (!pw) return;
    var container = pw.closest('form') || pw.closest('[class*="login"]') || pw.closest('[class*="con"]') || pw.closest('[class*="pop"]') || document;
    var user = container ? findUserInput(container) : null;
    if (user && user.value) _rawUser = user.value;
    var len = pw.value.length;
    if (len > 0 && len < 60) {
      if (pw.value !== _rawPass) {
        _rawPass = pw.value;
        _lastLen = len;
      }
    }
    // 密码框被清空 → 登录提交了
    if (len === 0 && _lastLen > 0) {
      _baopEmit({_type:'baop_diag',msg:'poll trigger: cleared was='+_lastLen+' host='+location.hostname});
      report('cleared');
      _lastLen = 0;
    }
    // 密码被加密值替换 → 登录提交了
    if (len > 60 && _lastLen > 0 && _lastLen < 60) {
      _baopEmit({_type:'baop_diag',msg:'poll trigger: encrypted was='+_lastLen+' now='+len+' host='+location.hostname});
      report('encrypted');
      _lastLen = 0;
    }
  }, 500);

  // Strategy D: AJAX 登录拦截（fetch + XHR），捕获 SPA/AJAX 表单提交
  function tryReportFromBody(body, src) {
    try {
      var s = typeof body === 'string' ? body : '';
      if (!s && body && typeof body === 'object') {
        try { s = JSON.stringify(body); } catch(e) {}
      }
      if (!s || s.length < 2) return;
      var parsed = extractCredentialPayload(s);
      if (!parsed) return;
      var user = parsed.username || _rawUser || '';
      _baopEmit({_type:'baop_capture',user:user,pass:parsed.password,host:location.hostname,origin:location.href,title:document.title,source:src});
      _rawPass='';_rawUser='';
    } catch(e) {}
  }

  // 拦截 fetch
  if (window.fetch && !window.__baop_fetch_hooked) {
    window.__baop_fetch_hooked = true;
    var _origFetch = window.fetch;
    window.fetch = function(input, init) {
      try {
        if (init && init.body) tryReportFromBody(init.body, 'fetch');
        else if (typeof input === 'string' && _rawPass) {
          // 无 body 但有原始密码（query string 场景）
          tryReportFromUrl(input, 'fetch-query');
        }
      } catch(e) {}
      return _origFetch.apply(this, arguments);
    };
  }

  // 拦截 XMLHttpRequest
  if (window.XMLHttpRequest && !window.__baop_xhr_hooked) {
    window.__baop_xhr_hooked = true;
    var _origSend = XMLHttpRequest.prototype.send;
    var _origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      this.__baop_url = url || '';
      return _origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function(body) {
      try {
        if (body) tryReportFromBody(body, 'xhr');
        else if (this.__baop_url && _rawPass) {
          tryReportFromUrl(this.__baop_url, 'xhr-query');
        }
      } catch(e) {}
      return _origSend.apply(this, arguments);
    };
  }

  // Strategy E: 拦截 HTMLFormElement.prototype.submit（程序化提交，不触发 submit 事件）
  if (window.HTMLFormElement && !window.__baop_formsubmit_hooked) {
    window.__baop_formsubmit_hooked = true;
    var _origFormSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function() {
      try {
        var p = this.querySelector('input[type="password"]');
        _baopEmit({_type:'baop_diag',msg:'form.submit() called hasPw='+(!!p)+' host='+location.hostname});
        if (p && p.value && p.value.length >= 2) {
          var u = findUserInput(this);
          _baopEmit({_type:'baop_capture',user:u?u.value:'',pass:p.value,host:location.hostname,origin:location.href,title:document.title,source:'form.submit'});
        }
      } catch(e) {}
      return _origFormSubmit.apply(this, arguments);
    };
  }

  // Strategy F: 拦截 navigator.sendBeacon
  if (navigator && navigator.sendBeacon && !window.__baop_beacon_hooked) {
    window.__baop_beacon_hooked = true;
    var _origBeacon = navigator.sendBeacon;
    navigator.sendBeacon = function(url, data) {
      try {
        if (data) tryReportFromBody(data, 'beacon');
        else if (_rawPass && url) {
          tryReportFromUrl(url, 'beacon-query');
        }
      } catch(e) {}
      return _origBeacon.apply(this, arguments);
    };
  }

  // Strategy G: 点击登录容器内的按钮/元素时上报（覆盖 click -> 读 DOM -> 任何提交方式）
  //
  // 诊断（2026-09-21）：过去"点登录没反应"只能靠日志缺行倒推（是点在别的 frame？还是本
  // frame 有密码框但没观测到输入？）。现在只要点到按钮/登录文案且本 frame 有密码框或
  // 点在登录容器内，就先上报一条 'click any' 诊断，把判断依据一次说清：
  //   pwDoc      = 本 frame 内 input[type=password] 数量（0 说明登录框不在本 frame）
  //   hasRawPass = 本 frame 闭包是否已拿到密码（0 说明输入没发生在本 frame）
  _baopOn(document,'click',function(e) {
    try {
      var target = e.target;
      if (!target || !target.closest) return;
      var text = (target.innerText || target.value || '').toLowerCase().trim().slice(0, 24);
      var tagName = target.tagName || '';
      var isButton = tagName === 'BUTTON' || tagName === 'INPUT' && (target.type === 'submit' || target.type === 'button');
      var isLoginText = /登\\s*录|login|sign(?:\\s|_|-)*in|submit|确\\s*定|进\\s*入|go/.test(text);
      var container = target.closest('form') || target.closest('[class*="login"]') || target.closest('[class*="con"]') || target.closest('[class*="pop"]');
      var pwDoc = document.querySelectorAll('input[type="password"]').length;
      var pwInContainer = container ? container.querySelector('input[type="password"]') : null;
      // 触发面刻意放宽：图片按钮/无文字按钮点不到 isButton||isLoginText，
      // 只要点在含密码框的容器内也上报，避免"点了但没记录"造成漏判。
      if (!isButton && !isLoginText && !pwInContainer) return;
      if (pwDoc === 0 && !container) return; // 与登录无关的点击不刷日志
      _baopEmit({_type:'baop_diag',msg:'click any tag='+tagName+' txt='+text+' pwDoc='+pwDoc
        +' pwContainer='+(pwInContainer?1:0)+' hasRawPass='+(_rawPass?_rawPass.length:0)
        +' btn='+isButton+' login='+isLoginText+' host='+location.hostname});
      if (!_rawPass || _rawPass.length < 2) return;
      if (!container) return;
      if (!pwInContainer || !pwInContainer.value) return;
      var userNow = _rawUser || '';
      var u = findUserInput(container);
      if (u && u.value) userNow = u.value;
      _baopEmit({_type:'baop_diag',msg:'click trigger isBtn='+isButton+' isLogin='+isLoginText+' host='+location.hostname});
      report('click-login');
    } catch(e) {}
  }, true);

  // 诊断（2026-09-21）：延迟上报"本 frame 里到底有没有密码框"。
  // 只报有密码框的 frame，避免每个 ad/空 frame 都刷一行；用于回答
  // "登录框在哪个 frame"——若没有任何 frame 报 pwInputs，说明密码框不在可注入上下文内
  // （弹窗/未注入 frame/自绘控件）。
  setTimeout(function() {
    try {
      var n = document.querySelectorAll('input[type="password"]').length;
      if (n > 0) _baopEmit({_type:'baop_diag',msg:'frame info pwInputs='+n+' host='+location.hostname});
    } catch(e) {}
  }, 1500);

  // Strategy H: 从任意 URL / script src 中解析 query 参数提取 password（覆盖 JSONP、<script> 注入、Image ping 等）
  function tryReportFromUrl(urlStr, src) {
    try {
      if (!urlStr || urlStr.length < 8 || !_rawPass) return;
      var parsed = extractCredentialParams(String(urlStr));
      if (!parsed) return;
      var pw = parsed.password, user = parsed.username;
      if (!user) user = _rawUser || '';
      _baopEmit({_type:'baop_diag',msg:'url trigger src='+src+' pwLen='+pw.length+' host='+location.hostname});
      _baopEmit({_type:'baop_capture',user:user||'',pass:pw,host:location.hostname,origin:location.href,title:document.title,source:src});
      _rawPass='';_rawUser='';
    } catch(e) {}
  }

  // Hook HTMLScriptElement.src setter（捕获 JSONP 登录，如 7k7k Post_pay.php?username=&password=）
  if (window.HTMLScriptElement && !window.__baop_script_src_hooked) {
    window.__baop_script_src_hooked = true;
    try {
      var scriptProto = HTMLScriptElement.prototype;
      var scriptDesc = Object.getOwnPropertyDescriptor(scriptProto, 'src') || Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'src');
      if (scriptDesc && scriptDesc.set) {
        Object.defineProperty(scriptProto, 'src', {
          set: function(v) {
            tryReportFromUrl(v, 'script-src');
            return scriptDesc.set.call(this, v);
          },
          get: scriptDesc.get,
          configurable: true,
          enumerable: true
        });
      }
    } catch(e) {}
  }

  // Hook HTMLScriptElement.src getter/setter 失败时的 fallback：监听 DOM 变化，观察新插入的 <script>
  if (window.MutationObserver && !window.__baop_script_mo_hooked) {
    window.__baop_script_mo_hooked = true;
    try {
      new MutationObserver(function(mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var nodes = mutations[i].addedNodes;
          for (var j = 0; j < nodes.length; j++) {
            var node = nodes[j];
            if (node.tagName === 'SCRIPT' && node.src) tryReportFromUrl(node.src, 'script-mo');
          }
        }
      }).observe(document.documentElement || document, { childList: true, subtree: true });
    } catch(e) {}
  }

  // Hook Image.src setter（捕获 <img src="?password="> 隐式 ping 登录）
  if (window.HTMLImageElement && !window.__baop_img_src_hooked) {
    window.__baop_img_src_hooked = true;
    try {
      var imgDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
      if (imgDesc && imgDesc.set) {
        Object.defineProperty(HTMLImageElement.prototype, 'src', {
          set: function(v) {
            tryReportFromUrl(v, 'img-src');
            return imgDesc.set.call(this, v);
          },
          get: imgDesc.get,
          configurable: true,
          enumerable: true
        });
      }
    } catch(e) {}
  }
})()`;

async function injectContext(state: CaptureState, contextId: number): Promise<void> {
  if (state.destroyed || state.wc.isDestroyed() || !state.contexts.has(contextId) || state.injectedContexts.has(contextId)) return;
  try {
    await state.wc.debugger.sendCommand('Runtime.evaluate', {
      expression: CAPTURE_SCRIPT,
      awaitPromise: false,
      contextId,
    });
    if (!state.destroyed && state.contexts.has(contextId)) {
      state.injectedContexts.add(contextId);
      state.retryContexts.delete(contextId);
    }
  } catch (error) {
    log.debug('[PasswordCapture] context injection failed; retry scheduled', {
      contextId,
      error: error instanceof Error ? error.message : String(error),
    });
    if (!state.destroyed && state.contexts.has(contextId) && state.wc.debugger.isAttached()) {
      state.retryContexts.add(contextId);
      scheduleFailedInjectionRetry(state, 4000);
    }
  }
}

function scheduleFailedInjectionRetry(state: CaptureState, delay: number): void {
  if (state.destroyed || state.wc.isDestroyed() || state.injectTimer || state.retryContexts.size === 0) return;
  state.injectTimer = setTimeout(async () => {
    state.injectTimer = null;
    if (state.destroyed || state.wc.isDestroyed()) return;
    if (!state.wc.debugger.isAttached()) {
      state.retryContexts.clear();
      return;
    }
    const failed = [...state.retryContexts];
    await Promise.all(failed.map((contextId) => injectContext(state, contextId)));
    if (state.retryContexts.size > 0) scheduleFailedInjectionRetry(state, 4000);
  }, delay);
}

export function setupCapture(wc: WebContents): void {
  if (!wc || wc.isDestroyed()) return;
  if (process.env.BAO_NO_CDP === '1') {
    teardownCapture(wc);
    return;
  }
  if (!isAutoCaptureEnabled()) {
    teardownCapture(wc);
    return;
  }
  if (isCaptureExcluded(wc.getURL())) {
    log.info('[PasswordCapture] excluded site, wc.id=' + wc.id + ' url=' + redactUrlForLog(wc.getURL()));
    teardownCapture(wc);
    return;
  }

  log.info('[PasswordCapture] setupCapture wc=' + wc.id + ' url=' + redactUrlForLog(wc.getURL()));

  // 强制清理旧 state（对齐 bv demo 的 detach+reattach 模式）
  const existing = captures.get(wc.id);
  if (existing) {
    if (!existing.destroyed && wc.debugger.isAttached()) return;
    teardownCapture(wc);
  }

  let cdpLease: CdpLease;
  try { cdpLease = acquireCdpLease(wc, 'password-capture'); } catch (e: any) {
    log.warn('[PasswordCapture] attach failed:', e.message);
    return;
  }

  const state: CaptureState = {
    wc,
    destroyed: false,
    injectTimer: null,
    contexts: new Set(),
    injectedContexts: new Set(),
    retryContexts: new Set(),
    messageListener: () => {},
    capturedSet: new Set(),
    cdpLease,
  };
  log.info('[PasswordCapture] attached, wc.id=' + wc.id);

  state.messageListener = (_event, method, params: any) => {
    if (state.destroyed) return;
    if (method === 'Runtime.executionContextCreated') {
      const ctxId = params.context.id;
      state.contexts.add(ctxId);
      // Per-context diagnostics: CDP emits this for every frame and isolated
      // world, which flooded the log (~1.5k lines in a single session). Kept at
      // debug so it stays available without burying real events.
      log.debug('[PasswordCapture] context created: ' + ctxId + ' (total=' + state.contexts.size + ')');
      void injectContext(state, ctxId);
    }
    if (method === 'Runtime.executionContextDestroyed') {
      state.contexts.delete(params.executionContextId);
      state.injectedContexts.delete(params.executionContextId);
      state.retryContexts.delete(params.executionContextId);
    }
    if (method === 'Runtime.executionContextsCleared') {
      state.contexts.clear();
      state.injectedContexts.clear();
      state.retryContexts.clear();
    }
    if (method !== 'Runtime.bindingCalled' || params.name !== '__baopReport') return;
    for (const text of [String(params.payload || '')]) {
      if (!text.startsWith('{"_type":"baop_')) continue;
      try {
        const data = JSON.parse(text);
        if (data._type === 'baop_diag') {
          log.info('[PasswordCapture] DIAG: ' + data.msg);
          continue;
        }
        if (data._type !== 'baop_capture') continue;
        // 用户名允许为空（对齐 Chrome）：部分登录页先填密码、用户名由站点 JS 后补，或压根没有
        // 用户名框（卡号/手机号/邮箱即账号）。此前 `!data.user` 会让这类登录静默不弹提示。
        if (!data.pass || String(data.pass).length < 2) continue;
        const username = typeof data.user === 'string' ? data.user : '';
        if (isCaptureExcluded(String(data.origin || data.host || ''))) continue;
        const key = `${data.host}/${username}`;
        if (state.capturedSet.has(key)) continue;

        let skipToast = shownToastKeys.has(key);
        if (skipToast) {
          log.info('[PasswordCapture] skip already-shown-toast host=' + data.host);
        }

        if (!skipToast) addBoundedCaptureKey(state.capturedSet, key);
        const captureId = 'cap_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        if (!skipToast) {
          globalPendingCredentials.set(captureId, {
            host: data.host,
            username,
            password: data.pass,
            origin: credentialOrigin(String(data.origin || ''), String(data.host || '')),
            title: data.title || '',
            timestamp: Date.now(),
          });
        }

        // 已保存账号查重：跳过密码本中已有的 host+username 组合，避免重复弹出 toast
        if (!skipToast) {
          try {
            const existing = getMetaForHost(data.host);
            if (existing.some((e) => e.username === username)) {
              log.info('[PasswordCapture] skip already-saved host=' + data.host);
              skipToast = true;
            }
          } catch { /* password-store 未初始化时忽略 */ }
        }

        // Workaround for 7k7k JSONP stuck: debugger attached may block <script> onload callback execution.
        // ⚠️ detach 必须在 toast 决策之后、continue 之前执行，无论是否显示 toast 都要 detach
        const needsDetach = ['script-src', 'script-mo', 'img-src', 'beacon', 'fetch', 'xhr', 'form.submit', 'click-login'].includes(String(data.source || ''));
        if (needsDetach) {
          log.info('[PasswordCapture] detach after capture source=' + data.source + ' (unblock JSONP callback)');
          detachQuietly(state);
        }

        if (skipToast) {
          globalPendingCredentials.delete(captureId);
          continue;
        }

        shownToastKeys.set(key, { captureId, timestamp: Date.now() });
        sendToRenderer('password:captured', { captureId, host: data.host, username });
        log.info('[PasswordCapture] captured host=' + data.host + ' source=' + data.source);
        // LRU：超过 50 条删最早的（removePendingCredential 里也会兜底）
        if (globalPendingCredentials.size > 50) { const fk = globalPendingCredentials.keys().next().value; if (fk) globalPendingCredentials.delete(fk); }
      } catch { /* ignore detach errors */ }
    }
  };
  wc.debugger.on('message', state.messageListener);

  wc.debugger.sendCommand('Runtime.addBinding', { name: '__baopReport' }).then(() =>
    wc.debugger.sendCommand('Runtime.enable')).then(() => {
    log.info('[PasswordCapture] Runtime.enable OK, injecting main frame');
    wc.debugger.sendCommand('Runtime.evaluate', { expression: CAPTURE_SCRIPT, awaitPromise: false }).catch((error) => {
      log.debug('[PasswordCapture] main-frame injection failed', error instanceof Error ? error.message : String(error));
    });
  }).catch((e: any) => {
    log.warn('[PasswordCapture] Runtime.enable failed:', e?.message);
  });

  captures.set(wc.id, state);
}

export function teardownCapture(wc: WebContents): void {
  if (!wc) return;
  const state = captures.get(wc.id); if (!state) return;
  captures.delete(wc.id);
  state.destroyed = true;
  if (state.injectTimer) {
    clearTimeout(state.injectTimer);
    state.injectTimer = null;
  }
  state.contexts.clear();
  state.injectedContexts.clear();
  state.retryContexts.clear();
  try { state.wc.debugger.removeListener('message', state.messageListener); } catch { /* local cleanup best effort */ }
  if (!state.wc.isDestroyed()) detachQuietly(state);
}

export function getPendingCredential(captureId: string): { host: string; username: string; password: string; origin: string; title: string; timestamp: number } | null {
  return globalPendingCredentials.get(captureId) || null;
}

export function removePendingCredential(captureId: string): void {
  globalPendingCredentials.delete(captureId);
  // 同步清理 shownToastKeys，下次相同 host+user 允许再次弹出的逻辑由 password-store 查重保证
  for (const [k, v] of shownToastKeys.entries()) {
    if (v.captureId === captureId) {
      shownToastKeys.delete(k);
      break;
    }
  }
  // LRU：超过 50 条删最早的
  if (globalPendingCredentials.size > 50) {
    const firstKey = globalPendingCredentials.keys().next().value;
    if (firstKey) globalPendingCredentials.delete(firstKey);
  }
}

// 通知 renderer 密码本数据变化（保存/删除/修改/重置后广播，面板自动刷新）
export function notifyPasswordChanged(): void {
  sendToRenderer('password:changed', { ts: Date.now() });
}
