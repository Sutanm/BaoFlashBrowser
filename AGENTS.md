# BaoFlashBrowser — Agent Instructions

## Build & Run

```bash
npm start          # build (webpack main+renderer) → electron
npm run build      # webpack both targets only
npm run dev        # concurrently watch both targets (no auto-restart)
npm run lint       # eslint src/ --ext .ts,.tsx
```

## Architecture

- **Electron 11.5.0 / Chromium 87** — locked. Last version with native PPAPI Flash. Never upgrade.
- **BrowserView** for tab content (not BrowserWindow, not `<webview>`). Each tab = independent render process.
- **PPAPI tab**: `contextIsolation: true, plugins: true`
- **Ruffle tab**: `contextIsolation: false, plugins: false` (Ruffle must run in page context, loaded via `ipcRenderer.sendSync` + `eval()`)
- **Session**: tabs use `partition: 'persist:'` — a *different* session from `defaultSession`. WebRequest interceptors must be registered on both.
- **Webpack** bundles main (target: electron-main) and renderer (target: web). No Vite.

## Key files

| Path | Role |
|------|------|
| `src/main/index.ts` | Main process entry |
| `src/main/modules/tabs.ts` | BrowserView lifecycle (TabManager) |
| `src/main/modules/flash.ts` | PPAPI plugin loading + `mms.cfg` |
| `src/main/modules/session.ts` | Session init: UA, SWFObject redirect, CORS headers |
| `src/main/modules/password-capture.ts` | CDP-based password capture (CAPTURE_SCRIPT is a large inline string) |
| `src/renderer/App.tsx` | React root |
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
- **Cross-origin iframes** cannot be reached with `executeJavaScript`. Must use CDP `Runtime.evaluate` with `contextId`.
- **Login submission methods vary wildly**: 4399 = `<form>` submit, 7k7k = `<script>` JSONP injection. Probe before coding.
- **Taomee 61.com**: uses modded SWFObject that blocks Flash 32. Fix: network-level redirect of `swfobject.js` (see `session.ts`).
- **PPAPI version differs by platform**: Win `29.0.0.171`, Linux `32.0.0.371`. DLL filename must contain version number or `extractVersion` returns `0.0.0.0` → sites detects wrong version.
- **Linux requires `--no-sandbox`**. WSLg requires all three GPU flags: `--ignore-gpu-blacklist`, `--enable-gpu-rasterization`, `--enable-zero-copy`.
- **`did-fail-load` handler**: never call `wc.stop()` — it kills post-login redirects.
- **Never attempt to override or upgrade Electron version.** Everything depends on Chromium 87.
