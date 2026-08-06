// BrowserView preload: Ruffle injection and PPAPI compatibility shims.
// Password capture and filling live in the main process CDP modules so that
// cross-origin frames work and plaintext credentials never enter renderer IPC.

import { installPasswordFormObserver } from './password-form-observer';
import coreApiPolyfills from './web-api-polyfills.generated';

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
  try {
    // Only a presence signal crosses IPC; credentials stay in the main-process CDP path.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ipc = require('electron').ipcRenderer;
    if (ipc) installPasswordFormObserver(() => ipc.send('password:form-detected'));
  } catch { /* page operation must not depend on autofill observation */ }
})();

// --- 页面主世界 Web API polyfills (document-start) -------------------------
// Chromium 87 lacks APIs modern sites require; a missing API crashes their
// whole JS bundle (GitHub: `crypto.randomUUID` / `.at()` → React never
// mounts). Injected into the PAGE main world via webFrame.executeJavaScript
// (same proven mechanism as the userscript page-world bridge). core-js covers
// the ECMAScript additions; hand-written bits cover Web APIs core-js does not
// ship (crypto.randomUUID). Kept as the FIRST webFrame call, combined into a
// single string so the polyfills land before page scripts as often as
// possible; a verification pass retries a few times for late async scripts.
const HANDMADE_POLYFILLS = `(function () {
  try {
    if (window.crypto && !window.crypto.randomUUID) {
      window.crypto.randomUUID = function () {
        var b = window.crypto.getRandomValues(new Uint8Array(16));
        b[6] = (b[6] & 0x0f) | 0x40;
        b[8] = (b[8] & 0x3f) | 0x80;
        var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); });
        return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' + h.slice(6, 8).join('') + '-' + h.slice(8, 10).join('') + '-' + h.slice(10).join('');
      };
    }
  } catch (e) { /* polyfill must never break the page */ }
})();
`;
// window.close() guard: Electron 11 routes a BrowserView page's window.close()
// to the HOST BrowserWindow (verified: page window.close() closes the browser).
// Tab content must never be able to close the browser window.
const PAGE_WORLD_CLOSE_GUARD = `(function () {
  try {
    if (window && typeof window.close === 'function') {
      window.close = function () { /* tabs must not close the browser window */ };
    }
  } catch (e) { /* guard must never break the page */ }
})();
`;
// Diagnostic switch (temporary): BAO_POLYFILL_MODE=handmade|off downgrades the
// 100KB+ core-js payload — Chromium 87 has a known native main-process crash
// when executing very large document-start scripts via executeJavaScript.
const polyfillMode = process.env.BAO_POLYFILL_MODE || 'full';
const PAGE_WORLD_POLYFILLS = polyfillMode === 'full' ? HANDMADE_POLYFILLS + coreApiPolyfills : HANDMADE_POLYFILLS;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const webFrame = require('electron').webFrame;
  if (webFrame && typeof webFrame.executeJavaScript === 'function') {
    // The close guard runs unconditionally (small payload, independent of the
    // polyfill mode switch).
    webFrame.executeJavaScript(PAGE_WORLD_CLOSE_GUARD, true).catch(() => {});
    if (polyfillMode !== 'off') {
      const inject = (attempt: number): void => {
        webFrame.executeJavaScript(PAGE_WORLD_POLYFILLS, true).catch(() => {});
      };
      inject(0);
      // Verify in the page world; retry a few times (the 100KB+ payload can
      // lose a race against the HTML parser — late async scripts still benefit).
      const verify = (attempt: number): void => {
        webFrame.executeJavaScript('typeof [].at === "function"', true)
          .then((ok: unknown) => {
            if (!ok && attempt < 4) {
              setTimeout(() => {
                inject(attempt + 1);
                verify(attempt + 1);
              }, 150 * (attempt + 1));
            }
          })
          .catch(() => {});
      };
      verify(0);
    }
  }
} catch { /* page operation must not depend on polyfills */ }

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
        fontSources: ['ruffle-resource://SourceHanSansCN-Regular.otf'],
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
      if (_cfg.js) _config.publicPath = 'ruffle-resource://';
      window.RufflePlayer = { config: _config };
      if (_cfg.js) {
        try {
          eval(_cfg.js);
          _report('bundled-eval-ok');
          _reportRuntime();
          console.log('[PRELOAD] Ruffle eval\'d (' + (_cfg.js.length / 1024).toFixed(0) + 'KB)');
        } catch (error) {
          _report('bundled-eval-error', error instanceof Error ? error.message : String(error));
          throw error;
        }
      } else {
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
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { initUserscriptRuntime } = require('./userscripts/bootstrap');
    initUserscriptRuntime();
  } catch { /* userscript runtime must never break the page */ }
})();
