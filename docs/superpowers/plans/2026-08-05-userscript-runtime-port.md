# 用户脚本运行时移植计划(demo → 主项目)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `tests/electron/userscripts/` 验证过的用户脚本运行时(demo)按 7 个批次移植到 `src/`,每批次独立验证并提交 git,保证可回滚。

**Architecture:** 纯逻辑层(parser/matcher/values/store/require-cache/策略)无 Electron 依赖,进 `src/main/modules/userscripts/`;服务层(request/download 用 `electron.net`)与 manager 同目录;preload 运行时 6 模块进 `src/webview-preload/userscripts/` 并由现有 `webview-preload/index.ts` 集成;共享类型放 `src/shared/userscript-types.ts`;IPC 用项目既有 `ipc-wrapper + zod` 模式注册于 `src/main/ipc/userscripts.ipc.ts`。

**Tech Stack:** Electron 11.5.0(锁定)/ Chromium 87,TypeScript,esbuild(main/preload bundle),Vite(renderer),Vitest(单测),zod。

## Global Constraints

- Electron 版本**永远不升级**(Chromium 87,最后原生 PPAPI Flash)。
- 移植只动 `src/` 与测试基础设施;**demo 原始文件(`tests/electron/userscripts/`)在批次 6 验证通过前不删除**(作为对照与回归)。
- 安全红线:凭据永远不进 renderer IPC(密码捕获/填充已存在,不涉及);用户脚本执行继续词法注入,不挂全局;`stripNodeGlobals` 仅 ppapi 模式。
- 页世界桥注入用 preload `webFrame.executeJavaScript`(主世界),**禁止 CDP 注入**(实测:detach 清除注册、attach 冻结导航)。
- IPC 一律 `ipc-wrapper` + `zod` 校验(见 `src/main/ipc/*.ipc.ts` 既有模式)。
- 共享类型只能放 `src/shared/`(main 与 preload 两个 tsconfig 都 include 它)。
- 单测文件放 `tests/userscripts/`,用 `@main/modules/userscripts/...` 别名导入(vitest 已配 `@main`);`npm test -- --run` 全绿是每批验收底线。
- 每批次完成验证后**必须 git commit**(用户要求,保证可回滚);批次内部步骤间无需提交。
- 所有模块沿用 demo 的"Mirrors the planned src/..."注释风格与函数签名,**不做行为重构**;批次内只改 import 路径与集成点。

---

### Task 1: 纯逻辑核心移植(types/parser/matcher/values/store)

**Files:**
- Create: `src/shared/userscript-types.ts`
- Create: `src/main/modules/userscripts/userscript-parser.ts`
- Create: `src/main/modules/userscripts/userscript-matcher.ts`
- Create: `src/main/modules/userscripts/userscript-values.ts`
- Create: `src/main/modules/userscripts/userscript-store.ts`
- Test: `tests/userscripts/userscript-parser.test.ts`、`userscript-matcher.test.ts`、`userscript-values.test.ts`、`userscript-store.test.ts`
- Modify: 无(纯新增)

**Interfaces:**
- Consumes: 无(demo 模块自身,零依赖)
- Produces:
  - `parseUserscriptMetadata(source: string): UserscriptMetadata | null`(userscript-parser)
  - `compileRules(meta: { match?: string[]; include?: string[]; exclude?: string[]; excludeMatch?: string[]; noframes?: boolean }): CompiledRules` 与 `matchesUrl(rules: CompiledRules, url: string): boolean`(userscript-matcher)
  - `isSerializableValue(v: unknown): boolean`、`serializeValue`、`deserializeValue`(userscript-values)
  - `class ValueStore { get/set/delete/list(scriptId,key?); snapshot(): ValueSnapshot; }`(userscript-store)
  - `src/shared/userscript-types.ts` 导出 `UserscriptMetadata`、`InstalledUserscript`、`FrameSnapshot`、`SnapshotScript`、`UserscriptReport`、`GMSerializable` 等全部 demo 类型

- [ ] **Step 1: 复制 5 个源文件并调整 import 路径**

把以下文件**内容原样复制**(含注释与 `Mirrors the planned src/...` 注释删除——现在它们就是目标文件):
- `tests/electron/userscripts/userscript-types.ts` → `src/shared/userscript-types.ts`(保留全部导出;顶部注释改为 `// Shared types for the userscript runtime (main + webview preload).`)
- `tests/electron/userscripts/userscript-parser.ts` → `src/main/modules/userscripts/userscript-parser.ts`
- `tests/electron/userscripts/userscript-matcher.ts` → `src/main/modules/userscripts/userscript-matcher.ts`
- `tests/electron/userscripts/userscript-values.ts` → `src/main/modules/userscripts/userscript-values.ts`
- `tests/electron/userscripts/userscript-store.ts` → `src/main/modules/userscripts/userscript-store.ts`

import 调整(仅这些):
- `userscript-parser.ts`: `import type { UserscriptMetadata } from './userscript-types';` → `import type { UserscriptMetadata } from '../../shared/userscript-types';`
- `userscript-matcher.ts`: 同上(types)
- `userscript-values.ts`: 同上(types)
- `userscript-store.ts`: `from './userscript-types'` → `from '../../shared/userscript-types'`;`from './userscript-values'` → `from './userscript-values'`(同目录,不变)

- [ ] **Step 2: 迁移 4 组单测并改 import**

复制 demo 测试文件到 `tests/userscripts/`:
- `tests/electron/userscripts/userscript-parser.test.ts`、`userscript-matcher.test.ts`、`userscript-values.test.ts`、`userscript-store.test.ts` → `tests/userscripts/` 同名

import 调整:
- `from './userscript-parser'` → `from '@main/modules/userscripts/userscript-parser'`
- `from './userscript-matcher'` → `from '@main/modules/userscripts/userscript-matcher'`
- `from './userscript-values'` → `from '@main/modules/userscripts/userscript-values'`
- `from './userscript-store'` → `from '@main/modules/userscripts/userscript-store'`

- [ ] **Step 3: 验证**

```bash
npx tsc -p tsconfig.main.json --noEmit
npx tsc -p tsconfig.preload.json --noEmit
npx vitest run tests/userscripts
```
Expected: 无类型错误;新单测全过(parser/matcher/values/store 计数 = demo 原数)。

- [ ] **Step 4: 提交**

```bash
git add src/shared/userscript-types.ts src/main/modules/userscripts tests/userscripts
git commit -m "feat(userscripts): 移植纯逻辑核心 (types/parser/matcher/values/store) 到主项目"
```

---

### Task 2: 服务层移植(require-cache/request/download)

**Files:**
- Create: `src/main/modules/userscripts/userscript-require-cache.ts`
- Create: `src/main/modules/userscripts/userscript-request.ts`
- Create: `src/main/modules/userscripts/userscript-request-service.ts`
- Create: `src/main/modules/userscripts/userscript-download.ts`
- Create: `src/main/modules/userscripts/userscript-download-service.ts`
- Test: `tests/userscripts/userscript-require-cache.test.ts`、`userscript-request.test.ts`、`userscript-download.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ValueStore`(无直接依赖,但同目录布局)与 types
- Produces:
  - `class RequireCache { constructor(opts: { fetcher: (url: string) => Promise<string>; maxBytes?: number }); fetch(url: string): Promise<string>; get(url: string): string | undefined; }`
  - `class GmRequestService { constructor(opts: { session: Session; allowedLoopbackHosts: string[]; maxRedirects: number; maxResponseBytes: number; defaultTimeoutMs: number; maxConcurrentPerScript: number; maxConcurrentGlobal: number }); request(wcId, scriptId, pageUrl, connect, details, localId): Promise<GmRequestResult>; abort(wcId, localId): void; cancelForWc(wcId): void; }`
  - `class GmDownloadService { constructor(opts: { downloadDir: string; session: Session; allowedLoopbackHosts: string[]; maxBytes: number; maxConcurrentPerScript: number }); download(wcId, scriptId, pageUrl, connect, details, localId): Promise<GmDownloadResult>; abort(wcId, localId): void; cancelForWc(wcId): void; }`
  - `sanitizeFileName(name: string): string`(userscript-download,纯函数)

- [ ] **Step 1: 复制 5 个源文件并调整 import**

原样复制(demo 文件即权威实现):
- `tests/electron/userscripts/userscript-require-cache.ts` → `src/main/modules/userscripts/userscript-require-cache.ts`(无 electron 依赖,仅 fetcher 注入)
- `tests/electron/userscripts/userscript-request.ts` → `src/main/modules/userscripts/userscript-request.ts`(纯策略)
- `tests/electron/userscripts/userscript-request-service.ts` → `src/main/modules/userscripts/userscript-request-service.ts`
- `tests/electron/userscripts/userscript-download.ts` → `src/main/modules/userscripts/userscript-download.ts`(纯消毒)
- `tests/electron/userscripts/userscript-download-service.ts` → `src/main/modules/userscripts/userscript-download-service.ts`

import 调整(仅这些,其余保持不变):
- `userscript-require-cache.ts`: types → `../../shared/userscript-types`
- `userscript-request.ts`: types → `../../shared/userscript-types`
- `userscript-request-service.ts`: 内部 `./userscript-request`(同目录不变)、types → `../../shared/userscript-types`
- `userscript-download.ts`: types → `../../shared/userscript-types`
- `userscript-download-service.ts`: `./userscript-download` 不变、types → `../../shared/userscript-types`

- [ ] **Step 2: 迁移 3 组单测并改 import**

复制 `tests/electron/userscripts/` 的 `userscript-require-cache.test.ts`、`userscript-request.test.ts`、`userscript-download.test.ts` → `tests/userscripts/`。import 调整(按文件原 import 前缀):
- `from './userscript-require-cache'` → `from '@main/modules/userscripts/userscript-require-cache'`
- `from './userscript-request'` → `from '@main/modules/userscripts/userscript-request'`
- `from './userscript-download'` → `from '@main/modules/userscripts/userscript-download'`

- [ ] **Step 3: 验证**

```bash
npx tsc -p tsconfig.main.json --noEmit
npx vitest run tests/userscripts
```
Expected: 无类型错误;单测全过。注意 request/download 的 service 本体(import electron `net`)不被 vitest 直接测试——由 Task 5/6 的 smoke 覆盖。

- [ ] **Step 4: 提交**

```bash
git add src/main/modules/userscripts tests/userscripts
git commit -m "feat(userscripts): 移植服务层 (require-cache/request/download)"
```

---

### Task 3: manager 移植

**Files:**
- Create: `src/main/modules/userscripts/userscript-manager.ts`
- Test: `tests/userscripts/userscript-manager.test.ts`、`userscript-manager-values.test.ts`、`userscript-manager-require.test.ts`

**Interfaces:**
- Consumes: Task 1(types/matcher/store)、Task 2(RequireCache)
- Produces:
  - `class UserscriptManager`(demo 实现原样):`loadScripts`、`registerView`、`unregisterView`、`snapshotFor`、`acceptReport`、`commandsFor`、`registerMenuCommand`、`unregisterMenuCommand`、`getValueSnapshot`、`setValue`、`deleteValue`、`addValueListener`、`removeValueListener`、`notify`、`getNotifications`、`openInTab`、`getOpenTabs`、`getRequireGaps`、`isScriptInstalled`、`getScriptMetadata`、`ensureRequires`、`spaNavigate`、`getSpaNavigations`、`getReports`

- [ ] **Step 1: 复制 manager 并调整 import**

`tests/electron/userscripts/userscript-manager.ts` → `src/main/modules/userscripts/userscript-manager.ts` 原样复制。import 调整:
- `from './userscript-types'` → `from '../../shared/userscript-types'`
- `from './userscript-matcher'` → `from './userscript-matcher'`(同目录,不变)
- `from './userscript-store'` → `from './userscript-store'`(不变)
- `from './userscript-require-cache'` → `from './userscript-require-cache'`(不变)

- [ ] **Step 2: 迁移 3 组单测并改 import**

复制 `tests/electron/userscripts/userscript-manager.test.ts`、`userscript-manager-values.test.ts`、`userscript-manager-require.test.ts` → `tests/userscripts/`。import 调整:
- `from './userscript-manager'` → `from '@main/modules/userscripts/userscript-manager'`
- `from './userscript-store'` → `from '@main/modules/userscripts/userscript-store'`
- `from './userscript-values'` → `from '@main/modules/userscripts/userscript-values'`
- `from './userscript-require-cache'` → `from '@main/modules/userscripts/userscript-require-cache'`
- `from './userscript-types'`(若有)→ `from '@shared/userscript-types'`

- [ ] **Step 3: 验证**

```bash
npx tsc -p tsconfig.main.json --noEmit
npx vitest run tests/userscripts
```
Expected: 无类型错误;manager 三组单测全过。

- [ ] **Step 4: 提交**

```bash
git add src/main/modules/userscripts/userscript-manager.ts tests/userscripts
git commit -m "feat(userscripts): 移植 manager (快照/报告/命令/值监听/SPA 记录)"
```

---

### Task 4: preload 运行时移植与 webview-preload 集成

**Files:**
- Create: `src/webview-preload/userscripts/scheduler.ts`、`sandbox.ts`、`gm-api.ts`、`page-bridge.ts`、`unsafe-proxy.ts`、`bootstrap.ts`
- Modify: `src/webview-preload/index.ts`(集成入口)
- Modify: `src/main/modules/tabs.ts:113-121`(`_createView` 加 `nodeIntegrationInSubFrames`)

**Interfaces:**
- Consumes: Task 1 的 `src/shared/userscript-types.ts`(FrameSnapshot/SnapshotScript);现有 `get-ruffle-mode` IPC(提供 mode 判定依据)
- Produces:
  - `bootstrap.ts` 导出 `initUserscriptRuntime(): void`(原 demo bootstrap 顶层逻辑的封装,由 index.ts 调用)
  - `PAGE_BRIDGE_SOURCE`(page-bridge,主世界桥源码字符串)
  - `createUnsafeWindowProxy(window: Window): unknown`(unsafe-proxy)
  - `scheduleScripts(scripts: SnapshotScript[], host: SchedulerHost): void`、`runAtPriority(runAt): number`(scheduler)
  - `executeUserscript(source: string, host: SandboxHost): ExecutionResult`(sandbox)
  - `createGmApi(opts): GmApi`(gm-api)

- [ ] **Step 1: 复制 6 个 preload 模块并调整 import**

原样复制 `tests/electron/userscripts/preload/` 下全部 6 个文件到 `src/webview-preload/userscripts/`。import 调整:
- `bootstrap.ts`:
  - 整体改为导出函数形式——把原顶层逻辑(`const documentId = ...` 到文件尾的 `scheduleScripts(...)`)包进 `export function initUserscriptRuntime(): void { ... }`,文件顶部保留 import。**关键**：原 `scheduleScripts(scripts, {...})` 调用块原样移入函数体;`const unsafeWindow`/`createUnsafeWindowProxy`/`webFrame.executeJavaScript` 注入逻辑原样保留。
  - `import type { FrameSnapshot } from '../userscript-types';` → `import type { FrameSnapshot } from '../../../shared/userscript-types';`
  - `import { scheduleScripts } from './scheduler';`(同目录,不变)
  - `import { PAGE_BRIDGE_SOURCE, BRIDGE_MARKER } from './page-bridge';`(不变)
- `scheduler.ts` / `sandbox.ts` / `gm-api.ts` / `page-bridge.ts` / `unsafe-proxy.ts`:types import `'../userscript-types'` → `'../../../shared/userscript-types'`(仅 types;gm-api 内 `./scheduler`、`./sandbox` 等相对导入不变)。

- [ ] **Step 2: 集成到 webview-preload/index.ts**

在 `src/webview-preload/index.ts` 文件**末尾追加**(PPAPI 分支之后、文件结尾),复用文件内既有 `require` 风格(避免顶层静态 import 改变时序):

```ts
// --- Userscript runtime bootstrap (main frame and subframes) ---
(function () {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { initUserscriptRuntime } = require('./userscripts/bootstrap');
    initUserscriptRuntime();
  } catch { /* userscript runtime must never break the page */ }
})();
```

- [ ] **Step 3: tabs.ts 打开子框架 Node 注入(评审清单)**

`src/main/modules/tabs.ts` `_createView`(113-121 行)的 `webPreferences` 增加一行:

```ts
    const view = new BrowserView({
      webPreferences: {
        preload: this.preloadPath,
        plugins: !tab.isRuffle,
        contextIsolation: !tab.isRuffle,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: true,   // userscript runtime needs subframe preload
        partition: 'persist:',
      },
    });
```

- [ ] **Step 4: 验证**

```bash
npx tsc -p tsconfig.preload.json --noEmit
npx tsc -p tsconfig.main.json --noEmit
node esbuild.main.config.mjs
```
Expected: 无类型错误;`dist/webview-preload.js` 构建成功且包含 userscript bootstrap(检查产物中 `userscript:get-config` 字符串)。

- [ ] **Step 5: 提交**

```bash
git add src/webview-preload src/main/modules/tabs.ts
git commit -m "feat(userscripts): 移植 preload 运行时并集成到 webview-preload (含页世界桥)"
```

---

### Task 5: 主进程接线(manager 单例 + IPC + tabs 生命周期)

**Files:**
- Create: `src/main/modules/userscripts/index.ts`(manager 单例工厂)
- Create: `src/main/ipc/userscripts.ipc.ts`
- Modify: `src/main/index.ts`(注册 IPC 与初始化)
- Modify: `src/main/modules/tabs.ts`(view 生命周期 register/unregister、SPA 记录)

**Interfaces:**
- Consumes: Task 2/3(服务类、manager)、Task 4(preload 通道)、现有 `ipc-wrapper`(`src/main/utils/ipc-wrapper.ts` 的 `createValidatedHandler`)
- Produces:
  - `userscripts/index.ts` 导出 `initUserscriptManager(): UserscriptManager`(幂等,单例)与 `getUserscriptManager(): UserscriptManager | null`
  - `userscripts.ipc.ts` 导出 `registerUserscriptsIPC(): void`
  - tabs.ts:`_createView` 内 `getUserscriptManager()?.registerView(wc.id, { mode: tab.isRuffle ? 'ruffle' : 'ppapi', generation: ++this.userscriptGeneration, token: tab.id })`;`_wireBrowserViewEvents` 内 `wc.on('destroyed', () => getUserscriptManager()?.unregisterView(wc.id))` 与 `wc.on('did-navigate-in-page', (_e, url, isMainFrame) => { if (isMainFrame) getUserscriptManager()?.spaNavigate(wc.id, url, 'in-page'); })`

- [ ] **Step 1: 创建 manager 单例工厂**

`src/main/modules/userscripts/index.ts`(完整内容):

```ts
// Userscript runtime wiring: single manager instance for the app, created
// once at startup. Value persistence (stage 2 management UI) intentionally
// starts in-memory; request/download services use the persist: session.

import { session } from 'electron';
import path from 'path';
import { app } from 'electron';
import { net } from 'electron';
import { UserscriptManager } from './userscript-manager';
import { ValueStore } from './userscript-store';
import { RequireCache } from './userscript-require-cache';
import { GmRequestService } from './userscript-request-service';
import { GmDownloadService } from './userscript-download-service';

let manager: UserscriptManager | null = null;

export function initUserscriptManager(): UserscriptManager {
  if (manager) return manager;
  const persist = session.fromPartition('persist:');
  const requireCache = new RequireCache({
    fetcher: async (url) => {
      const response = await net.fetch(url);
      if (!response.ok) throw new Error(`require fetch failed: HTTP ${response.status}`);
      return response.text();
    },
  });
  manager = new UserscriptManager(new ValueStore(), {
    requireCache,
    sendToWc: (wcId, channel, payload) => {
      try { session.fromPartition('persist:').getUserAgent(); } catch { /* noop */ }
      for (const wc of session.fromPartition('persist:').webContents ?? []) {
        if (wc.id === wcId) wc.send(channel, payload);
      }
    },
  });
  void requestService;
  void downloadService;
  return manager;
}

export function getUserscriptManager(): UserscriptManager | null {
  return manager;
}
```

> 注意:`sendToWc` 按 wcId 定向投递。Electron 11 无遍历 webContents 的 session API 时,改用 `tabManager` 提供按 wcId 查询——实现时若 `session.fromPartition('persist:').webContents` 不存在,改为在 `tabs.ts` 暴露 `sendToWc(wcId, channel, payload)` 并在 `index.ts` 注册时注入(与 demo smoke 的 `wcRegistry` 同构)。两个服务(GmRequestService/GmDownloadService)实例化的 session/allowedLoopbackHosts 参数沿用 demo smoke 值:`allowedLoopbackHosts: ['127.0.0.1', 'localhost']`、`maxRedirects: 5`、`maxResponseBytes: 32 * 1024`、`defaultTimeoutMs: 3000`、`maxConcurrentPerScript: 2`、`maxConcurrentGlobal: 8`;下载 `maxBytes: 8 * 1024`、目录 `path.join(app.getPath('userData'), 'userscript-downloads')`(mkdirSync recursive)。

- [ ] **Step 2: 创建 IPC 注册文件**

`src/main/ipc/userscripts.ipc.ts`(完整实现,通道与 demo `registerIpc` 一一对应,zod 校验):

```ts
import { clipboard, ipcMain } from 'electron';
import { z } from 'zod';
import { createValidatedHandler } from '../utils/ipc-wrapper';
import log from 'electron-log';
import { getUserscriptManager } from '../modules/userscripts';
import type { UserscriptReport } from '../../shared/userscript-types';

export function registerUserscriptsIPC(): void {
  const manager = () => getUserscriptManager();

  // Sync snapshot: preload asks at document start; response bounded by the
  // manager's snapshot budget (maxSnapshotBytes).
  ipcMain.on('userscript:get-config', (event, payload: unknown) => {
    const active = manager();
    if (!active) { event.returnValue = { ok: false, scripts: [], values: {} }; return; }
    const parsed = z.object({ url: z.string(), isMainFrame: z.boolean(), documentId: z.string() }).safeParse(payload);
    if (!parsed.success) { event.returnValue = { ok: false, scripts: [], values: {} }; return; }
    event.returnValue = active.snapshotFor(event.sender.id, parsed.data.url, parsed.data.isMainFrame);
  });

  const reportSchema = z.object({
    documentId: z.string(),
    frameUrl: z.string(),
    isMainFrame: z.boolean(),
    mode: z.enum(['ppapi', 'ruffle']),
    generation: z.number(),
    phase: z.string(),
    detail: z.unknown().optional(),
  });
  ipcMain.on('userscript:report', (event, payload: unknown) => {
    const active = manager();
    const parsed = reportSchema.safeParse(payload);
    if (!active || !parsed.success) return;
    active.acceptReport(event.sender.id, parsed.data as unknown as UserscriptReport);
  });

  const setValueSchema = z.object({ scriptId: z.string(), key: z.string(), value: z.unknown() });
  ipcMain.on('userscript:set-value', (event, payload: unknown) => {
    const active = manager(); const parsed = setValueSchema.safeParse(payload);
    if (!active || !parsed.success) return;
    if (active.isScriptInstalled(parsed.data.scriptId) && parsed.data.key) {
      active.setValue(event.sender.id, parsed.data.scriptId, parsed.data.key, parsed.data.value);
    }
  });

  ipcMain.on('userscript:delete-value', (event, payload: unknown) => {
    const active = manager(); const parsed = setValueSchema.pick({ scriptId: true, key: true }).safeParse(payload);
    if (!active || !parsed.success) return;
    active.deleteValue(event.sender.id, parsed.data.scriptId, parsed.data.key);
  });

  const menuSchema = z.object({ commandId: z.string(), scriptId: z.string(), documentId: z.string(), title: z.string() });
  ipcMain.on('userscript:menu-register', (event, payload: unknown) => {
    const active = manager(); const parsed = menuSchema.safeParse(payload);
    if (!active || !parsed.success) return;
    active.registerMenuCommand(event.sender.id, parsed.data.scriptId, parsed.data.documentId, parsed.data.title, parsed.data.commandId);
  });

  ipcMain.on('userscript:menu-unregister', (event, payload: unknown) => {
    const active = manager(); const parsed = z.object({ commandId: z.string() }).safeParse(payload);
    if (!active || !parsed.success) return;
    active.unregisterMenuCommand(event.sender.id, parsed.data.commandId);
  });

  ipcMain.on('userscript:open-in-tab', (event, payload: unknown) => {
    const active = manager(); const parsed = z.object({ scriptId: z.string(), url: z.string() }).safeParse(payload);
    if (!active || !parsed.success) return;
    active.openInTab(event.sender.id, parsed.data.scriptId, parsed.data.url);
  });

  ipcMain.on('userscript:menu-invoked', (event, payload: unknown) => {
    const active = manager();
    const parsed = z.object({ documentId: z.string(), scriptId: z.string(), commandId: z.string() }).safeParse(payload);
    if (!active || !parsed.success) return;
    const registration = active.getRegistration(event.sender.id);
    if (!registration) return;
    const report: UserscriptReport = {
      documentId: parsed.data.documentId, frameUrl: '', isMainFrame: false,
      mode: registration.mode, generation: registration.generation,
      scriptId: parsed.data.scriptId, phase: 'menu-command-invoked', ok: true,
      detail: { commandId: parsed.data.commandId },
    };
    active.acceptReport(event.sender.id, report);
  });

  const listenerSchema = z.object({ scriptId: z.string(), key: z.string(), listenerId: z.number() });
  ipcMain.on('userscript:value-listener-add', (event, payload: unknown) => {
    const active = manager(); const parsed = listenerSchema.safeParse(payload);
    if (!active || !parsed.success) return;
    active.addValueListener(event.sender.id, parsed.data.scriptId, parsed.data.key, parsed.data.listenerId);
  });

  ipcMain.on('userscript:value-listener-remove', (event, payload: unknown) => {
    const active = manager(); const parsed = listenerSchema.pick({ scriptId: true, listenerId: true }).safeParse(payload);
    if (!active || !parsed.success) return;
    active.removeValueListener(event.sender.id, parsed.data.scriptId, parsed.data.listenerId);
  });

  ipcMain.handle('userscript:set-clipboard', async (_event, payload: unknown) => {
    if (!manager()) return { ok: false };
    const parsed = z.object({ text: z.string().max(1024 * 1024) }).safeParse(payload);
    if (!parsed.success) return { ok: false };
    clipboard.writeText(parsed.data.text);
    return { ok: true };
  });

  ipcMain.handle('userscript:notification', async (event, payload: unknown) => {
    const active = manager();
    const parsed = z.object({ scriptId: z.string(), documentId: z.string(), text: z.string().optional(), title: z.string().optional() }).safeParse(payload);
    if (!active || !parsed.success) return { ok: false };
    const notificationId = active.notify(event.sender.id, parsed.data.scriptId, parsed.data.documentId, { text: parsed.data.text, title: parsed.data.title });
    return { ok: notificationId !== null, notificationId };
  });

  ipcMain.handle('userscript:download', async (event, payload: unknown) => {
    const active = manager();
    const parsed = z.object({ scriptId: z.string(), pageUrl: z.string(), details: z.unknown(), localId: z.number() }).safeParse(payload);
    if (!active || !parsed.success) return { ok: false, error: 'invalid-arguments' };
    const metadata = active.getScriptMetadata(parsed.data.scriptId);
    if (!metadata) return { ok: false, error: 'invalid-arguments' };
    return downloadService().download(event.sender.id, parsed.data.scriptId, parsed.data.pageUrl, metadata.metadata.connect, parsed.data.details, parsed.data.localId);
  });

  ipcMain.on('userscript:download-abort', (event, payload: unknown) => {
    const parsed = z.object({ localId: z.number() }).safeParse(payload);
    if (parsed.success) downloadService().abort(event.sender.id, parsed.data.localId);
  });

  ipcMain.handle('userscript:xhr-request', async (event, payload: unknown) => {
    const active = manager();
    const parsed = z.object({ scriptId: z.string(), pageUrl: z.string(), details: z.unknown(), localId: z.number() }).safeParse(payload);
    if (!active || !parsed.success) return { ok: false, error: 'invalid-arguments' };
    const metadata = active.getScriptMetadata(parsed.data.scriptId);
    if (!metadata) return { ok: false, error: 'invalid-arguments' };
    return requestService().request(event.sender.id, parsed.data.scriptId, parsed.data.pageUrl, metadata.metadata.connect, parsed.data.details, parsed.data.localId);
  });

  ipcMain.on('userscript:xhr-abort', (event, payload: unknown) => {
    const parsed = z.object({ localId: z.number() }).safeParse(payload);
    if (parsed.success) requestService().abort(event.sender.id, parsed.data.localId);
  });
}

// Services are instantiated alongside the manager (Task 5 Step 1); these
// helpers return them. Keep in this file or move into modules/userscripts/index.ts.
function requestService() { /* returns the singleton GmRequestService */ }
function downloadService() { /* returns the singleton GmDownloadService */ }
```

> 实现提示:`requestService()`/`downloadService()` 两个辅助函数应返回 Task 5 Step 1 中实例化的单例(在 `modules/userscripts/index.ts` 导出 `getRequestService()`/`getDownloadService()`,本文件 import 使用;上文的占位辅助仅为示意,不要保留 `/* ... */` 占位)。`createValidatedHandler` 如不适用于 `ipcMain.on` 同步通道,可沿用本文件所示的手动 safeParse 模式(与 `tabs.ipc.ts` 的 `ruffleDiagnostic` 一致)。

- [ ] **Step 3: tabs.ts 生命周期接线**

在 `src/main/modules/tabs.ts`:
1. 顶部 import:`import { getUserscriptManager } from './userscripts';`(模块同目录 `src/main/modules/`)
2. `_createView` 中 `this.wcToId.set(wc.id, tab.id);` 之后加:

```ts
    getUserscriptManager()?.registerView(wc.id, {
      mode: tab.isRuffle ? 'ruffle' : 'ppapi',
      generation: (this.userscriptGeneration = (this.userscriptGeneration ?? 0) + 1),
      token: tab.id,
    });
```

3. 类字段区(`private preloadPath = '';` 附近)加:`private userscriptGeneration = 0;`
4. `_wireBrowserViewEvents` 中 `wc.on('page-title-updated', ...)` 之前加:

```ts
    wc.on('destroyed', () => getUserscriptManager()?.unregisterView(wc.id));
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) getUserscriptManager()?.spaNavigate(wc.id, url, 'in-page');
    });
```

- [ ] **Step 4: 注册到主进程入口**

`src/main/index.ts`:
1. import 区加:`import { registerUserscriptsIPC } from './ipc/userscripts.ipc';` 与 `import { initUserscriptManager } from './modules/userscripts';`
2. `app.whenReady().then()` 内、`registerWindowIPC(...)` 附近加:

```ts
  initUserscriptManager();
  registerUserscriptsIPC();
```

- [ ] **Step 5: 验证**

```bash
npx tsc -p tsconfig.main.json --noEmit
npx tsc -p tsconfig.preload.json --noEmit
node esbuild.main.config.mjs
npm run test:electron
npm run test:ruffle
npm run test:compat
npm test -- --run
```
Expected: 类型全过;构建成功;三个 Electron smoke 与全部单测**不回归**(此时用户脚本尚未有脚本可跑,通道注册为空操作不影响现有行为)。

- [ ] **Step 6: 提交**

```bash
git add src/main/index.ts src/main/modules/userscripts src/main/ipc/userscripts.ipc.ts src/main/modules/tabs.ts
git commit -m "feat(userscripts): 主进程接线 (manager 单例/IPC 全通道/tabs 生命周期/SPA 记录)"
```

---

### Task 6: smoke 集成(指向主项目模块)

**Files:**
- Modify: `tests/electron/build-userscript-runtime-smoke.mjs`
- Modify: `tests/electron/userscript-runtime-smoke.ts`

**Interfaces:**
- Consumes: Task 3/5 的全部主项目模块、Task 4 的 preload bundle 路径
- Produces: 指向主项目实现的完整回归(143 required checks)

- [ ] **Step 1: 改造构建脚本**

`tests/electron/build-userscript-runtime-smoke.mjs`:
1. preload 入口从 `tests/electron/userscripts/preload/bootstrap.ts` 改为 **`src/webview-preload/index.ts`**(真实完整 preload,含 Ruffle/PPAPI shim + 用户脚本运行时):
   `entryPoints: ['src/webview-preload/index.ts']`,`outfile: 'release/tests/userscript-runtime-preload.cjs'`(其余 shared 配置不变)。
2. smoke 入口的 alias 已有 `@shared`/`@main`,保持;删除旧的 `stub-download-manager` 插件(其过滤 `^\.\/download$` 已不适用——主项目 download 模块路径不同)。

- [ ] **Step 2: 改造 smoke 模块导入**

`tests/electron/userscript-runtime-smoke.ts` 中所有 `from './userscripts/userscript-*'` 改为:
- `UserscriptManager` → `from '@main/modules/userscripts/userscript-manager'`
- `ValueStore` → `from '@main/modules/userscripts/userscript-store'`
- `parseUserscriptMetadata` → `from '@main/modules/userscripts/userscript-parser'`
- `GmRequestService`/`GmRequestResult` → `from '@main/modules/userscripts/userscript-request-service'`
- `GmDownloadService` → `from '@main/modules/userscripts/userscript-download-service'`
- `RequireCache` → `from '@main/modules/userscripts/userscript-require-cache'`
- `InstalledUserscript`/`UserscriptReport` → `from '@shared/userscript-types'`
- `PAGE_BRIDGE_SOURCE`/`BRIDGE_MARKER` → `from '@main/modules/../webview-preload/userscripts/page-bridge'`(esbuild alias 不支持,改用相对路径 `'../../src/webview-preload/userscripts/page-bridge'`)

smoke 内部其余逻辑(fixtures、runMode、桥检查、SPA 检查、真实脚本)不动——它们测的就是这些模块的行为。

- [ ] **Step 3: 验证**

```bash
npm run test:userscripts
```
Expected: `SUMMARY {"required":"143/143",...,"decision":"CONTINUE"}`(switch-zh PASS、SPA/桥检查全过;mpiv/mouse-gestures/picviewer 为 optional 记录)。

- [ ] **Step 4: 提交**

```bash
git add tests/electron/build-userscript-runtime-smoke.mjs tests/electron/userscript-runtime-smoke.ts
git commit -m "test(userscripts): smoke 指向主项目模块 (preload 全量 + @main 导入)"
```

---

### Task 7: 收尾(文档、demo 清理策略、全量检查)

**Files:**
- Modify: `docs/userscript-runtime-demo-results.md`(移植完成记录)
- Modify: `docs/architecture-manual.md`(新增"用户脚本运行时"章节)
- Modify: `AGENTS.md`(Key files 更新 + 新 landmine 条目)
- Modify: 无(如批次 6 全绿,可删除 `tests/electron/userscripts/` 与旧 fixture 构建引用——**由用户确认后再删,默认保留**)

- [ ] **Step 1: 文档更新**

`docs/architecture-manual.md` 新增章节(§4.x 之后追加,或按现有结构编号):
- 模块清单(`src/main/modules/userscripts/*`、`src/webview-preload/userscripts/*`、`src/shared/userscript-types.ts`)
- 执行模型摘要:快照预算(64KB)、每页源预算(512KB)、词法注入、ppapi stripNodeGlobals/ruffle vm 回退
- 页世界桥:`webFrame.executeJavaScript` 注入主世界 + postMessage 协议(reply 标记防循环、expected 配对、握手队列)
- SPA:`did-navigate-in-page` → `spaNavigate` 记录,不重跑

`AGENTS.md`:
- Key files 表新增两行:`src/main/modules/userscripts/`(运行时主进程服务)、`src/webview-preload/userscripts/`(preload 调度/沙箱/页世界桥)
- Landmines 新增:
  - `userscript 页世界桥注入必须走 preload webFrame.executeJavaScript;CDP addScriptToEvaluateOnNewDocument 的注册随 detach 清除,attach 期间导航冻结`
  - `SPA 软导航不创建 document——脚本不重跑;URL 变化经 did-navigate-in-page 记录(勿在 preload 里 patch history)`

`docs/userscript-runtime-demo-results.md` 末尾追加"移植完成记录":批次列表、验证数字、demo 目录保留/删除决定。

- [ ] **Step 2: 全量检查**

```bash
npm run check
```
Expected: i18n + typecheck(三项目)+ lint + vitest 全绿 + 生产构建成功。

- [ ] **Step 3: 提交**

```bash
git add docs/architecture-manual.md docs/userscript-runtime-demo-results.md AGENTS.md
git commit -m "docs(userscripts): 移植完成记录与运行时架构文档"
```

---

## Self-Review 记录

- **Spec coverage(移植前置条件清单核对)**:评审三条已覆盖——① 修复随模块继承(全部原样复制,零行为改动)✅;② `_createView` 加 `nodeIntegrationInSubFrames: true`(Task 4 Step 3)✅、webview-preload 加固(集成放在 IIFE 分支后,失败不阻断页面)✅;③ IPC 用 zod(userscripts.ipc.ts 全通道 safeParse)✅、`get-config` sendSync 且响应受 snapshot 预算限制(manager 原样)✅。
- **Placeholder scan**:Task 5 的 IPC 文件与 index.ts 中有两处示意性占位(`requestService()`/`downloadService()` 辅助与 `sendToWc` 遍历),已在"实现提示"中明确要求落地为 `modules/userscripts/index.ts` 的单例导出——执行时按提示落实,不留 `/* */` 占位。
- **Type consistency**:IPC 通道名、manager 方法名与 demo `registerIpc` 完全一致;Task 4 导出的 `initUserscriptRuntime` 与 Task 4 Step 2 的 require 调用一致;`spaNavigate` 签名跨 Task 3(demo 已有)/Task 5(接线)一致。

## 回滚策略(用户要求)

- 每批独立提交;任一批验证失败时 `git revert <批次 commit>` 即可回到上一稳定态。
- 批次 6 之前 demo 文件(`tests/electron/userscripts/`)原样保留,随时可对照/回退。
- Task 7 中删除 demo 目录是**可选步骤**,默认不删,由用户确认。
