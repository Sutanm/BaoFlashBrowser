# Modular Build Design — 按模块拆分打包

## Goal

让 BaoFlashBrowser 支持构建参数控制模块的包含/排除，被排除的模块通过 esbuild define + tree-shake 完全移除，减小产物体积。

## Constraints

- 默认 `npm run build` 行为不变（全功能），向后兼容
- esbuild define 替换为 `true`/`false`，死代码在构建时消除
- 解耦后不能引入运行时开销（无动态 import、无运行时注册表）
- Electron 11 / Chromium 87 不变

## Module Registry

### 可选模块标识符

| 标识符 | 包含范围 |
|--------|----------|
| `userscripts` | `modules/userscripts/`, `ipc/userscripts.ipc.ts`, `ipc/userscripts-admin.ipc.ts`, `webview-preload/userscripts/` |
| `automation` | `modules/automation/`, `ipc/automation-v3.ipc.ts`, `vision-worker.cjs` |
| `passwords` | `modules/password-store.ts`, `modules/password-capture.ts`, `modules/password-fill.ts`, `ipc/password.ipc.ts` |
| `screenshot` | `modules/screenshot-http.ts`（保留 screenshot 核心，仅移除 HTTP 调试端点） |
| `download` | `modules/download.ts`, `modules/download-state.ts`, `ipc/download.ipc.ts`, `aria2-*` |
| `diagnostics` | `modules/diagnostics.ts`, `ipc/diagnostics.ipc.ts` |
| `memory-monitor` | `modules/memory-monitor.ts` |
| `js-patch` | `modules/js-patch-service.ts`, `modules/js-patch-transform.ts` |

`core` 始终包含，不可排除。

### 环境变量

```bash
BAO_MODULES=core,userscripts,automation  # 逗号分隔的模块列表
```

默认值：`core,userscripts,automation,passwords,screenshot,download,diagnostics,memory-monitor,js-patch`（全功能）

### npm scripts

```json
"build": "BAO_MODULES=default npm run build:main && npm run build:renderer",
"build:full": "BAO_MODULES=all npm run build",
"build:minimal": "BAO_MODULES=core npm run build",
"build:no-automation": "BAO_MODULES=core,userscripts,passwords,screenshot,download,diagnostics,memory-monitor,js-patch npm run build",
"build:no-userscripts": "BAO_MODULES=core,automation,passwords,screenshot,download,diagnostics,memory-monitor,js-patch npm run build"
```

## Build Integration

### esbuild define（main process）

在 `esbuild.main.config.mjs` 中：

```js
import { parseModules } from './build/module-flags.mjs';

const modules = parseModules(process.env.BAO_MODULES);
const shared = {
  // ...existing config...
  define: {
    'MODULE_USERSCRIPTS': JSON.stringify(modules.has('userscripts')),
    'MODULE_AUTOMATION': JSON.stringify(modules.has('automation')),
    'MODULE_PASSWORDS': JSON.stringify(modules.has('passwords')),
    'MODULE_SCREENSHOT_HTTP': JSON.stringify(modules.has('screenshot')),
    'MODULE_DOWNLOAD': JSON.stringify(modules.has('download')),
    'MODULE_DIAGNOSTICS': JSON.stringify(modules.has('diagnostics')),
    'MODULE_MEMORY_MONITOR': JSON.stringify(modules.has('memory-monitor')),
    'MODULE_JS_PATCH': JSON.stringify(modules.has('js-patch')),
  },
};
```

### Vite define（renderer）

在 `vite.renderer.config.ts` 中：

```ts
import { parseModules } from '../build/module-flags.mjs';

const modules = parseModules(process.env.BAO_MODULES);
export default defineConfig({
  define: {
    MODULE_USERSCRIPTS: JSON.stringify(modules.has('userscripts')),
    MODULE_AUTOMATION: JSON.stringify(modules.has('automation')),
    MODULE_PASSWORDS: JSON.stringify(modules.has('passwords')),
  },
});
```

### 条件构建产物

`esbuild.main.config.mjs` 中，`vision-worker.cjs` 仅在 `modules.has('automation')` 时构建：

```js
const builds = [
  // main, preload, webview-preload, sandbox-preload — always
  ...(modules.has('automation') ? [automationWorkerBuild] : []),
];
```

## Decoupling — 5 Entanglement Points

### Coupling 1: userscripts.ipc → automation

**Current:** `userscripts.ipc.ts` imports `getAutomationV3Service`, `detectGameSurfaces`, `DEFAULT_IMAGE_MATCH_MASK` from automation modules for `GM_baoAutomation` API.

**Fix:** Extract to `ipc/automation-userscript-bridge.ipc.ts`:

```ts
// ipc/automation-userscript-bridge.ipc.ts
export function registerAutomationUserscriptBridge(getWin: () => BrowserWindow | null): void {
  // All GM_baoAutomation IPC handlers moved here
}
```

In `index.ts`:
```ts
if (MODULE_USERSCRIPTS && MODULE_AUTOMATION) {
  registerAutomationUserscriptBridge(() => getMainWindow());
}
```

### Coupling 2: session-manager → getWebRequestObserver

**Current:** `session-manager.ts` imports `getWebRequestObserver` from `./userscripts` and calls it in `onBeforeRequest`.

**Fix:** Callback injection pattern. `session-manager.ts` accepts an optional observer:

```ts
// session-manager.ts
let webRequestObserver: { notifyBeforeRequest(e: any): void; attach(s: Electron.Session): void } | null = null;

export function setWebRequestObserver(observer: typeof webRequestObserver): void {
  webRequestObserver = observer;
}

// Inside onBeforeRequest:
webRequestObserver?.notifyBeforeRequest(details);
```

In `index.ts`:
```ts
if (MODULE_USERSCRIPTS) {
  const { getWebRequestObserver } = require('./modules/userscripts');
  setWebRequestObserver(getWebRequestObserver());
}
```

### Coupling 3: tabs.ts → getUserscriptManager / transientCdpInspection

**Current:** `tabs.ts` imports `getUserscriptManager` and `inspectWithPasswordCapturePaused`.

**Fix:** Optional dependency injection:

```ts
// tabs.ts
type ScriptInjector = (wc: WebContents, url: string) => void;
type CdpInspector = (wc: WebContents) => Promise<void>;

let scriptInjector: ScriptInjector | null = null;
let cdpInspector: CdpInspector | null = null;

export function setScriptInjector(fn: ScriptInjector | null): void { scriptInjector = fn; }
export function setCdpInspector(fn: CdpInspector | null): void { cdpInspector = fn; }
```

In `index.ts`:
```ts
if (MODULE_USERSCRIPTS) {
  const mgr = getSnapshotInjector();
  setScriptInjector((wc, url) => mgr?.snapshotFor(wc, url));
}
if (MODULE_AUTOMATION) {
  setCdpInspector(inspectWithPasswordCapturePaused);
}
```

### Coupling 4: js-patch-service → userscripts (isBlockedUrl)

**Current:** `js-patch-service.ts` imports `isBlockedUrl` from `../modules/userscripts/userscript-request` — a pure URL classification utility with no runtime dependency on userscript infrastructure.

**Fix:** Extract `isBlockedUrl` (and its helper `classifyAddress`) to `src/shared/utils/url-classification.ts`. Both `js-patch-service.ts` and userscripts modules import from the shared location. Tree-shake-safe since it's a pure function.

### Coupling 5: config.ts → userscript/automation config keys

**Current:** `config.ts` has 9 userscript config keys (`userscriptMaxResponseMB`, etc.) and 2 automation keys (`automationVisionWarmStart`, `automationOcrWarmStart`) in `Config` interface and `DEFAULT_CONFIG`.

**Fix:** Conditionally include config keys via `MODULE_*`:

```ts
// config.ts
interface BaseConfig {
  flashVersion: string;
  flashPluginChannel: FlashPluginChannel;
  lowEndMode: boolean;
  downloadEngine: DownloadEngine;
  downloadDir: string;
  screenshotDir: string;
}

type Config = BaseConfig
  & (MODULE_USERSCRIPTS extends true ? UserscriptConfig : {})
  & (MODULE_AUTOMATION extends true ? AutomationConfig : {})
  & (MODULE_PASSWORDS extends true ? PasswordConfig : {});

// DEFAULT_CONFIG and CONFIG_SCHEMA built conditionally
```

This keeps electron-store schema valid for the active build. Users upgrading from minimal→full get defaults via electron-store migration.

## UI-Side Modularity

### App.tsx conditional rendering

```tsx
const AutomationPage = MODULE_AUTOMATION
  ? lazy(() => import('./components/automation/AutomationPage'))
  : null;
const UserscriptsPage = MODULE_USERSCRIPTS
  ? lazy(() => import('./components/userscripts/UserscriptsPage'))
  : null;

// URL routing guards
const isOnUserscripts = MODULE_USERSCRIPTS && activeTab?.url === 'about:userscripts';
const isOnAutomation = MODULE_AUTOMATION && activeTab?.url === 'about:automation';
```

### Preload conditional loading

`webview-preload/index.ts`:
```ts
if (MODULE_USERSCRIPTS) {
  // Load userscript bootstrap, scheduler, sandbox, gm-api
}
```

### TopBar / Sidebar

Hidden navigation entries for disabled modules via the same `MODULE_*` constants.

## Shared Type Adjustments

`ActivePanel` type in `shared/types/passwords.ts`:
```ts
type ActivePanel = 'favorites' | 'history' | 'downloads'
  | (MODULE_AUTOMATION extends true ? 'automation' : never)
  | (MODULE_USERSCRIPTS extends true ? 'userscripts' : never)
  | 'settings' | null;
```

Since `MODULE_*` are compile-time constants, TypeScript will narrow the union correctly.

## File Changes Summary

| File | Change |
|------|--------|
| `build/module-flags.mjs` | **New** — parseModules() helper |
| `esbuild.main.config.mjs` | Add define, conditional vision-worker build |
| `vite.renderer.config.ts` | Add define |
| `src/main/index.ts` | Conditional imports + dependency injection wiring |
| `src/main/modules/session-manager.ts` | Replace direct import with optional callback |
| `src/main/modules/tabs.ts` | Replace direct imports with DI setters |
| `src/main/modules/config.ts` | Conditional config keys via type narrowing |
| `src/main/ipc/userscripts.ipc.ts` | Remove automation imports (move to bridge) |
| `src/main/ipc/automation-userscript-bridge.ipc.ts` | **New** — GM_baoAutomation handlers |
| `src/main/modules/js-patch-service.ts` | Import isBlockedUrl from shared/utils |
| `src/shared/utils/url-classification.ts` | **New** — extracted from userscripts |
| `src/renderer/App.tsx` | Conditional lazy imports + URL guards |
| `src/webview-preload/index.ts` | Conditional userscript bootstrap |
| `package.json` | New build scripts |

## Estimated Build Size Impact

| Build | main.js | webview-preload.js | vision-worker.cjs | renderer |
|-------|---------|-------------------|-------------------|----------|
| full (current) | ~800KB | ~150KB | ~2MB | ~400KB |
| minimal | ~300KB | ~20KB | 不生成 | ~200KB |
| no-automation | ~500KB | ~80KB | 不生成 | ~300KB |
| no-userscripts | ~600KB | ~50KB | 不生成 | ~250KB |

## Testing

- `npm run build` (full) → all tests pass, behavior identical to current
- `npm run build:minimal` → smoke test: app launches, tabs work, no automation/userscript entries in UI
- `npm run build:no-automation` → no automation UI, userscripts work normally
- `npm run build:no-userscripts` → no userscript UI, automation works normally
- `npm test -- --run` → unit tests pass regardless of BAO_MODULES
