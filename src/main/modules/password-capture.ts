// CDP password capture — keep debugger attached (aligned with working demos)
import type { WebContents } from 'electron';
import log from 'electron-log';
import { getMainWindow } from './window';
import { getMetaForHost, isAutoCaptureEnabled, isCaptureExcluded } from './password-store';

interface CaptureState {
  wc: WebContents;
  destroyed: boolean;
  injectTimer: ReturnType<typeof setTimeout> | null;
  contexts: Set<number>;
  capturedSet: Set<string>;
  pendingCredentials: Map<string, { host: string; username: string; password: string; origin: string; title: string }>;
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
  // 直接尝试 detach，try/catch 处理重复 detach（对齐 bv demo）
  try { state.wc.debugger.detach(); } catch { /* ignore duplicate detach */ }
}

const CAPTURE_SCRIPT = `
(function() {
  if (window.__baop_pw_capture) return;
  window.__baop_pw_capture = true;
  console.log(JSON.stringify({_type:'baop_diag',msg:'script loaded host='+location.hostname+' href='+location.href}));
  var _rawUser='',_rawPass='';
  function findUserInput(container) {
    var s=['input[type="text"]','input[type="email"]','input[type="tel"]','input[name*="user"]','input[name*="login"]','input[name*="account"]','input[name*="username"]','input[name*="name"]','input[id*="user"]','input[id*="login"]','input[id*="name"]','input[autocomplete="username"]'];
    for(var i=0;i<s.length;i++){var e=container.querySelector(s[i]);if(e&&e.value&&e.type!=='password'&&e.type!=='hidden')return e;}
    return null;
  }
  function report(src) {
    if(!_rawPass||_rawPass.length<2)return;
    console.log(JSON.stringify({_type:'baop_capture',user:_rawUser||'',pass:_rawPass,host:location.hostname,origin:location.href,title:document.title,source:src}));
    _rawPass='';_rawUser='';
  }
  document.addEventListener('input',function(e){
    if(e.target.type!=='password')return;
    _rawPass=e.target.value;
    var c=e.target.closest('form')||e.target.closest('[class*="login"]')||e.target.closest('[class*="con"]')||e.target.closest('[class*="pop"]')||document;
    var u=findUserInput(c);if(u&&u.value)_rawUser=u.value;
    console.log(JSON.stringify({_type:'baop_diag',msg:'input pw len='+_rawPass.length+' user='+_rawUser+' host='+location.hostname}));
  },true);
  document.addEventListener('submit',function(e){
    var p=e.target.querySelector('input[type="password"]');
    console.log(JSON.stringify({_type:'baop_diag',msg:'submit form='+e.target.tagName+' hasPw='+(!!p)+' host='+location.hostname}));
    if(!p||!p.value||p.value.length<2)return;
    var u=findUserInput(e.target);
    console.log(JSON.stringify({_type:'baop_capture',user:u?u.value:'',pass:p.value,host:location.hostname,origin:location.href,title:document.title,source:'submit'}));
  },true);
  window.addEventListener('beforeunload',function(){
    console.log(JSON.stringify({_type:'baop_diag',msg:'beforeunload pwLen='+(_rawPass?_rawPass.length:0)+' host='+location.hostname}));
    if(_rawPass&&_rawPass.length>=2)report('beforeunload');
  });

  // Strategy B: 200ms 轮询，检测密码框被清空或被加密值替换（适配 AJAX 登录）
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
      console.log(JSON.stringify({_type:'baop_diag',msg:'poll trigger: cleared was='+_lastLen+' host='+location.hostname}));
      report('cleared');
      _lastLen = 0;
    }
    // 密码被加密值替换 → 登录提交了
    if (len > 60 && _lastLen > 0 && _lastLen < 60) {
      console.log(JSON.stringify({_type:'baop_diag',msg:'poll trigger: encrypted was='+_lastLen+' now='+len+' host='+location.hostname}));
      report('encrypted');
      _lastLen = 0;
    }
  }, 200);

  // Strategy D: AJAX 登录拦截（fetch + XHR），捕获 SPA/AJAX 表单提交
  function tryReportFromBody(body, src) {
    try {
      var s = typeof body === 'string' ? body : '';
      if (!s && body && typeof body === 'object') {
        try { s = JSON.stringify(body); } catch(e) {}
      }
      if (!s || s.length < 2) return;
      var lower = s.toLowerCase();
      var pw = null, user = null;
      // 尝试 URL-encoded form: password=xxx&username=yyy
      var m = lower.match(/password=([^&]+)/);
      if (m) { try { pw = decodeURIComponent(m[1]); } catch(e) { pw = m[1]; } }
      var m2 = lower.match(/(username|user|login|account|acct|name)=([^&]+)/);
      if (m2) { try { user = decodeURIComponent(m2[2]); } catch(e) { user = m2[2]; } }
      // 尝试 JSON: {"password":"xxx","username":"yyy"}
      if (!pw) {
        try {
          var j = JSON.parse(s);
          if (j && typeof j === 'object') {
            if (j.password) pw = String(j.password);
            if (j.username) user = String(j.username);
            else if (j.user) user = String(j.user);
            else if (j.login) user = String(j.login);
            else if (j.account) user = String(j.account);
          }
        } catch(e) {}
      }
      if (!pw || pw.length < 2) return;
      if (!user) user = _rawUser || '';
      console.log(JSON.stringify({_type:'baop_capture',user:user||'',pass:pw,host:location.hostname,origin:location.href,title:document.title,source:src}));
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
          var lower = input.toLowerCase();
          if (lower.indexOf('password=') >= 0 || lower.indexOf('pwd=') >= 0) {
            var m = lower.match(/password=([^&]+)/) || lower.match(/pwd=([^&]+)/);
            if (m) { try { var p = decodeURIComponent(m[1]); if (p.length>=2) { console.log(JSON.stringify({_type:'baop_capture',user:_rawUser||'',pass:p,host:location.hostname,origin:location.href,title:document.title,source:'fetch-query'})); _rawPass='';_rawUser=''; } } catch(e) {} }
          }
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
          var lower = String(this.__baop_url).toLowerCase();
          if (lower.indexOf('password=') >= 0 || lower.indexOf('pwd=') >= 0) {
            var m = lower.match(/password=([^&]+)/) || lower.match(/pwd=([^&]+)/);
            if (m) { try { var p = decodeURIComponent(m[1]); if (p.length>=2) { console.log(JSON.stringify({_type:'baop_capture',user:_rawUser||'',pass:p,host:location.hostname,origin:location.href,title:document.title,source:'xhr-query'})); _rawPass='';_rawUser=''; } } catch(e) {} }
          }
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
        console.log(JSON.stringify({_type:'baop_diag',msg:'form.submit() called hasPw='+(!!p)+' host='+location.hostname}));
        if (p && p.value && p.value.length >= 2) {
          var u = findUserInput(this);
          console.log(JSON.stringify({_type:'baop_capture',user:u?u.value:'',pass:p.value,host:location.hostname,origin:location.href,title:document.title,source:'form.submit'}));
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
          var lower = String(url).toLowerCase();
          if (lower.indexOf('password=') >= 0 || lower.indexOf('pwd=') >= 0) {
            var m = lower.match(/password=([^&]+)/) || lower.match(/pwd=([^&]+)/);
            if (m) { try { var p = decodeURIComponent(m[1]); if (p.length>=2) { console.log(JSON.stringify({_type:'baop_capture',user:_rawUser||'',pass:p,host:location.hostname,origin:location.href,title:document.title,source:'beacon-query'})); _rawPass='';_rawUser=''; } } catch(e) {} }
          }
        }
      } catch(e) {}
      return _origBeacon.apply(this, arguments);
    };
  }

  // Strategy G: 点击登录容器内的按钮/元素时上报（覆盖 click -> 读 DOM -> 任何提交方式）
  document.addEventListener('click', function(e) {
    try {
      if (!_rawPass || _rawPass.length < 2) return;
      var target = e.target;
      if (!target || !target.closest) return;
      var container = target.closest('form') || target.closest('[class*="login"]') || target.closest('[class*="con"]') || target.closest('[class*="pop"]');
      if (!container) return;
      var pwInContainer = container.querySelector('input[type="password"]');
      if (!pwInContainer || !pwInContainer.value) return;
      var text = (target.innerText || target.value || '').toLowerCase().trim();
      var tagName = target.tagName || '';
      var isButton = tagName === 'BUTTON' || tagName === 'INPUT' && (target.type === 'submit' || target.type === 'button');
      var isLoginText = /登\\s*录|login|sign(?:\\s|_|-)*in|submit|确\\s*定|进\\s*入|go/.test(text);
      if (isButton || isLoginText) {
        var userNow = _rawUser || '';
        var u = findUserInput(container);
        if (u && u.value) userNow = u.value;
        console.log(JSON.stringify({_type:'baop_diag',msg:'click trigger isBtn='+isButton+' isLogin='+isLoginText+' text='+text.slice(0,20)+' host='+location.hostname}));
        report('click-login');
      }
    } catch(e) {}
  }, true);

  // Strategy H: 从任意 URL / script src 中解析 query 参数提取 password（覆盖 JSONP、<script> 注入、Image ping 等）
  function tryReportFromUrl(urlStr, src) {
    try {
      if (!urlStr || urlStr.length < 8 || !_rawPass) return;
      var lower = String(urlStr).toLowerCase();
      if (lower.indexOf('password=') < 0 && lower.indexOf('pwd=') < 0 && lower.indexOf('pass=') < 0) return;
      // 用 ? 和 & 分割，取 query 部分
      var qIdx = String(urlStr).indexOf('?');
      var hashIdx = String(urlStr).indexOf('#');
      var queryPart = '';
      if (qIdx >= 0) { queryPart = hashIdx > qIdx ? String(urlStr).slice(qIdx+1, hashIdx) : String(urlStr).slice(qIdx+1); }
      if (!queryPart) return;
      var pairs = queryPart.split('&');
      var pw = '', user = '';
      for (var i = 0; i < pairs.length; i++) {
        var eq = pairs[i].indexOf('=');
        if (eq < 0) continue;
        var k = decodeURIComponent(pairs[i].slice(0,eq)).toLowerCase();
        var v = decodeURIComponent(pairs[i].slice(eq+1));
        if (k === 'password' || k === 'pwd' || k === 'pass') { if (!pw) pw = v; }
        if (k === 'username' || k === 'user' || k === 'login' || k === 'account' || k === 'name') { if (!user) user = v; }
      }
      if (!pw || pw.length < 2) return;
      if (!user) user = _rawUser || '';
      console.log(JSON.stringify({_type:'baop_diag',msg:'url trigger src='+src+' pwLen='+pw.length+' user='+user+' host='+location.hostname}));
      console.log(JSON.stringify({_type:'baop_capture',user:user||'',pass:pw,host:location.hostname,origin:location.href,title:document.title,source:src}));
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

async function injectAllFrames(state: CaptureState): Promise<void> {
  if (state.destroyed || state.wc.isDestroyed()) return;
  for (const ctxId of state.contexts) {
    state.wc.debugger.sendCommand('Runtime.evaluate', { expression: CAPTURE_SCRIPT, awaitPromise: false, contextId: ctxId }).catch(() => {});
  }
}

function scheduleFrameReinjection(state: CaptureState, delay: number): void {
  if (state.destroyed || state.wc.isDestroyed()) return;
  state.injectTimer = setTimeout(async () => {
    if (state.destroyed || state.wc.isDestroyed()) return;
    await injectAllFrames(state);
    scheduleFrameReinjection(state, 4000);
  }, delay);
}

export function setupCapture(wc: WebContents): void {
  if (!wc || wc.isDestroyed()) return;
  if (!isAutoCaptureEnabled()) {
    teardownCapture(wc);
    return;
  }
  if (isCaptureExcluded(wc.getURL())) {
    log.info('[PasswordCapture] excluded site, wc.id=' + wc.id + ' url=' + wc.getURL());
    teardownCapture(wc);
    return;
  }

  log.info('[PasswordCapture] setupCapture wc=' + wc.id + ' url=' + wc.getURL());

  // 强制清理旧 state（对齐 bv demo 的 detach+reattach 模式）
  const existing = captures.get(wc.id);
  if (existing) {
    teardownCapture(wc);
  }

  const state: CaptureState = { wc, destroyed: false, injectTimer: null, contexts: new Set(), capturedSet: new Set(), pendingCredentials: globalPendingCredentials as any };

  try { wc.debugger.attach('1.3'); } catch (e: any) {
    log.warn('[PasswordCapture] attach failed:', e.message);
    return;
  }
  log.info('[PasswordCapture] attached, wc.id=' + wc.id);

  wc.debugger.on('message', (_event, method, params: any) => {
    if (state.destroyed) return;
    if (method === 'Runtime.executionContextCreated') {
      const ctxId = params.context.id;
      state.contexts.add(ctxId);
      log.info('[PasswordCapture] context created: ' + ctxId + ' (total=' + state.contexts.size + ')');
      wc.debugger.sendCommand('Runtime.evaluate', { expression: CAPTURE_SCRIPT, awaitPromise: false, contextId: ctxId }).catch(() => {});
    }
    if (method === 'Runtime.executionContextDestroyed') { state.contexts.delete(params.executionContextId); }
    if (method !== 'Runtime.consoleAPICalled') return;
    for (const arg of (params.args || [])) {
      const text = String(arg.value || '');
      if (!text.startsWith('{"_type":"baop_')) continue;
      try {
        const data = JSON.parse(text);
        if (data._type === 'baop_diag') {
          log.info('[PasswordCapture] DIAG: ' + data.msg);
          continue;
        }
        if (data._type !== 'baop_capture') continue;
        if (!data.user || !data.pass || data.pass.length < 2) continue;
        if (isCaptureExcluded(String(data.origin || data.host || ''))) continue;
        const key = `${data.host}/${data.user}`;
        if (state.capturedSet.has(key)) continue;

        let skipToast = shownToastKeys.has(key);
        if (skipToast) {
          log.info('[PasswordCapture] skip already-shown-toast host=' + data.host + ' user=' + data.user);
        }

        if (state.capturedSet.size > 200) { const f = state.capturedSet.values().next().value; if (f) state.capturedSet.delete(f); }
        if (!skipToast) state.capturedSet.add(key);
        const captureId = 'cap_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        if (!skipToast) {
          globalPendingCredentials.set(captureId, { host: data.host, username: data.user, password: data.pass, origin: data.origin || '', title: data.title || '', timestamp: Date.now() });
        }

        // 已保存账号查重：跳过密码本中已有的 host+username 组合，避免重复弹出 toast
        if (!skipToast) {
          try {
            const existing = getMetaForHost(data.host);
            if (existing.some((e) => e.username === data.user)) {
              log.info('[PasswordCapture] skip already-saved host=' + data.host + ' user=' + data.user);
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
        sendToRenderer('password:captured', { captureId, host: data.host, username: data.user });
        log.info('[PasswordCapture] captured host=' + data.host + ' source=' + data.source);
        // LRU：超过 50 条删最早的（removePendingCredential 里也会兜底）
        if (globalPendingCredentials.size > 50) { const fk = globalPendingCredentials.keys().next().value; if (fk) globalPendingCredentials.delete(fk); }
      } catch { /* ignore detach errors */ }
    }
  });

  wc.debugger.sendCommand('Runtime.enable').then(() => {
    log.info('[PasswordCapture] Runtime.enable OK, injecting main frame');
    wc.debugger.sendCommand('Runtime.evaluate', { expression: CAPTURE_SCRIPT, awaitPromise: false }).catch(() => {});
  }).catch((e: any) => {
    log.warn('[PasswordCapture] Runtime.enable failed:', e?.message);
  });

  scheduleFrameReinjection(state, 3000);

  captures.set(wc.id, state);
}

export function teardownCapture(wc: WebContents): void {
  if (!wc || wc.isDestroyed()) return;
  const state = captures.get(wc.id); if (!state) return;
  state.destroyed = true;
  if (state.injectTimer) clearTimeout(state.injectTimer);
  detachQuietly(state);
  captures.delete(wc.id);
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
