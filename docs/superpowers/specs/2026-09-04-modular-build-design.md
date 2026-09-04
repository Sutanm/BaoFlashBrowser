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

## 实施记录（2026-09-04）

第一批已完成模块注册表、严格参数解析、esbuild/Vite编译期常量、条件Vision Worker、主进程启动守卫、BrowserView preload守卫及renderer入口/侧栏守卫。新增命令：

- `npm run build:full`
- `npm run build:minimal`
- `npm run build:no-automation`
- `npm run build:no-userscripts`

最小构建的实际测量值为：

| 产物 | 全功能基线 | `core` 第一批 | 变化 |
|---|---:|---:|---:|
| `dist/main.js` | 约11.2MiB | 约9.8MiB | 下降约1.0MiB，仍有主进程静态耦合待拆 |
| `dist/webview-preload.js` | 约162KiB | 约116KiB | userscript/password启动代码已被编译期消除 |
| renderer | 约623KiB主包 + 792KiB自动化块 | 约367KiB单主包 | 自动化/用户脚本工作台不再进入最小产物 |
| `vision-worker.cjs` | 生成 | 不生成，旧文件也会清除 | 达标 |

原“Estimated Build Size Impact”是设计前估值，不能作为验收数据。尤其主进程当前包含Ruffle资源读取及仍未解开的`session-manager`/`tabs`/userscript/automation依赖，第一批不会虚报为300KB。后续批次必须用产物字符串/元文件证明依赖图已消除。

### 第二批：主进程物理裁剪

第二批已完成阻止主进程瘦身的反向依赖拆除：

- `session-manager` 不再静态导入 Download、JS Patch、Userscript，改由启动入口注入 Session 能力。
- `tabs` 不再静态导入 Password、Userscript、Automation 实现，改由启动入口注入密码与脚本管理能力。
- `config.ipc` 不再为热更新容量设置而导入整个 Userscript 模块。
- 悬浮助手的 11 个 Automation IPC 从通用 `userscripts.ipc` 移入独立桥接层，仅在 Automation 与 Userscript 同时启用时注册。
- 主入口的可选实现改为编译期守卫内加载。仅在调用点加 `if (MODULE_*)` 不足以裁剪带副作用的静态 ES import，本批已消除该误区。
- 独立 Userscript smoke 构建显式注入全功能模块常量，避免绕过主构建配置时出现 `MODULE_PASSWORDS is not defined`。

2026-09-04 实测（未压缩字节）：

| 构建 | `main.js` | `webview-preload.js` | Automation Worker | 关键验证 |
|---|---:|---:|---|---|
| full | 10,816,632 B | 162,167 B | 生成 | 完整产物已恢复 |
| core | 约205 KiB | 118,770 B | 不生成 | 助手、OCR、Vision、密码、下载、Userscript实现均不在主包 |
| no-automation | 1,309,085 B | 162,167 B | 不生成 | 无`AutomationV3Service`、PaddleOCR、Vision Worker和助手桥通道 |
| no-userscripts | 10,194,210 B | 120,287 B | 生成 | 无内置助手源码、`GmRequestService`、`GM_webRequest`和助手桥通道 |

最小主进程由第一批约9.8MiB降至约200KiB，说明关闭可选模块现在是物理依赖裁剪，而非仅隐藏UI。Automation 本身仍占主包绝大多数；如果后续还要缩小全功能主包，应继续把 Automation Core 拆成按需加载边界，而不是再优化几十KiB的核心壳。

第二批验证：TypeScript 全量检查通过；ESLint 0 error（保留35条既有 warning）；108个单元测试文件、644个测试通过；BrowserView Electron smoke通过；Userscript smoke必选项147/147通过。

### 第三批：资源生成与安装包边界

第三批让源码构建与electron-builder读取同一份严格模块清单：

- 模块清单的实现下沉到`module-flags.cjs`，ESM构建配置通过薄包装复用，避免主构建和CJS打包配置各自解释`BAO_MODULES`。
- `build:optional-assets`仅在启用Userscript时生成CSS Fixer，仅在Userscript与Automation同时启用时生成悬浮助手；`core`构建不再执行这两项无关生成任务。
- 无Automation的Userscript构建不再内置或安装悬浮助手，避免向用户提供注定不可工作的入口。产物检查确认不存在助手源码、`GM_baoAutomation`与`userscript:automation-v3-*`通道。
- electron-builder在关闭Download时不再携带aria2；关闭Automation时不再配置Vision Worker/OpenCV解包，并显式排除OpenCV npm依赖。
- OCR安装包现在强制要求Automation模块，错误组合在打包前直接失败。
- 发布校验按模块判断aria2、OpenCV和Vision Worker是否为必需项。

本批已验证`core`和`no-automation`源码构建，且恢复了full产物；electron-builder配置的Windows x64 core解析结果只包含Flash插件与鼠标钩子，`asarUnpack`为空。尚未实际生成精简NSIS/AppImage，因此安装包尺寸和解包目录检查留给发布矩阵验收，不能写成已经通过。

### 第四批：设置页与配置契约收口

第四批处理“模块已关闭，但设置页仍显示或调用该模块”的半裁剪状态：

- 设置分类、详情卡片与保存载荷都由编译期模块常量控制。关闭模块后，不再显示密码管理、Automation预热、Userscript容量、下载引擎或诊断导出入口。
- 密码状态查询也受`MODULE_PASSWORDS`保护，精简版挂载设置页时不会访问未注册的密码IPC。
- 截图目录属于浏览器核心截图能力，不等同于可选的Download模块；关闭Download后仍保留截图目录设置，分类标题改为仅描述截图。
- 主进程`Config`把模块字段改为可选，并按当前构建生成`DEFAULT_CONFIG`、`CONFIG_KEYS`与electron-store Schema。旧配置文件中属于已关闭模块的键不会进入加载结果，也不会被保存。
- `save-config`使用同一组编译期能力生成严格Zod Schema，精简版会拒绝而不是静默接受不存在模块的字段。
- 可选模块内部读取配置时提供自身默认值，保证完整版以及由旧配置升级的运行环境行为不变。
- Vitest固定按全功能能力运行；精简组合仍由实际`BAO_MODULES=core`构建验证，避免测试环境的未定义编译常量掩盖问题。

`core`实测中，`dist/main.js`由本批修改前205,614 B降至203,143 B；主进程产物已不存在下载、Userscript容量和Automation预热配置键，也不存在密码、诊断IPC。renderer运行路径不再发出这些模块请求。安装包矩阵仍未执行。

### 第五批：Windows Core 安装包实测

首次执行Windows x64 Core打包时发现两处仅靠配置审查无法发现的发布问题：

1. `verify-release`的源码必需文件列表仍无条件要求`vision-worker.cjs`，与模块清单矛盾。现已按Automation能力要求或禁止该文件。
2. electron-builder的`files`数组由FileSet对象和一个OpenCV否定字符串组成。由于字符串模式中没有正向根路径，builder自动补入`**/*`，把`.cache`和`release`递归装入`app.asar`，一度生成11.4GB归档并触发安装器完整性保护。现以`dist/**/*`作为首个正向根路径，再应用OpenCV排除规则，并增加边界测试防止顺序回归。

修复后Windows x64 Core实测结果：

| 产物/检查 | 结果 |
|---|---:|
| `app.asar` | 70,208,858 B |
| NSIS安装器 | 86,920,257 B |
| unpacked发布校验 | 6项通过 |
| aria2目录 | 不存在 |
| OCR目录 | 不存在 |
| Vision Worker解包文件 | 不存在 |
| OpenCV.js解包依赖 | 不存在 |

这次已真正生成NSIS，而不再只是解析electron-builder配置。Linux AppImage及其他模块组合的实际安装包仍未执行。
