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
npm run test:smokes          # every Electron smoke in scripts/run-smokes.cjs (values/gm/menu/cookie/webrequest/background/csp)
npm run build:win64 / build:win32 / build:linux   # packaged builds — each bundles OCR by default
npm run build:automation-assistant                # rebuild the built-in page assistant bundle (@updateHash)
npm run prepare:ocr:tesseract                     # Win32 (ia32) OCR runtime; needs an x86 MSVC toolchain
```

**NOTE — `npm test` only runs the `unit` Vitest project.** Heavy suites
(`automation-vision-worker`, OCR sidecars) live in the `integration` project:
`npm run test:integration` or `npm run test:all`. Coverage: `npm run test:coverage`.
Playwright e2e asserts the React shell UI only (Electron 11 BrowserView contents
are not reachable through Playwright DOM APIs).

**IMPORTANT — `npm run build` does NOT rebuild `release/tests/` products.** Smoke bundles
(`release/tests/userscripts-admin-module.cjs`, `userscript-runtime-preload.cjs`,
`automation-authoring-core.cjs`, `automation-js-sandbox-host.cjs`,
`session-compatibility-smoke.cjs`, `userscript-runtime-smoke.cjs`) are built only by their own
`tests/electron/build-*.mjs`.

This no longer causes stale-code smokes, because the mechanism is now enforced rather than
remembered:

- `scripts/smoke-bundles.cjs` is the single manifest of every smoke bundle (id, product,
  build script). Both the freshness probe and the ensure step read it, so they cannot drift.
- `npm run ensure:smoke-bundles` (`scripts/ensure-build.cjs`) rebuilds any bundle older than
  its sources; it is wired into every npm script that runs a smoke, and `test:smokes` runs it
  first. Rebuilding is idempotent and costs ~50 ms when nothing is stale.
- `scripts/run-smokes.cjs` additionally refuses to start on stale bundles, so a direct
  `node scripts/run-smokes.cjs` cannot test outdated code either.
- `tools/probe/probes/00-build.cjs` reports staleness (`--check` semantics).

Only a raw `npx electron tests/electron/<smoke>.cjs` bypasses all of this. If you go that
route, run `node scripts/ensure-build.cjs` first — or just check `npm run probe`.

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
| `src/main/modules/view-gate.ts` | View gate before decryption: CredUI (A tier) or view password (C′); 5 failures → 30 min lock in `password-view-guard` |
| `src/main/modules/flash-version.ts` | Physical plugin version: filename → embedded `WIN/LNX x,y,z,w` token → macOS manifest |
| `src/main/modules/proxy.ts` | Global proxy resolution (Electron 11 `setProxy` shape), applied before windows exist |
| `src/main/modules/github-module-service.ts` | `bfb-github-module:` ES-module rewrite so GitHub works on Chromium 87 |
| `src/main/modules/app-update.ts` | GitHub `releases/latest` check — notify only, never auto-installs or polls |
| `src/main/modules/automation/service-v3.ts` | Automation v3 runtime: package load, workflow execution, JS sandbox lifecycle |
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
| `docs/archive/superpowers/specs/` | Design specs (screenshot design incl. §调试 HTTP 口子) |

## Debugging workflow

1. **Think first** — map the full chain before touching code
2. **Probe before guessing** — `npm run probe` (build freshness, scripts, config, git, log fingerprints) and `npm run probe:deep` (manager + BrowserView runtime). `00-build` tells you if a smoke will test STALE bundles.
3. **For renderer / live-page questions, add a probe — do not hand-roll an Electron script.** `probe:deep` runs any `needsElectron: true` probe with `ctx.electron` (`app`, `BrowserWindow`, `BrowserView`, `ipcMain`) plus a per-probe `timeoutMs` and a global watchdog, so you get real Electron behavior with timeouts already solved. `tools/probe/probes/11-views.cjs` is the working template: it loads a BrowserView with the production preload and asserts over `webContents.executeJavaScript`. New probe = copy `probes/_template.cjs` — and prefer adding the check there over writing a one-off `tests/electron/*.cjs`.
4. **Write a demo** matching the main project environment (e.g. BrowserView + PPAPI + the same session hooks, not BrowserWindow)
5. **Demo passes → port to main project**
6. **Site-specific failures** — compare a minimal control probe with a probe that adds project policies one at a time. Record network failures, SWF requests and screenshots without logging tokens/query strings.

## IPC & port policy（2026-11-06 收敛约定）

**全应用零固定端口**：所有监听 = 127.0.0.1 回环 + 系统临时端口（`listen(0)` / `--remote-debugging-port=0`）+ 随应用生命周期生灭。新功能**默认不开端口**，按这个决策树选通道：

| 通信双方 | 通道 | 现存实例 |
| --- | --- | --- |
| renderer ↔ main | Electron IPC（永远优先） | 全部 IPC |
| main ↔ 自 spawn 的子进程 | **stdio 管道** | OCR sidecar（`bao1-ocr-sidecar-engine.ts`） |
| main ↔ 只支持 TCP RPC 的三方进程 | 回环临时端口，主进程先 bind(0) 探测再传入 | aria2 RPC（`aria2-rpc.ts`） |
| main ↔ 本机外部进程（开发态） | 回环临时端口 + token 鉴权 + opt-in | screenshot HTTP |
| DevTools 前端 ↔ Chromium | CDP 端口（Chromium 自管，`appendSwitch('remote-debugging-port','0')`） | 不可消除，非业务端口 |
| 抽屉 iframe 前端资源 | 回环 HTTP 静态服务 | `file://` 下 ES module 被 CORS 拦、私有 scheme iframe 是 chrome-error（均已实测），HTTP 是唯一通路 |

开新端口的门槛：先证明 stdio/IPC 不可行，并在对应模块文档里记录"为什么必须是端口"。监听器数量只应随**需要跨进程的第三方组件**增长，不随业务功能增长。回环临时端口的内核开销与任意 WebSocket 连接同级，数量为个位数时无需优化。

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
- **PPAPI physical versions differ by platform** (measured from the binaries, not the file names): win64 stable `29.0.0.171`, win32 stable `34.0.0.330`, linux64 stable `32.0.0.371`, win64 experimental `34.0.0.380`. `flash-version.ts` resolves `physicalVersion` as file name → embedded `WIN x,y,z,w` / `LNX x,y,z,w` token → macOS `manifest.json`. A null now means the file was unreadable, **not** that the version is unknown — do not render "unknown" for it.
- **Advertised vs physical Flash versions are intentionally different**: `ppapi-flash-version` comes from `config.flashVersion` (default `34.0.0.330`) so legacy site gates pass, while the DLL on disk is older. Do not "fix" the mismatch.
- **Stable bundles ship unversioned file names** (`pepflashplayer64.dll`), so filename parsing alone yields null; the embedded token is what makes the version observable. Never reintroduce a hardcoded version table.
- **Linux requires `--no-sandbox`**. WSLg requires all three GPU flags: `--ignore-gpu-blacklist`, `--enable-gpu-rasterization`, `--enable-zero-copy`.
- **Never attempt to override or upgrade Electron version.** Everything depends on Chromium 87.

### Security & credentials

- **Password capture payloads use CDP `Runtime.addBinding`** — never send credentials through `console.log`, renderer IPC, or diagnostics. Dynamic form observation may send only a presence signal (`password:form-detected`).
- **GM_cookie is READ-ONLY by design** (list/get only, no set/delete); host access is gated by the script's @connect list. No set/delete without a dedicated security review.
- **Screenshot debug HTTP endpoint** — the ONLY external way to capture a RUNNING instance. Enable: `BAO_SCREENSHOT_HTTP=1 npm start` (dev only; packaged builds never listen). Token in `%APPDATA%\bao-flash-browser\logs\main.log` (`X-BAO-Token: <hex>`); `curl.exe -X POST http://127.0.0.1:44123/screenshot -H "X-BAO-Token: <token>" -d '{"save":true}'`. Loopback + header token + POST-only; newtab/userscripts pages have no BrowserView → `NO_TAB`. Full design: `docs/archive/superpowers/specs/2026-08-07-screenshot-design.md` §调试 HTTP 口子.
- **Value-store admin methods bypass the view gate BY DESIGN** — `listScriptValues`/`setScriptValue`/`deleteScriptValue` skip the registered-view check that `setValue` requires; serializable/size checks and `noteValueWrite` persist remain. `unregisterView` runs the injected `onViewRemoved` — keep it decoupled.

### Password vault & keyring

- **A failure path must never destroy key material.** `_loadWrapKey` once treated a transient DPAPI probe timeout as a backend mismatch, shelved the key file and cleared it — every vault entry became permanently unreadable (2026-09-21). Transient → keep file + backoff; deterministic → keep file + `blocked`; the only destructive path is `password:rebuild-vault` (confirm `REBUILD`).
- **The view gate runs BEFORE decryption.** Order is "vault decryptable → entry exists → verify". Never call `getDecryptedPassword` first and check authorization after; plaintext leaves the main process in exactly one IPC reply.
- **Windows keyring helpers are PowerShell subprocesses and their scripts must be pure ASCII.** PowerShell 5.1 decodes `-Command` and BOM-less `.ps1` as ANSI, so a non-ASCII literal breaks quote pairing into a whole-script syntax error. Ship text/credentials as base64 on stdin; unit tests assert the ASCII invariant.
- **`debugger.attach('1.3')` must go through `cdp-lease`.** Attaching directly races password capture and fails with `CDP is already attached by an unmanaged client`; short inspections use `transient-cdp-inspection`. Capture re-arm must test `!lease.released`, because an autofill lease can be released while `isAttached()` is still true.

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
- **The main window predates `app.on('web-contents-created')`** — it is created earlier in `whenReady`, so anything registered only through that event never reaches the shell. Keyboard shortcuts were hit by this: F12 worked on a page but did nothing while focus sat in the address bar or the devtoolbox input. Register explicitly with `registerShortcutHandler(mainWindow.webContents)`; the helper is idempotent because a double binding sends two `shortcut` events and a toggle action appears to do nothing.

### Data flow

- **The main process is the only authority for any state it pushes live.** A renderer IndexedDB mirror plus `useLiveQuery` formed a feedback loop that rewrote `progressing`/`paused` downloads into `interrupted` every 0.5–1 s (2026-09-04); the mirror and `download:sync-records` were removed. The renderer stores Zustand only: one `download:list` at startup, then push events.
- **Two language/theme sources exist on purpose** — renderer `settings.language` (typesafe-i18n) and main `config.uiLanguage` (`uiText()`), joined by `ui:set-language` → `ui:language-changed`. Theme must be pushed as a *mode* (`system`/`light`/`dark`) via `theme:set-source`; sending a resolved color pins `system` forever.

### Build & tests

- **Standalone Electron smokes must mock every preload channel AND isolate userData** — `tests/electron/*.cjs` do not load `userscripts.ipc.ts`; register your own `ipcMain.on` handlers for `get-config`/`report`/`menu-register`, or sends are silently dropped.
  For userData, put this immediately after requiring electron and before any `app.*` call:
  `require('./isolate-user-data.cjs')(app, '<smoke-name>');`
  It pins userData to a fresh temp dir (honoring `BAO_SMOKE_USER_DATA`). **Do NOT point it at the real app dir**: without it Electron falls back to `%APPDATA%\Electron`, where smokes previously shared and polluted one directory (`userscripts.json` grew to 518 KB, plus `password-store.json` / `password-autofill-key.json`). That last one is the dangerous case — `password-store.init()` SHELVES and CLEARS the wrap key when the OS keyring cannot unwrap it, so a smoke aimed at real userData would make existing vault entries permanently unreadable.
