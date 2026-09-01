# BaoFlashBrowser — Agent Instructions

## Build & Run

```bash
npm start          # i18n generate → esbuild main + Vite renderer → electron
npm run build      # build:css-fixer (bundled userscripts) + esbuild main + Vite renderer (no i18n)
npm run dev        # concurrently watch esbuild main + Vite renderer (no auto-restart)
npm run i18n       # typesafe-i18n one-shot codegen (run before build if strings changed)
npm run lint       # eslint src/ --ext .ts,.tsx
npm run typecheck  # main + renderer + preload TypeScript checks
npm test -- --run  # Vitest unit layer only (fast; heavy OpenCV/OCR excluded)
npm run test:integration  # heavy layer: OpenCV vision-worker + PaddleOCR sidecars
npm run test:all   # full Vitest (unit + integration)
npm run test:coverage  # unit layer with v8 coverage report
npm run test:e2e   # Playwright shell e2e (drives project Electron 11; needs dist build)
npm run test:compat   # session policy/SWFObject/CORS Electron smoke (builds its own release/ bundle)
npm run test:electron # BrowserView lifecycle smoke
npm run test:ruffle   # bundled Ruffle protocol smoke
npm run test:userscripts      # runtime smoke (builds release/tests preload first)
npm run test:userscripts-admin# admin E2E smoke (builds release/tests module first)
npm run test:css-fixer        # built-in CSS fixer smoke (fixture page, both injection paths)
npm run probe       # tools/probe quick health probes (pure Node, seconds)
npm run probe:deep  # tools/probe Electron probes (manager + BrowserView runtime health)
npm run check      # i18n + typecheck + lint + unit tests + production build (CI runs test:integration separately)
```

**NOTE — `npm test` only runs the `unit` Vitest project.** Heavy suites
(`automation-vision-worker`, OCR sidecars) live in the `integration` project:
`npm run test:integration` or `npm run test:all`. Coverage: `npm run test:coverage`.
Playwright e2e asserts the React shell UI only (Electron 11 BrowserView contents
are not reachable through Playwright DOM APIs).

**IMPORTANT — `npm run build` does NOT rebuild `release/tests/` products.** Smoke bundles
(`release/tests/userscripts-admin-module.cjs`, `userscript-runtime-preload.cjs`,
`session-compatibility-smoke.cjs`) are built only by their own `tests/electron/build-*.mjs`.
After editing userscript sources, run the matching build script first or smokes test STALE code.

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
| `src/main/modules/screenshot.ts` | Screenshot capture (tab capture, sanitize, path guards) |
| `src/main/modules/screenshot-http.ts` | Debug-only HTTP endpoint (AI/automation capture of a RUNNING instance) |
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
| `docs/superpowers/specs/` | Design specs (screenshot design incl. §调试 HTTP 口子) |

## Debugging workflow

1. **Think first** — map the full chain before touching code
2. **Probe before guessing** — `npm run probe` (build freshness, scripts, config, git, log tail) and `npm run probe:deep` (manager + BrowserView runtime). `00-build` tells you if a smoke will test STALE bundles.
3. **Write a demo** matching the main project environment (e.g. BrowserView + PPAPI + the same session hooks, not BrowserWindow)
4. **Demo passes → port to main project**
5. **Site-specific failures** — compare a minimal control probe with a probe that adds project policies one at a time. Record network failures, SWF requests and screenshots without logging tokens/query strings.

## Landmines

### Navigation & page lifecycle

- **CDP `debugger.attach` blocks `<script>` `onload`** — JSONP logins (7k7k) freeze if the debugger stays attached post-capture. Detach on non-`beforeunload` sources.
- **Navigation with an attached debugger freezes the tab** — call `teardownCapture(wc)` BEFORE any navigation API (`reload`/`navigate`/`goBack`/`goForward`); `did-stop-loading` re-attaches automatically.
- **Cross-origin iframes** cannot be reached with `executeJavaScript`. Use CDP `Runtime.evaluate` with `contextId`.
- **Login submission methods vary wildly**: 4399 = `<form>` submit, 7k7k = `<script>` JSONP injection. Probe before coding.
- **`did-fail-load` handler**: never call `wc.stop()` — it kills post-login redirects.
- **SPA soft navigation never creates a document** — scripts must not re-run; record URL changes via `did-navigate-in-page` → `manager.spaNavigate` (do not patch `history` in the preload).

### Flash / PPAPI / platform

- **Taomee 61.com**: modded SWFObject blocks Flash 32 — network-level redirect of `swfobject.js` (see `session-manager.ts`).
- **Never redirect `crossdomain.xml` to `data:`** — PPAPI reports it as `net::ERR_ABORTED`; games go white after a login switch. Serve native policy files; the permissive headers in `session-manager.ts` apply only to `.swf` requests for Ruffle, not PPAPI policy.
- **PPAPI version differs by platform**: Win `29.0.0.171`, Linux `32.0.0.371`. DLL filename must contain the version or `extractVersion` returns `0.0.0.0` → sites detect wrong version.
- **Advertised vs physical Flash versions are intentionally different on Windows**: bundled DLL 29.0.0.171, advertised default 34.0.0.330 for legacy site gates. Do not remove spoofing.
- **Linux requires `--no-sandbox`**. WSLg requires all three GPU flags: `--ignore-gpu-blacklist`, `--enable-gpu-rasterization`, `--enable-zero-copy`.
- **Never attempt to override or upgrade Electron version.** Everything depends on Chromium 87.

### Security & credentials

- **Password capture payloads use CDP `Runtime.addBinding`** — never send credentials through `console.log`, renderer IPC, or diagnostics. Dynamic form observation may send only a presence signal (`password:form-detected`).
- **GM_cookie is READ-ONLY by design** (list/get only, no set/delete); host access is gated by the script's @connect list. No set/delete without a dedicated security review.
- **Screenshot debug HTTP endpoint** — the ONLY external way to capture a RUNNING instance. Enable: `BAO_SCREENSHOT_HTTP=1 npm start` (dev only; packaged builds never listen). Token in `%APPDATA%\bao-flash-browser\logs\main.log` (`X-BAO-Token: <hex>`); `curl.exe -X POST http://127.0.0.1:44123/screenshot -H "X-BAO-Token: <token>" -d '{"save":true}'`. Loopback + header token + POST-only; newtab/userscripts pages have no BrowserView → `NO_TAB`. Full design: `docs/superpowers/specs/2026-08-07-screenshot-design.md` §调试 HTTP 口子.
- **Value-store admin methods bypass the view gate BY DESIGN** — `listScriptValues`/`setScriptValue`/`deleteScriptValue` skip the registered-view check that `setValue` requires; serializable/size checks and `noteValueWrite` persist remain. `unregisterView` runs the injected `onViewRemoved` — keep it decoupled.

### Sessions & network interception

- **Electron 11 webRequest listeners REPLACE each other on re-registration** — only one `onBeforeRequest` may exist per session; GM_webRequest must dispatch from session-manager's single callback (`getWebRequestObserver().notifyBeforeRequest`), never registered standalone. `onCompleted`/`onErrorOccurred` are unoccupied. GM_webRequest is observation-only (no intercept/modify), URL-redacted + @match filtered.

### Userscript runtime

- **Page-world bridge goes through preload `webFrame.executeJavaScript` (main world)** — CDP `Page.addScriptToEvaluateOnNewDocument` does NOT work: registrations die on debugger detach, and an attached debugger freezes navigation.
- **`webContents.send` reaches only the MAIN-frame preload** — `GM_registerMenuCommand` from sub-frames can never fire. Dedupe commands per script+title in the manager, keep only the main-frame entry (preload sends `isMainFrame`).
- **No-arg IPC channels must be validated with `z.object({}).optional()`** — a bare `z.object({})` rejects `undefined` payloads (`userscripts:list`, `userscripts:install-file`, ...).
- **`@background` runtime**: (1) dispatch `userscript:get-config` by `event.sender.id` — each script gets its OWN hidden window, never assume a single bg wc; (2) hidden windows need `backgroundThrottling: false` or timers stall; (3) window rebuilds (install/enable/delete) reset `setInterval`/menu/value listeners — re-register at top level; (4) crashes rebuild only their own window (1s→60s backoff), 5 crashes stop that script until `userscripts:background-restart`; (5) smokes must set `BAO_USERSCRIPT_PRELOAD_PATH` to `release/tests/userscript-runtime-preload.cjs` (`__dirname` is `release/tests`).
- **Bundled userscripts are embedded as TEXT at build time** — edit `bundled-scripts/css-fixer-entry.ts` then run `npm run build:css-fixer`, or the main bundle and `test:css-fixer`/admin smokes test STALE code. Snapshot source budget: 512KB/page (`maxSourceBytesPerPage`). Chromium 87 `link.disabled` toggling does not reliably reload a stylesheet — always replace with a rewritten/verbatim `<style>`. Rules dropped by unsupported pseudo-classes never exist in the CSSOM — rewrite at the CSS text layer.
- **Sub-frame script execution works in BOTH modes** — verified by `tests/electron/ruffle-iframe-smoke.cjs` (Ruffle/contextIsolation:false). No iframe badge in a Ruffle game = the game is inline in the main document, not a missing preload.

### IPC & preload

- **Every channel the preload queries at document start (`get-ruffle-mode`, `userscript:get-config`) MUST have a registered handler before any view navigates** — an unhandled `sendSync` accumulates renderer IPC corruption and later hangs navigation.
- **`config.ts` must keep electron-store lazy** (getStore()) — userscripts/index.ts imports loadConfig, and a top-level `new Store` breaks vitest import chains that mock electron.

### UI / tabs

- **BrowserView events must pass the current-WebContents guard** before updating a tab — engine switches destroy and replace the view while late events from the old renderer may still arrive.
- **Inactive-tab suspension is opt-in** — never suspend the active, loading, audible, or React new-tab page; recreation must restore engine, zoom and mute state.

### Build & tests

- **Standalone Electron smokes must mock every preload channel AND pin userData** — `tests/electron/*.cjs` do not load `userscripts.ipc.ts`; register your own `ipcMain.on` handlers for `get-config`/`report`/`menu-register` and call `app.setPath('userData', .../bao-flash-browser)`, or sends are silently dropped and electron-store reads `%APPDATA%\Electron`.
