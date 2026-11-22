import { installNativeAutomationAssistant } from './native-automation-assistant';
// Register before userscript scheduling/Node-global stripping so the native UI owns its root.
if (MODULE_AUTOMATION) installNativeAutomationAssistant();
// BrowserView preload: Ruffle injection and PPAPI compatibility shims.
// Password capture and filling live in the main process CDP modules so that
// cross-origin frames work and plaintext credentials never enter renderer IPC.

import { installPasswordFormObserver } from './password-form-observer';
import { installGitHubImportMapBridge } from './github-import-map';

if (MODULE_JS_PATCH) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ipc = require('electron').ipcRenderer;
    installGitHubImportMapBridge(text => ipc.sendSync('github-module:map', text) === true);
  } catch { /* optional compatibility must not prevent navigation */ }
}

interface RuffleModeConfig {
  enabled: boolean;
  source?: 'bundled' | 'cdn';
  js?: string;
  bundle?: { version: string; bytes: number; sha256: string } | null;
}

interface RuffleRuntimeConfig {
  favorFlash: boolean;
  quality: string;
  forceScale: boolean;
  fontSources: string[];
  defaultFonts: Record<string, string>;
  publicPath?: string;
}

declare global {
  interface Window {
    RufflePlayer?: {
      config: RuffleRuntimeConfig;
      newest?: () => { version?: string } | null;
    };
    __baoflash_preload?: number;
  }
}

(function() {
  if (!MODULE_PASSWORDS) return;
  try {
    // Only a presence signal crosses IPC; credentials stay in the main-process CDP path.
    // allowFill=false 表示这次上报只用于"重新武装捕获"（例如用户点了页面），
    // 主进程不应因此执行自动填充——否则会把用户刚输入/清空的账号密码又填回去。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ipc = require('electron').ipcRenderer;
    if (ipc) installPasswordFormObserver((allowFill) => ipc.send('password:form-detected', { fill: allowFill }));
  } catch { /* page operation must not depend on autofill observation */ }
})();

// --- 页面主世界 Web API polyfills：已移交主进程 -----------------------------
// 原先在这里用 webFrame.executeJavaScript 注入 core-js，自称 document-start。
// 但该 API 的语义是把执行挂起到页面停止加载之后（electron.d.ts），与
// document-start 的定位冲突；实测主世界的 [].at / crypto.randomUUID /
// window.close 全部保持原生，证明这段代码从未落到主世界。
// 现在由 src/main/modules/tabs.ts 在 dom-ready 用 webContents.executeJavaScript
// 注入，负载统一放在 src/shared/web-polyfills.ts。不要再把注入写回 preload。

// --- Ruffle 模式检测与注入（contextIsolation: false 时直接 eval 到页面上下文）---
(function() {
  if (window.top !== window.self) return;
  try {
    // Electron 11 preload runtime requires CommonJS here; static import changes page-world timing.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const _e = require('electron');
    const _ipc = _e.ipcRenderer;
    if (!_ipc) return;
    const _cfg = _ipc.sendSync('get-ruffle-mode') as RuffleModeConfig;
    if (_cfg && _cfg.enabled) {
      // Some legacy-site polyfill bundles add a broken `detached` getter on
      // Chromium 87. It reports false for the old ArrayBuffer after
      // WebAssembly.Memory.grow(), so wasm-bindgen keeps a stale DataView and
      // Ruffle's URL streaming path crashes as soon as a large SWF grows WASM
      // memory. Install the spec-compatible check before page scripts can
      // replace it. This is intentionally Ruffle-only: PPAPI pages do not use
      // wasm-bindgen and should retain the site's native environment.
      try {
        const arrayBufferPrototype = ArrayBuffer.prototype;
        const existing = Object.getOwnPropertyDescriptor(arrayBufferPrototype, 'detached');
        if (!existing || existing.configurable) {
          const byteLengthGetter = Object.getOwnPropertyDescriptor(arrayBufferPrototype, 'byteLength')?.get;
          const slice = arrayBufferPrototype.slice;
          if (byteLengthGetter && typeof slice === 'function') {
            Object.defineProperty(arrayBufferPrototype, 'detached', {
              configurable: false,
              enumerable: false,
              get: function(this: ArrayBuffer): boolean {
                const byteLength = byteLengthGetter.call(this) as number;
                if (byteLength !== 0) return false;
                try {
                  // Chromium 87 incorrectly allows constructing a DataView over
                  // detached WASM memory, but its native slice still rejects it.
                  slice.call(this, 0, 0);
                  return false;
                } catch {
                  return true;
                }
              },
            });
          }
        }
      } catch { /* Ruffle can still fall back to buffer identity checks */ }
      const _report = (phase: string, detail?: string) => {
        try { _ipc.send('ruffle:diagnostic', { phase, detail }); } catch { /* diagnostics must not affect bootstrap */ }
      };
      const _reportRuntime = () => {
        try {
          const runtime = window.RufflePlayer?.newest?.();
          if (runtime) _report('runtime-ready', runtime.version || 'unknown version');
          else _report('runtime-error', 'Ruffle source was not registered');
        } catch (error) {
          _report('runtime-error', error instanceof Error ? error.message : String(error));
        }
      };
      const _reportComponentFailure = (reason: unknown) => {
        const detail = reason instanceof Error ? reason.message : String(reason || 'unknown error');
        if (/ruffle|wasm|webassembly|chunk|component/i.test(detail)) _report('component-error', detail);
      };
      window.addEventListener('error', (event) => _reportComponentFailure(event.error || event.message));
      window.addEventListener('unhandledrejection', (event) => _reportComponentFailure(event.reason));
      const bundleDetail = _cfg.bundle
        ? ', version=' + _cfg.bundle.version + ', bytes=' + _cfg.bundle.bytes + ', sha256=' + _cfg.bundle.sha256
        : ', bytes=' + (_cfg.js?.length || 0);
      _report('config', 'source=' + (_cfg.source || 'bundled') + bundleDetail);
      const _config: RuffleRuntimeConfig = {
        favorFlash: false,
        quality: 'best',
        forceScale: true,
        fontSources: ['ruffle-resource://ruffle/SourceHanSansCN-Regular.otf'],
        defaultFonts: {
          '_sans': 'Source Han Sans CN',
          '_serif': 'Source Han Sans CN',
          '_typewriter': 'Source Han Sans CN',
          '宋体': 'Source Han Sans CN',
          '黑体': 'Source Han Sans CN',
          '微软雅黑': 'Source Han Sans CN',
          'SimSun': 'Source Han Sans CN',
          'SimHei': 'Source Han Sans CN',
        },
      };
      // publicPath 必须带 authority 段：Ruffle ≥0.8 用
      // `new URL('./core.wasm', publicPath)` 找 WASM 组件，而 Chromium 87 拒绝
      // 把相对引用解析到空 authority 的非标准 URL（会抛 Invalid URL）。详见
      // src/main/modules/ruffle-session-protocol.ts。
      if (_cfg.js) _config.publicPath = 'ruffle-resource://ruffle/';
      window.RufflePlayer = { config: _config };
      if (_cfg.js) {
        try {
          // new Function avoids esbuild's `direct-eval` warning while behaving
          // identically here: Ruffle's runtime is a self-executing UMD that
          // attaches to the global (window.RufflePlayer), so it runs in the
          // global scope chain and never needs access to this preload's lexical
          // closure. (eval would see closure vars; new Function does not — the
          // runtime relies only on globals.)
          new Function(_cfg.js)();
          _report('bundled-eval-ok');
          _reportRuntime();
          console.log('[PRELOAD] Ruffle eval\'d (' + (_cfg.js.length / 1024).toFixed(0) + 'KB)');
        } catch (error) {
          _report('bundled-eval-error', error instanceof Error ? error.message : String(error));
          throw error;
        }
      } else {
        // Deliberately UNPINNED (`@latest`), not an oversight. The bundled runtime
        // is the normal path; this CDN fallback only runs when no bundled copy is
        // available. Pinning would freeze the fallback at a version that may be
        // long obsolete — or gone — if this project ever stops being maintained,
        // while the live package keeps being fixed. The trade-off (a mutable
        // third-party URL supplying code to a legacy site) is accepted so a user
        // can still run Flash content after the project's own releases stop.
        // Do not "fix" this into a pinned version without revisiting that balance.
        const _doCdn = () => {
          const parent = document.head || document.documentElement;
          if (parent) {
            const s = document.createElement('script');
            s.src = 'https://unpkg.com/@ruffle-rs/ruffle@latest/ruffle.js';
            s.onload = () => { _report('cdn-loaded'); _reportRuntime(); console.log('[PRELOAD] Ruffle CDN loaded'); };
            s.onerror = () => { _report('cdn-error', s.src); console.error('[PRELOAD] Ruffle CDN failed'); };
            parent.appendChild(s);
            _report('cdn-loading', s.src);
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
// --- PPAPI mode: fake plugin detection compatibility ---
window.__baoflash_preload = 1;
try { document.body.setAttribute('data-preload', '1'); } catch { /* body not ready */ }
console.log('[PRELOAD] webview-preload running');

// --- Userscript runtime bootstrap (main frames and subframes) ---
// Registered after the Ruffle/PPAPI shims; a failure must never break the page.
(function () {
  if (!MODULE_USERSCRIPTS) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { initUserscriptRuntime } = require('./userscripts/bootstrap');
    initUserscriptRuntime();
  } catch { /* userscript runtime must never break the page */ }
})();
