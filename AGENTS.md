# BaoFlashBrowser — Agent Instructions

## Build & Run

```bash
npm start          # i18n generate → esbuild main + Vite renderer → electron
npm run build      # build:css-fixer (bundled userscripts) + esbuild main + Vite renderer (no i18n)
npm run dev        # concurrently watch esbuild main + Vite renderer (no auto-restart)
npm run i18n       # typesafe-i18n one-shot codegen (run before build if strings changed)
npm run lint       # eslint src/ --ext .ts,.tsx
npm run typecheck  # main + renderer + preload TypeScript checks
npm test -- --run  # Vitest suite
npm run test:compat   # session policy/SWFObject/CORS Electron smoke (builds its own release/ bundle)
npm run test:electron # BrowserView lifecycle smoke
npm run test:ruffle   # bundled Ruffle protocol smoke
npm run test:userscripts      # runtime smoke (builds release/tests preload first)
npm run test:userscripts-admin# admin E2E smoke (builds release/tests module first)
npm run test:css-fixer        # built-in CSS fixer smoke (fixture page, both injection paths)
npm run probe       # tools/probe quick health probes (pure Node, seconds)
npm run probe:deep  # tools/probe Electron probes (manager + BrowserView runtime health)
npm run check      # i18n + typecheck + lint + tests + production build
```

**IMPORTANT — `npm run build` does NOT rebuild `release/tests/` products.** Smoke bundles
(`release/tests/userscripts-admin-module.cjs`, `userscript-runtime-preload.cjs`,
`session-compatibility-smoke.cjs`) are built only by their own `tests/electron/build-*.mjs`.
After editing userscript sources, run the matching build script first or smokes test STALE
code (reproduced: command-dedupe fix "not working" because the admin module was old).

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
| `src/main/modules/password-fill.ts` | Password autofill across the main frame and CDP execution contexts |
| `src/main/modules/password-store.ts` | Encrypted vault plus device-local autofill key wrapping |
| `src/main/modules/userscripts/` | Userscript runtime services: manager/parser/matcher/values/store/require-cache/request/download + singleton wiring |
| `src/main/ipc/userscripts.ipc.ts` | Userscript IPC channels (zod-validated; `get-config` is sendSync, response bounded by snapshot budgets) |
| `src/webview-preload/userscripts/` | Preload runtime: bootstrap/scheduler/sandbox/gm-api/page-bridge/unsafe-proxy |
| `src/shared/userscript-types.ts` | Shared userscript types (main + preload) |
| `src/main/modules/session-recovery.ts` | Clean/abnormal shutdown tracking |
| `src/renderer/App.tsx` | React root (wrapped in `TypesafeI18n` Provider) |
| `src/renderer/i18n/` | typesafe-i18n generated code + `zh-CN`/`en` translation dictionaries (baseLocale: `zh-CN`) |
| `src/renderer/store/` | Zustand stores: `useDataStore.ts` (settings/history/favorites/downloads), `useTabsStore.ts` |
| `src/preload/index.ts` | Main window preload (contextBridge) |
| `src/webview-preload/index.ts` | **BrowserView** preload (Ruffle injection, separate from above) |
| `src/renderer/services/db.ts` | Dexie/IndexedDB data layer |
| `src/renderer/services/toast.ts` | Address-bar toast queue, timing, priority and dismissal rules |
| `tools/probe/` | Probe toolkit: hosts (`host.cjs` pure-Node, `host-electron.cjs`), `lib/timeout.cjs` (waitFor/withTimeout/watchdog, `SMOKE_TIMEOUT` env), probe protocol `{ id, name, needsElectron, timeoutMs, run(ctx) }`; new probes = copy `probes/_template.cjs`. Probing is read-only and NEVER clears logs. |
| `tests/` | Vitest tests and Electron smoke tests |

## Debugging workflow

1. **Think first** — map the full chain before touching code
2. **Probe before guessing** — `npm run probe` (build freshness, scripts, config, git, log tail) and `npm run probe:deep` (manager + BrowserView runtime). `00-build` tells you if a smoke will test STALE bundles.
3. **Write a demo** matching the main project environment (e.g. BrowserView + PPAPI + the same session hooks, not BrowserWindow)
4. **Demo passes → port to main project**
5. **Site-specific failures** — compare a minimal control probe with a probe that adds project policies one at a time. Record network failures, SWF requests and screenshots without logging tokens/query strings.

## Landmines

- **CDP `debugger.attach` blocks `<script>` `onload`** in BrowserView — JSONP logins (like 7k7k) freeze if debugger stays attached post-capture. Detach on non-`beforeunload` sources.
- **Navigation with attached debugger freezes tabs** — `did-stop-loading` calls `setupCapture`, leaving the debugger attached. The next `wc.reload()` / `wc.loadURL()` then gets blocked by the attached debugger, so `did-stop-loading` never fires and the tab is stuck `isLoading: true`. Fix: `teardownCapture(wc)` *before* calling any navigation API in `tabs.ts` (`reload`/`navigate`/`goBack`/`goForward`). `did-stop-loading` will re-attach automatically. Switching the Flash engine worked around this because `setRuffleMode` destroys the view and runs `teardownCapture`.
- **Cross-origin iframes** cannot be reached with `executeJavaScript`. Must use CDP `Runtime.evaluate` with `contextId`.
- **Login submission methods vary wildly**: 4399 = `<form>` submit, 7k7k = `<script>` JSONP injection. Probe before coding.
- **Taomee 61.com**: uses modded SWFObject that blocks Flash 32. Fix: network-level redirect of `swfobject.js` (see `session-manager.ts`).
- **Never redirect `crossdomain.xml` to `data:`**. PPAPI reports the redirected policy request as `net::ERR_ABORTED`; AS3 games can render their launcher and then turn white when login switches to remote game services. Let every origin serve its native Flash policy. The permissive response headers in `session-manager.ts` apply only to `.swf` requests for Ruffle and are not a substitute for PPAPI policy files.
- **PPAPI version differs by platform**: Win `29.0.0.171`, Linux `32.0.0.371`. DLL filename must contain version number or `extractVersion` returns `0.0.0.0` → sites detects wrong version.
- **Advertised and physical Flash versions are intentionally different on Windows**: the stable bundled DLL is 29.0.0.171 while the default advertised version is 34.0.0.330 for legacy site gates. Do not remove spoofing merely because the physical DLL is older.
- **Password capture payloads use CDP `Runtime.addBinding`**. Never send credentials through `console.log`, renderer IPC, or diagnostics. Dynamic form observation may send only a presence signal (`password:form-detected`).
- **BrowserView events must pass the current-WebContents guard** before updating a tab. Engine switches destroy and replace the view while late events from the old renderer may still arrive.
- **Inactive-tab suspension is opt-in**. Never suspend the active, loading, audible, or React new-tab page; recreation must restore engine, zoom and mute state.
- **Linux requires `--no-sandbox`**. WSLg requires all three GPU flags: `--ignore-gpu-blacklist`, `--enable-gpu-rasterization`, `--enable-zero-copy`.
- **`did-fail-load` handler**: never call `wc.stop()` — it kills post-login redirects.
- **A preload `sendSync` to a channel with no registered handler accumulates renderer IPC corruption** — the renderer hangs on a later navigation (reproduced: 3rd consecutive `loadURL` hangs with `JS_HUNG`, CDP unreachable). Every channel the preload queries at document start (`get-ruffle-mode`, `userscript:get-config`) MUST have a registered handler before any view navigates.
- **Userscript page-world bridge injection goes through preload `webFrame.executeJavaScript` (main world)** — CDP `Page.addScriptToEvaluateOnNewDocument` does NOT work: registrations are removed when the debugger detaches, and an attached debugger freezes navigation.
- **SPA soft navigation never creates a document** — scripts must not re-run; URL changes are recorded via `did-navigate-in-page` → `manager.spaNavigate` (do not patch `history` in the preload).
- **`webContents.send` reaches only the MAIN-frame preload** — `GM_registerMenuCommand` registrations from sub-frames can never be invoked (the main-frame preload drops them by `documentId` mismatch), so the sidebar would list dead duplicate commands. Fix: dedupe commands per script+title in the manager and keep only the main-frame entry (preload sends `isMainFrame` with the registration).
- **No-arg IPC channels must be validated with `z.object({}).optional()`** — a bare `z.object({})` rejects `undefined` payloads, so channels like `userscripts:list` / `userscripts:install-file` (called with no arguments) fail validation.
- **Bundled userscripts are embedded as TEXT at build time** — edit `bundled-scripts/css-fixer-entry.ts` then run `npm run build:css-fixer` to regenerate `css-fixer.user.js` (checked in), or the main bundle and `test:css-fixer`/admin smokes test STALE code. The snapshot source budget is 512KB/page (`maxSourceBytesPerPage`), not the 64KB value budget. Chromium 87 `link.disabled = true → false` does not reliably reload a stylesheet — always replace the `<link>` with a rewritten/verbatim `<style>`. CSS rules dropped by unsupported pseudo-classes never exist in the CSSOM; rewriting must happen at the CSS text layer.
- **Standalone Electron smoke scripts must mock every preload channel and pin userData** — `tests/electron/*.cjs` do NOT load `userscripts.ipc.ts`, so the preload's `get-config`/`report`/`menu-register` sends are silently dropped unless the script registers its own `ipcMain.on` handlers. They must also `app.setPath('userData', .../bao-flash-browser)`, else electron-store reads `%APPDATA%\Electron` (reproduced: script "installed" in the wrong store).
- **Sub-frame script execution works in BOTH modes** — verified by `tests/electron/ruffle-iframe-smoke.cjs` (Ruffle/contextIsolation:false). If a Ruffle game shows no iframe badge, the game is inline in the main document (Ruffle replaces `<embed>/<object>` in-place), not a missing preload.
- **Never attempt to override or upgrade Electron version.** Everything depends on Chromium 87.
