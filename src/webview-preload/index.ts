// webview 注入脚本（guest 页面内运行）
// 职责：1) Ruffle 注入 (contextIsolation:false → eval 到页面上下文)
//       2) 识别登录表单/捕获账号密码/自动填充
// 通信：guest→host 用 ipcRenderer.sendToHost；host→guest 用 webview.send → ipcRenderer.on

declare function require(name: 'electron'): { ipcRenderer: Electron.IpcRenderer };

interface RuffleModeConfig {
  enabled: boolean;
  source?: 'bundled' | 'cdn';
  js?: string;
}

interface LoginFormData {
  form: HTMLFormElement | null;
  userInput: HTMLInputElement | null;
  pwInput: HTMLInputElement;
}

interface Credentials {
  username: string;
  password: string;
  formAction: string;
}

// --- Ruffle 模式检测与注入（contextIsolation: false 时直接 eval 到页面上下文）---
(function() {
  if (window.top !== window.self) return;
  try {
    const _e = require('electron');
    const _ipc = _e.ipcRenderer;
    if (!_ipc) return;
    const _cfg = _ipc.sendSync('get-ruffle-mode') as RuffleModeConfig;
    if (_cfg && _cfg.enabled) {
      const _config = {
        favorFlash: false,
        quality: 'best',
        forceScale: true,
        fontSources: ['ruffle-resource://simhei.ttf'],
        defaultFonts: {
          '_sans': 'SimHei',
          '_serif': 'SimHei',
          '_typewriter': 'SimHei',
          '宋体': 'SimHei',
          '黑体': 'SimHei',
          '微软雅黑': 'SimHei',
          'SimSun': 'SimHei',
          'SimHei': 'SimHei',
        },
      };
      if (_cfg.js) _config.publicPath = 'ruffle-resource://';
      window.RufflePlayer = { config: _config };
      if (_cfg.js) {
        eval(_cfg.js);
        console.log('[PRELOAD] Ruffle eval\'d (' + (_cfg.js.length / 1024).toFixed(0) + 'KB)');
      } else {
        const _doCdn = () => {
          const parent = document.head || document.documentElement;
          if (parent) {
            const s = document.createElement('script');
            s.src = 'https://unpkg.com/@ruffle-rs/ruffle@latest/ruffle.js';
            s.onload = () => { console.log('[PRELOAD] Ruffle CDN loaded'); };
            s.onerror = () => { console.error('[PRELOAD] Ruffle CDN failed'); };
            parent.appendChild(s);
            console.log('[PRELOAD] Ruffle CDN loading...');
          } else {
            requestAnimationFrame(_doCdn);
          }
        };
        _doCdn();
      }
      return; // Ruffle mode: skip PPAPI fake plugin injection + login capture below
    }
  } catch { /* Ruffle mode disabled or failed, fall through to PPAPI */ }
})();

// --- PPAPI 模式：existing fake plugin injection + login capture ---
let preloadLog = (_msg: string) => {};
window.__baoflash_preload = 1;
try { document.body.setAttribute('data-preload', '1'); } catch { /* body not ready */ }
console.log('[PRELOAD] webview-preload running');

// --- Flash PPAPI plugin 检测注入（Linux PPAPI 不注册 navigator.plugins） ---
(function() {
  try {
    // Skip if Flash already properly registered (Windows/PPAPI native)
    const existing = navigator.plugins.namedItem('Shockwave Flash');
    if (existing && /\.dll$|\.plugin$/i.test(existing.filename)) {
      return;
    }
    const fakeFlashPlugin: any = {
      name: 'Shockwave Flash',
      filename: 'pepflashplayer64.dll',
      description: 'Shockwave Flash 34.0 r0',
      length: 2,
      item: (i: number) => {
        if (i === 0) return fakeFlashMime;
        return null;
      },
      namedItem: (name: string) => {
        if (name === 'Shockwave Flash') return fakeFlashPlugin;
        return null;
      },
      0: { type: 'application/x-shockwave-flash', suffixes: 'swf', description: 'Shockwave Flash' },
      1: { type: 'application/futuresplash', suffixes: 'spl', description: 'FutureSplash Player' }
    };
    const fakeFlashMime: any = {
      type: 'application/x-shockwave-flash',
      suffixes: 'swf',
      description: 'Shockwave Flash',
      enabledPlugin: fakeFlashPlugin
    };

    const origPlugins = navigator.plugins;
    const origMimeTypes = navigator.mimeTypes;
    const pluginsList: any[] = [];
    for (let i = 0; i < origPlugins.length; i++) {
      pluginsList.push(origPlugins[i]);
    }
    pluginsList.unshift(fakeFlashPlugin);

    const fakePlugins: any = {
      length: pluginsList.length,
      item: (i: number) => pluginsList[i] || null,
      namedItem: (name: string) => {
        if (name === 'Shockwave Flash' || name === 'Shockwave Flash 32.0 r0') return fakeFlashPlugin;
        for (let j = 0; j < pluginsList.length; j++) {
          if (pluginsList[j].name === name) return pluginsList[j];
        }
        return null;
      },
      refresh: () => {}
    };
    for (let k = 0; k < pluginsList.length; k++) {
      fakePlugins[k] = pluginsList[k];
    }
    Object.defineProperty(navigator, 'plugins', { value: fakePlugins, configurable: true });

    const fakeMimeTypes: any = {
      length: origMimeTypes.length + 1,
      item: (i: number) => {
        if (i === 0) return fakeFlashMime;
        return origMimeTypes.item(i - 1);
      },
      namedItem: (name: string) => {
        if (name === 'application/x-shockwave-flash') return fakeFlashMime;
        return origMimeTypes.namedItem(name);
      }
    };
    for (let m = 0; m < fakeMimeTypes.length; m++) {
      fakeMimeTypes[m] = fakeMimeTypes.item(m);
    }
    Object.defineProperty(navigator, 'mimeTypes', { value: fakeMimeTypes, configurable: true });
  } catch { /* plugin injection failed */ }
})();

let ipcRenderer: Electron.IpcRenderer | null = null;
try {
  const electron = require('electron');
  ipcRenderer = electron.ipcRenderer;
  if (ipcRenderer && ipcRenderer.sendToHost) {
    preloadLog = (msg: string) => { try { ipcRenderer!.sendToHost('preload-log', msg); } catch { /* ipc closed */ } };
    preloadLog('loaded:' + location.href);
  }
} catch { /* preloadLog stays as no-op */ }

// 仅主框架生效，避免嵌套 iframe 重复触发
if (window.top === window.self && ipcRenderer) {
try {
  preloadLog('topframe:' + location.href);

  // --- 登录表单识别 ---
  function findLoginInputs(): LoginFormData | null {
    const pwInputs = document.querySelectorAll<HTMLInputElement>('input[type=password]');
    if (!pwInputs.length) return null;
    const pwInput = pwInputs[pwInputs.length - 1];
    let form: HTMLFormElement | null = null;
    if (pwInput.form) {
      form = pwInput.form;
    } else if (pwInput.closest) {
      form = pwInput.closest('form');
    }
    // 用户名输入框：同 form 内优先 email / name 含 user|login|email|account 的 text 输入
    let userInput: HTMLInputElement | null = null;
    const scope: ParentNode = form || document;
    const candidates = scope.querySelectorAll<HTMLInputElement>('input[type=email], input[type=text], input[type=tel]');
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      const nm = (el.name || '') + ' ' + (el.id || '') + ' ' + (el.placeholder || '');
      if (/user|login|email|account|name|acct/i.test(nm)) { userInput = el; break; }
    }
    if (!userInput && candidates.length) userInput = candidates[0];
    return { form: form, userInput: userInput, pwInput: pwInput };
  }

  function readCredentials(): Credentials | null {
    const lf = findLoginInputs();
    if (!lf || !lf.pwInput) return null;
    const username = lf.userInput ? (lf.userInput.value || '') : '';
    const password = lf.pwInput.value || '';
    if (!password) return null;
    return {
      username: username,
      password: password,
      formAction: lf.form ? (lf.form.action || '') : ''
    };
  }

  function reportCapture() {
    if (!ipcRenderer) return;
    try {
      const creds = readCredentials();
      if (!creds) return;
      ipcRenderer.sendToHost('login-submitted', {
        url: location.href,
        username: creds.username,
        password: creds.password,
        formAction: creds.formAction
      });
    } catch (err) {
      ipcRenderer.sendToHost('preload-log', 'capture-error: ' + err);
    }
  }

  preloadLog('listeners-attached:' + location.href);

  // 捕获 1：表单 submit（传统表单）
  document.addEventListener('submit', (e: Event) => {
    const t = e.target as HTMLElement | null;
    if (!t || t.tagName !== 'FORM') return;
    if (!t.querySelector('input[type=password]')) return;
    reportCapture();
  }, true);

  // 捕获 2：密码框内回车（覆盖 AJAX 登录）
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    const lf = findLoginInputs();
    if (!lf || !lf.pwInput) return;
    const active = document.activeElement;
    if (!active) return;
    if (lf.form && !lf.form.contains(active)) return;
    // 延迟到表单处理之后再捕获，确保 value 已就位
    setTimeout(reportCapture, 0);
  }, true);

  // --- 自动填充 ---
  function setInputValue(el: HTMLInputElement | null, val: string) {
    if (!el) return;
    try {
      // 直接设置 value（DOM 跨隔离世界共享）
      el.focus();
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    } catch (err) {
      if (ipcRenderer) ipcRenderer.sendToHost('preload-log', 'fill-set-error: ' + err);
    }
  }

  ipcRenderer.on('fill-credentials', (_event, data: { username?: string; password?: string }) => {
    try {
      const lf = findLoginInputs();
      if (!lf) {
        ipcRenderer!.sendToHost('fill-result', { ok: false, reason: 'no-form' });
        return;
      }
      if (data && data.username && lf.userInput) {
        setInputValue(lf.userInput, data.username);
      }
      if (data && data.password && lf.pwInput) {
        setInputValue(lf.pwInput, data.password);
      }
      ipcRenderer!.sendToHost('fill-result', { ok: true });
    } catch (err) {
      ipcRenderer!.sendToHost('fill-result', { ok: false, reason: String(err) });
    }
  });

  // host 询问当前页面是否有可填充的登录表单
  ipcRenderer.on('query-login-form', () => {
    const lf = findLoginInputs();
    ipcRenderer!.sendToHost('login-form-found', {
      url: location.href,
      hasForm: !!lf
    });
  });

  // DOM 就绪后回报一次（便于 host 决定是否填充）
  const notifyReady = () => {
    try {
      const lf = findLoginInputs();
      ipcRenderer!.sendToHost('login-form-found', {
        url: location.href,
        hasForm: !!lf
      });
    } catch { /* ipc closed */ }
  };

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(notifyReady, 100);
  } else {
    document.addEventListener('DOMContentLoaded', () => { setTimeout(notifyReady, 100); });
  }

  // --- Ctrl+滚轮缩放 ---
  // 缩放由 host 通过 executeJavaScript 注入，不在此处理（避免 file:// 页面 preload 限制）

} catch { /* silently fail */ }
}
