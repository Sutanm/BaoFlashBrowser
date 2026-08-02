// BrowserView preload: Ruffle injection and PPAPI compatibility shims.
// Password capture and filling live in the main process CDP modules so that
// cross-origin frames work and plaintext credentials never enter renderer IPC.

import { installPasswordFormObserver } from './password-form-observer';

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
