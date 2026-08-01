# BaoFlashBrowser — Agent Instructions

## Build & Run

```bash
npm start          # i18n generate → esbuild main + Vite renderer → electron
npm run build      # esbuild main + Vite renderer only (no i18n)
npm run dev        # concurrently watch esbuild main + Vite renderer (no auto-restart)
npm run i18n       # typesafe-i18n one-shot codegen (run before build if strings changed)
npm run lint       # eslint src/ --ext .ts,.tsx
```

## Architecture

- **Electron 11.5.0 / Chromium 87** — locked. Last version with native PPAPI Flash. Never upgrade.
- **BrowserView** for tab content (not BrowserWindow, not `<webview>`). Each tab = independent render process.
- **PPAPI tab**: `contextIsolation: true, plugins: true`
- **Ruffle tab**: `contextIsolation: false, plugins: false` (Ruffle must run in page context, loaded via `ipcRenderer.sendSync` + `eval()`)
- **Session**: tabs use `partition: 'persist:'` — a *different* session from `defaultSession`. WebRequest interceptors must be registered on both.
- **esbuild** bundles main (platform: node, CJS). **Vite** bundles renderer.

## Key files

| Path | Role |
|------|------|
| `src/main/index.ts` | Main process entry |
| `src/main/modules/tabs.ts` | BrowserView lifecycle (TabManager) |
| `src/main/modules/flash.ts` | PPAPI plugin loading + `mms.cfg` |
| `src/main/modules/session-manager.ts` | Session init: UA, SWFObject redirect, CORS headers (configured per-partition via `setupSessionOnce`) |
| `src/main/modules/password-capture.ts` | CDP-based password capture (CAPTURE_SCRIPT is a large inline string) |
| `src/renderer/App.tsx` | React root (wrapped in `TypesafeI18n` Provider) |
| `src/renderer/i18n/` | typesafe-i18n generated code + `zh-CN`/`en` translation dictionaries (baseLocale: `zh-CN`) |
| `src/renderer/store/` | Zustand stores: `useDataStore.ts` (settings/history/favorites/downloads), `useTabsStore.ts` |
| `src/preload/index.ts` | Main window preload (contextBridge) |
| `src/webview-preload/index.ts` | **BrowserView** preload (Ruffle injection, separate from above) |
| `src/renderer/services/db.ts` | Dexie/IndexedDB data layer |
| `test/` | Standalone demos (bv-capture-test, cdp-capture-test, etc.) |

## Debugging workflow

1. **Think first** — map the full chain before touching code
2. **Write a demo** matching the main project environment (e.g. BrowserView, not BrowserWindow)
3. **Demo passes → port to main project**
4. **Site-specific failures** — probe with Python/Node.js + Playwright to see actual network requests and DOM behavior. Reference: `test/7k7k-probe.py`

## Landmines

- **CDP `debugger.attach` blocks `<script>` `onload`** in BrowserView — JSONP logins (like 7k7k) freeze if debugger stays attached post-capture. Detach on non-`beforeunload` sources.
- **Navigation with attached debugger freezes tabs** — `did-stop-loading` calls `setupCapture`, leaving the debugger attached. The next `wc.reload()` / `wc.loadURL()` then gets blocked by the attached debugger, so `did-stop-loading` never fires and the tab is stuck `isLoading: true`. Fix: `teardownCapture(wc)` *before* calling any navigation API in `tabs.ts` (`reload`/`navigate`/`goBack`/`goForward`). `did-stop-loading` will re-attach automatically. Switching the Flash engine worked around this because `setRuffleMode` destroys the view and runs `teardownCapture`.
- **Cross-origin iframes** cannot be reached with `executeJavaScript`. Must use CDP `Runtime.evaluate` with `contextId`.
- **Login submission methods vary wildly**: 4399 = `<form>` submit, 7k7k = `<script>` JSONP injection. Probe before coding.
- **Taomee 61.com**: uses modded SWFObject that blocks Flash 32. Fix: network-level redirect of `swfobject.js` (see `session-manager.ts`).
- **PPAPI version differs by platform**: Win `29.0.0.171`, Linux `32.0.0.371`. DLL filename must contain version number or `extractVersion` returns `0.0.0.0` → sites detects wrong version.
- **Linux requires `--no-sandbox`**. WSLg requires all three GPU flags: `--ignore-gpu-blacklist`, `--enable-gpu-rasterization`, `--enable-zero-copy`.
- **`did-fail-load` handler**: never call `wc.stop()` — it kills post-login redirects.
- **Never attempt to override or upgrade Electron version.** Everything depends on Chromium 87.
