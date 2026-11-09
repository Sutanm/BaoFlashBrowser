# 多窗口改造计划书（对齐 Chrome 行为）

- 状态：**可行性已验证，待确认开工**（v6：7 个阶段探测全部通过，8.0 节有实测数据）
- 适用版本：BaoFlashBrowser 1.1.2（Electron 11.5.0 / Chromium 87，版本锁定）
- 文档定位：Spec + Design + Tasks 三合一，审核通过后按第 7 节顺序实施
- 关联代码：`src/main/index.ts`、`src/main/modules/window.ts`、`src/main/modules/tabs.ts`、`src/main/ipc/`、`src/renderer/hooks/useTabManager.ts`、`src/renderer/App.tsx`

---

## 0. 一页摘要

**问题**：再次双击图标时，第二个进程被单实例锁拦下并退出，已有进程只做 `restore + focus`，用户没有任何可见反馈；同时不支持多窗口。

**结论**：可以对齐 Chrome，且**不需要推翻重来**。Chrome 的真实模型是"单进程 + 多窗口 + 共享 profile"，本项目的 `TabManager` 状态本就全在实例字段上，改造重点是"把它从单例变成一窗口一实例"。

**改造规模**：

| 维度 | 数量 |
| --- | --- |
| 直接改动文件 | 约 22 个 |
| 新增文件 | 3 个（窗口状态持久化、IPC 工厂扩展、单元测试） |
| 需要适配的调用点 | `getMainWindow()` 36 处 / `tabManager.*` 60 处 / `tab:*` 通道约 20 个 |
| 行为分水岭 | 阶段 P3（TabManager 多实例化）；P1/P2 对外行为不变 |

**核心风险**：事件串窗、关窗误判"正常退出"、CredUI 属主挂错窗口。三者都有明确对策（见第 9 节）。

**可行性状态**：已在 Electron 11.5.0 实测 7 个阶段探测，**全部通过**（见 8.0 节）。其中最高风险的"跨窗口迁移不重载页面"已用 `probe 40` 证明成立。

---

## 1. 背景与问题定义

### 1.1 现状

- `app.requestSingleInstanceLock()` 在 `src/main/index.ts:30` 已生效：二次启动的进程会立即 `app.quit()`。
- `second-instance` 处理器只做 `restore + focus`（`src/main/index.ts:35-41`），若窗口已在前台则表现为"点了没反应"。
- `src/main/modules/window.ts` 只有一个模块级 `mainWindow`，`getMainWindow()` 返回它。
- `src/main/modules/tabs.ts` 的 `TabManager` 被导出为全局单例（第 812 行），内部 5 处硬编码 `getMainWindow()`（358 / 421 / 583 / 663 / 808 行）。

### 1.2 对 Chrome 行为的澄清

Chrome / Edge 双击图标**不会**启动第二个浏览器进程。真实链路是：

1. 新进程启动，ProcessSingleton 发现已有实例；
2. 把命令行转交给已有进程；
3. 新进程退出；
4. 已有进程新建一个窗口。

任务管理器中的多个 `chrome.exe` 是渲染 / GPU / 网络子进程，属于多进程渲染架构。本项目的 BrowserView 已经是一标签一渲染进程，与该模型一致。

### 1.3 为什么现在的架构适合改造

`TabManager` 的 `tabs` / `wcToId` / `activeId` / `rect` / `automationTargets` 全部是实例字段（`src/main/modules/tabs.ts:104-115`），没有模块级可变状态。也就是说"一窗口一实例"在类设计上是现成支持的，缺的只是归属层与路由层。

---

## 2. 需求

### 2.1 用户故事

- 作为用户，我在应用运行时再次双击图标，希望像 Chrome 一样多出一个窗口，而不是毫无反应。
- 作为用户，我关掉其中一个窗口时，不希望另一个窗口的页面或下载被打断。
- 作为用户，我在一个窗口登录过的网站，另一个窗口打开时应保持登录。
- 作为用户，我上次开了两个窗口，希望下次启动时按原样恢复。

### 2.2 功能需求与验收标准

| 编号 | 需求 | 验收标准（可观测） |
| --- | --- | --- |
| R1 | 二次启动新建窗口 | 运行中再次双击图标 → 新窗口出现并获得焦点；任务管理器无第二个主进程 |
| R2 | 窗口状态隔离 | 两窗口各自增删标签、切换活动标签、调整窗口大小；BrowserView 只出现在所属窗口，位置正确 |
| R3 | profile 共享 | 窗口 A 登录后，窗口 B 打开同站点保持登录；密码库、下载列表全局一致 |
| R4 | 窗口生命周期 | 关闭 A 只销毁 A 的标签，B 正常；关闭最后一个窗口后进程退出（Windows/Linux）；macOS 关完不退出 |
| R5 | 事件路由 | A 的标签事件不出现在 B 的标签栏；A 的页面标题/加载态变化不触发 B 的 UI 更新 |
| R6 | 会话恢复 | 两窗口各带标签退出后重启，恢复为两个窗口，标签归属与顺序正确 |
| R7 | 横切功能定位正确 | 截图、自动化、开发者工具箱、密码填充、内存监控作用于正确的窗口或 tab |
| R8 | 标签拖出成新窗口（tear-off） | 拖动标签离开标签栏并释放 → 生成新窗口；页面不重载，加载/播放状态不中断 |
| R9 | 标签跨窗口移动 | 从窗口 A 拖到窗口 B 标签栏并释放 → 标签出现在 B、从 A 消失，页面不重载 |

### 2.3 非目标（本期明确不做）

| 项 | 原因 |
| --- | --- |
| 每窗口独立 `userDataDir` 的多实例 | 会撕裂密码库、下载目录、自动化租约与 DevTools 端口发现；Chrome 也不这么做 |
| 每窗口独立浏览器进程 | 与 Chromium profile 锁冲突，且无收益 |
| 窗口间标签实时同步 | Chrome 本身也不做 |

---

## 3. 现状与影响面

| 位置 | 现状 | 需要的改动 | 规模 |
| --- | --- | --- | --- |
| `modules/window.ts` | 单例 `mainWindow`；每窗口 `close` 都 `markCleanShutdown()` | 注册表 + 兼容 shim + 生命周期上移 | M |
| `modules/session-recovery.ts` | 提供 `markCleanShutdown()` | 仅调整调用时机，不改实现 | S |
| `modules/tabs.ts` | 单例、5 处硬编码宿主窗口、`send` 只发主窗口 | 注入窗口解析器、全局索引、facade | L |
| `utils/ipc-wrapper.ts` | `createHandler` 丢弃 `event` | 新增带事件上下文的工厂 | S |
| `ipc/window.ipc.ts` | 通过 provider 拿唯一窗口 | 按 `event.sender` 路由 | S |
| `ipc/tabs.ipc.ts` | 约 20 个通道直调全局单例 | 按 sender / tabId 归属路由 | M |
| `ipc/shortcut.ipc.ts` | `before-input-event` 把动作发给 `getMainWindow()` | 发给触发事件的 WebContents 所属窗口 | S |
| `ipc/password.ipc.ts` | 调全局 `tabManager` | 走 facade（多数无需改） | S |
| `ipc/automation-v3.ipc.ts` | tabId 解析走单例 | 走全局索引 | S |
| `modules/screenshot.ts` / `screenshot-http.ts` | 取主窗口 + 单活动 tab | 按 tab 归属窗口取 `rect` / 最小化状态 | M |
| `modules/devtoolbox-*.ts` | 桥单例，`targetId` 单值 | 按窗口隔离 | M |
| `modules/password-capture.ts` / `view-gate-win` 调用点 | 属主 HWND 取主窗口 | 取发起请求的窗口 | S |
| `modules/download.ts` | 事件只发主窗口 | 广播所有窗口 | S |
| `modules/memory-monitor.ts` | 聚合单例诊断 | 聚合所有窗口 + 全局挂起预算 | S |
| `ipc/userscripts-admin.ipc.ts` | 已带 tabId | 走全局索引 | S |
| `renderer/hooks/useTabManager.ts` | 全局会话 key | 按窗口 key 分片 + 旧数据迁移 | M |
| `renderer/App.tsx` | `new-window` 快捷键动作**未处理**（按了无反应） | 接入新建窗口 | S |
| `preload/index.ts` | 无窗口上下文通道 | 新增 `win:get-context` / `win:new-window` | S |

---

## 4. 方案选型

| 方案 | 描述 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- | --- |
| A. 保持单窗口 | 二次启动只在现有窗口开新标签 | 十几行代码 | 不满足"多开窗口"，仍无法并排对照两个页面 | 否决（作为降级保底） |
| **B. 单进程多窗口 + 共享 profile** | 一个主进程，多个 BrowserWindow，各自标签栏 | 与 Chrome 完全一致；登录态/密码/下载共享；实现成本可控 | 需要重做窗口归属与 IPC 路由 | **采用** |
| C. 多进程多实例（独立 userData） | 每次启动一个完整进程 | 看似"最像多开" | 登录态不共享；密码库/下载/自动化租约互相踩踏；Chromium profile 锁冲突 | 否决 |

选型依据：用户诉求是"像 Chrome 一样多开窗口"，而 Chrome 本身是方案 B。方案 C 与需求描述字面相近但工程上是倒退。

---

## 5. 目标架构

### 5.1 AS-IS

```
app (单进程)
 └─ mainWindow (单例)
     ├─ shell renderer (React: 标签栏/地址栏/面板)
     └─ TabManager (全局单例)
         ├─ BrowserView(tab1) ── persist: 分区
         ├─ BrowserView(tab2)
         └─ send() ──▶ getMainWindow()
```

### 5.2 TO-BE

```
app (单进程, requestSingleInstanceLock 保留)
 ├─ WindowRegistry: Map<runtimeWindowId, BrowserWindow>
 │    └─ 每个窗口持有稳定 windowKey（跨重启不变）
 ├─ window#1 ↔ TabManager#1 ── BrowserView(tab1..n) → send 到窗口#1
 ├─ window#2 ↔ TabManager#2 ── BrowserView(tab1..m) → send 到窗口#2
 ├─ 全局索引: tabId → TabManager, wcId → TabManager
 ├─ 共享: persist: 分区 / Cookie / 密码库 / 下载目录 / 自动化资源
 └─ second-instance ──▶ createWindow()（不再只 focus）
```

### 5.3 关键原则

1. **窗口是内容归属单位**，tab 一经创建就属于某个窗口，本期不允许迁移。
2. **运行时 id 与持久化 key 分离**：`BrowserWindow.id` 只在本次进程内有效；`windowKey`（nanoid）用于会话与几何持久化。
3. **推送事件带归属**：所有 `tab:*` 推送只发给 tab 所属窗口。
4. **跨窗口只读共享**：下载列表、密码库的读取全局可见，写入仍走既有通道。

---

## 6. 详细设计

### 6.1 窗口注册表（`src/main/modules/window.ts`）

新增/调整的导出：

| 接口 | 语义 |
| --- | --- |
| `createWindow(options?: CreateWindowOptions): BrowserWindow` | 可多次调用；注册并返回 |
| `getWindowById(id: number): BrowserWindow \| null` | 运行时 id 查找 |
| `getRegisteredWindows(): BrowserWindow[]` | 仅浏览器窗口，**不含**用户脚本后台隐藏窗口与 DevTools 窗口 |
| `getWindowForWebContents(wc): BrowserWindow \| null` | 用于 IPC 与快捷键路由 |
| `getMainWindow(): BrowserWindow \| null` | **兼容 shim**：最近聚焦的已注册窗口，退化为首个注册窗口 |
| `getWindowKey(win): string` | 稳定 key |

实现要点：

- 显式注册表，**禁止**使用 `BrowserWindow.getAllWindows()`（userscripts `@background` 与 DevTools 窗口会混入）。
- 监听 `focus` 事件维护"最近聚焦窗口"，供 shim 使用。
- `closed` 时从注册表移除并通知 TabManager 索引清理。

### 6.2 TabManager 多实例（`src/main/modules/tabs.ts`）

```ts
class TabManager {
  constructor(private readonly win: () => BrowserWindow | null) {}
  // 内部 5 处 getMainWindow() → this.win()
  // send() → this.win()?.webContents.send(...)
}

// 新增索引
createTabManager(win: BrowserWindow): TabManager
getTabManagerForWindow(runtimeId: number): TabManager | undefined
findTabManagerByTabId(tabId: string): TabManager | undefined
findTabManagerByWebContents(wcId: number): TabManager | undefined
getTabManagerForSender(wc: Electron.WebContents): TabManager | undefined
disposeTabManager(win: BrowserWindow): void   // destroyAll + 索引清理
```

**兼容 facade**（保留 `export const tabManager`，降低 60 处调用的改造风险）：

| 方法类别 | 转发规则 |
| --- | --- |
| tabId 作用域（close / suspend / activate / navigate / back / forward / reload / stop / zoom / mute / devtools / find / stopFind / setRuffleMode / fillPassword / getUserscriptCommandsForTab / invokeUserscriptCommand / beginAutomation / inspectAutomationTarget / getWebContents / isTabActive / getTabIdForWebContents / getRuffleForWC） | `findTabManagerByTabId(tabId)` |
| 窗口作用域（create / setBounds / focusActive / refreshActiveViewAfterHostRestore / getActiveId） | 由调用方显式传实例；facade 仅在没有 sender 的旧调用点退化为聚焦窗口 |
| 聚合（getMemoryDiagnostics） | 遍历所有实例合并 |
| 广播（refreshPasswordCapture / refreshPasswordFill） | 遍历所有实例 |

`create` 是唯一必须显式带窗口上下文的方法：`tabs.ipc.ts` 用 `event.sender` 解析实例后直接调用，不再经过 facade。

### 6.3 IPC 路由协议

`ipc-wrapper` 新增（保留旧签名）：

```ts
createEventHandler<T, R>(channel, fn: (ctx: { event, window, args }) => R | Promise<R>)
createValidatedEventHandler<S, R>(channel, schema, fn)
```

| 通道组 | 路由依据 | 变更 |
| --- | --- | --- |
| `tab:create`、`tab:setBounds`、`tab:focusActive` | `event.sender` → 窗口 → 实例 | 改为按 sender |
| `tab:close/suspend/activate/navigate/goBack/goForward/reload/stop/zoom/mute/devtools/find/stopFind/setRuffleMode` | `tabId` → 实例，并校验该 tab 属于 sender 窗口 | 增加越窗校验 |
| `win:minimize/maximize/unmaximize/close/setFullscreen/toggleFullscreen/isMaximized` | `event.sender` → 窗口 | 改为按 sender |
| `win:get-context`（新增） | `event.sender` → `{ windowKey, isMaximized, bounds }` | 新增 |
| `win:new-window`（新增） | 任意窗口均可触发 | 新增 |
| `tab:updated/tab:found/tab:load-error/tab:crashed/tab:newwindow/password:filled` | 由 tab 所属实例发送 | 只发所属窗口 |
| `shortcut` | `before-input-event` 的 WebContents 所属窗口 | 改为按来源窗口 |

越窗校验规则：`tabId` 的归属窗口必须等于 `event.sender` 所属窗口，否则拒绝并记 `log.warn`。这既能防串窗，也能防渲染层被注入后跨窗口操作。

### 6.4 生命周期

| 事件 | 行为 |
| --- | --- |
| 二次启动 `second-instance` | `createWindow()` → 新窗口打开首页新标签（argv 带 URL 则打开该 URL）→ 聚焦 |
| 单窗口 `close` | 只销毁该窗口的 TabManager 与 BrowserView；**不**标记正常退出 |
| 最后一个窗口关闭 `window-all-closed` | Windows/Linux：`markCleanShutdown()`（或 `before-quit`）后 `app.quit()`；macOS：不退出 |
| `before-quit` | 标记正常退出；落盘窗口几何与顺序 |
| macOS `activate` | 无窗口时 `createWindow()` |
| `session-end`（Windows 关机） | 保留 `markCleanShutdown()` |

### 6.5 会话、几何与迁移

新增 `src/main/modules/window-state.ts`（electron-store）：

```ts
type WindowState = { key: string; bounds: {x,y,width,height}; maximized: boolean };
// 存储：windows: WindowState[]（按顺序）
```

- 启动：若有已存窗口状态，按序创建 N 个窗口，并把每个 `windowKey` 传给渲染层。
- 渲染层：`win:get-context` 取得 `windowKey`，会话快照 key 用 `tab-session:<windowKey>`。
- 迁移：若不存在任何 `tab-session:*` 而旧 `TAB_SESSION_META_KEY` 有值，则写入第一个窗口的 key，成功后删除旧 key。
- 退出/窗口变化时更新几何（防抖 500ms）。

### 6.6 横切模块适配

| 模块 | 规则 |
| --- | --- |
| 截图（IPC / HTTP） | 显式 tabId → 该 tab 所属窗口的 `rect` 与最小化状态；未指定 → 聚焦窗口的活动 tab |
| 自动化 | tabId → 实例；`getTabIdForWebContents` 走全局索引；仍在原窗口内保持"目标标签必须激活"的既有约束 |
| 开发者工具箱 | **每窗口独立桥实例**，`targetId` 按窗口隔离；两个窗口可同时使用抽屉（严格对齐 Chrome） |
| 密码 view gate | CredUI 属主 HWND 取发起请求的窗口；无 sender 时才回退聚焦窗口 |
| 下载 | 进度/完成事件广播到所有窗口；目录选择弹窗取聚焦窗口 |
| 内存监控 | 聚合所有窗口；非活动标签挂起预算改为全局 |
| 用户脚本 admin | 已带 tabId，走全局索引 |

### 6.7 可观测性

- 所有窗口级日志加 `win=<runtimeId> key=<windowKey>` 前缀，便于排查串窗。
- 新增诊断项：窗口数、每窗口标签数、事件投递统计（可选，不强制）。

### 6.8 标签跨窗口迁移（tear-off / cross-window move）

**交互流程**

1. 标签上按下并拖动超过 6px 进入拖拽态。
2. 拖拽期间**必须隐藏当前窗口的活动 BrowserView**（复用 `tab:setBounds(-9999,-9999,1,1)`），否则原生层会截获鼠标事件，渲染层收不到 `mousemove` / `mouseup`。
3. 用 `setPointerCapture` 保持指针事件，`Escape` 取消拖拽并恢复视图。
4. 释放点判定放在**主进程**：`screen.getCursorScreenPoint()` + 注册表窗口 `bounds` 判断落点：
   - 落在本窗口标签栏 → 仅重排序；
   - 落在其他窗口标签栏 → 跨窗口移动；
   - 落在窗口外 → 新建窗口（tear-off）。

**迁移步骤（WebContents 不重建）**

1. 前置校验：该 tab 无自动化租约、无进行中的密码填充；否则拒绝并 toast 提示。
2. 目标窗口已存在则复用；否则 `createWindow({ initialBounds: dropPoint })`。
3. 旧 manager 删除 tab 条目 → `win.removeBrowserView(view)`。
4. 新 manager 接收条目 → `win.addBrowserView(view)` → `setBounds` → 重建 tabId / wcId 索引。
5. 旧窗口收到 `tab:detached { tabId }`，新窗口收到 `tab:adopted { tab, index }`，渲染层据此增删 store 条目。
6. 旧窗口标签被拖空后**自动关闭**（Chrome 行为）；若旧窗口是最后一个窗口则按 6.4 生命周期处理。

**硬性约束**

- 禁止 `loadURL` / 重建 WebContents：登录态、Flash 播放进度、自动化资源都不能被打断。
- userscript 注册与 password capture 都按 `wc.id` 绑定，迁移窗口不需要重新注册；只需保证事件 `send` 走新窗口。
- 迁移瞬间调用一次 `invalidate()`，缓解 Chromium 87 的合成器表面短暂空白。

**坐标**

新窗口以释放点为中心，并夹取到当前显示器工作区内，避免生成到屏幕外。

---

## 7. 实施计划（审核通过后按序执行）

> 每阶段独立提交、独立回滚。P1/P2 对外行为不变。

### P1 窗口注册表与生命周期

- [ ] `window.ts` 引入注册表与 `windowKey`，`createWindow(options?)`
- [ ] `getMainWindow()` 改为"最近聚焦"shim
- [ ] 移除逐窗口 `markCleanShutdown()`，改 `before-quit` / `session-end`
- [ ] `window-all-closed` 增加 macOS 分支
- [ ] `index.ts` 创建窗口后按注册表绑定 `restore` / `maximize`
- 改动：`modules/window.ts`、`index.ts`
- 判据：单窗口行为不变；测试中可创建第二个窗口
- 验证：`npm run typecheck:main`、`npm run test:electron`

### P2 IPC 路由基建

- [ ] `ipc-wrapper` 新增带事件上下文的 handler 工厂
- [ ] `window.ipc` 全部按 sender 路由
- [ ] `tabs.ipc` 的窗口作用域通道按 sender 路由
- [ ] 新增 `win:get-context`、`win:new-window`
- [ ] `preload` 暴露新通道与类型声明
- 改动：`utils/ipc-wrapper.ts`、`ipc/window.ipc.ts`、`ipc/tabs.ipc.ts`、`preload/index.ts`、`shared/types/ipc.ts`
- 判据：单窗口全功能回归通过
- 验证：`npm run typecheck`、`npm run test:electron`

### P3 TabManager 多实例化

- [ ] 构造注入窗口解析器，替换 5 处硬编码
- [ ] 建立 tabId / wcId 全局索引与清理
- [ ] 实现 facade 转发与聚合
- [ ] `send()` 改发所属窗口
- [ ] 窗口销毁时 `disposeTabManager`
- 改动：`modules/tabs.ts`
- 判据：双窗口标签事件互不串窗
- 验证：`npm run typecheck:main`、`npm run probe:deep`

### P4 消费方适配

- [ ] 截图链路按 tab 归属窗口
- [ ] 自动化链路走全局索引
- [ ] 开发者工具箱改为每窗口独立桥，双窗口可同时使用抽屉
- [ ] view-gate 属主窗口按 sender
- [ ] 下载事件广播
- [ ] 内存监控聚合 + 全局挂起预算
- [ ] 快捷键事件按来源窗口路由
- 改动：`modules/screenshot*.ts`、`modules/devtoolbox-*.ts`、`ipc/automation-v3.ipc.ts`、`modules/automation/service-v3.ts`、`ipc/password.ipc.ts`、`modules/view-gate*`、`modules/download*.ts`、`modules/memory-monitor.ts`、`ipc/shortcut.ipc.ts`
- 判据：R7 手工验收通过
- 验证：`npm run typecheck:main`、`npm run probe:deep`

### P5 渲染层会话与几何

- [ ] `useTabManager` 使用 `windowKey` 分片会话
- [ ] 旧 `TAB_SESSION_META_KEY` 迁移到首个窗口
- [ ] 窗口几何持久化（防抖）
- [ ] 启动时按已存窗口数恢复
- 改动：`hooks/useTabManager.ts`、`services/tab-session.ts`、`modules/window-state.ts`（新增）、`preload/index.ts`
- 判据：R6 手工验收通过
- 验证：`npm run typecheck:renderer`、`npm run typecheck:preload`

### P6 新建窗口入口与平台行为

- [ ] `second-instance` → `createWindow()`
- [ ] `Ctrl+N` 接入新建窗口（动作已在 `shortcut.ipc.ts:47` 定义，渲染层 `App.tsx` 未处理）
- [ ] `Ctrl+Shift+W` 关闭当前窗口
- [ ] 右键链接菜单增加「在新窗口打开」
- [ ] 窗口标题跟随活动标签（移除 `page-title-updated` 的 `preventDefault`）
- [ ] 新窗口默认地址 = `settings.homepage || about:newtab`（与正常启动一致）
- [ ] macOS `activate` 重建窗口
- 改动：`index.ts`、`ipc/shortcut.ipc.ts`、`renderer/App.tsx`、`preload/index.ts`
- 判据：R1、R4 手工验收通过
- 验证：`npm run typecheck`、`npm run lint`

### P7 标签跨窗口迁移（tear-off）

- [ ] TabManager 支持 tab 在实例间转移：移除条目 / 接收条目 / 重建索引，WebContents 不重建
- [ ] 主进程拖拽落点判定（本窗口排序 / 跨窗口 / 窗口外新建）
- [ ] 拖拽期间隐藏活动 BrowserView，`setPointerCapture` + `Escape` 取消
- [ ] 新通道 `win:tear-off-tab` / `win:move-tab`，渲染层事件 `tab:detached` / `tab:adopted`
- [ ] 旧窗口标签拖空后自动关闭
- [ ] 自动化租约 / 密码填充进行中时拒绝迁移并提示
- 改动：`modules/tabs.ts`、`modules/window.ts`、`ipc/tabs.ipc.ts`、`preload/index.ts`、`renderer/components/tabs/*`、`renderer/hooks/useTabManager.ts`、`renderer/store/useTabsStore.ts`
- 判据：R8、R9 手工验收通过；页面不重载
- 验证：`npm run typecheck`、`npm run probe:deep`、P8 手工清单

### P8 全量验证

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm run test:electron`
- [ ] `npm run probe:deep`
- [ ] `npm run test:smokes`（可选；先 `node scripts/ensure-build.cjs`）
- [ ] 第 8.3 节手工清单

---

## 8. 测试计划

### 8.0 已完成：阶段可行性探测（Electron 11.5.0 实测）

在写任何生产代码之前，已落地 7 个 Electron probe 并全部跑通：

```
npx electron tools/probe/host-electron.cjs --only 38,39,40,41,42,43,44
→ 7 probes, 0 failed
```

| Probe | 对应阶段 | 验证内容 | 结论 |
| --- | --- | --- | --- |
| `38-electron11-api` | 全部 | Electron 11.5.0 的 20 项必需 API 存在；`setWindowOpenHandler` / `contentView` 确认不存在 | OK |
| `39-multi-window` | P1 | 两窗口 + 两 BrowserView 并存；关一个不影响另一个；`window-all-closed` 只在最后触发 | OK |
| `40-view-migration` | P3 / P7 | `removeBrowserView` → 另一窗口 `addBrowserView`：`wc.id` 与 pid 不变、文档**未重载**、监听器仍有效 | OK |
| `41-drag-geometry` | P7 | `getCursorScreenPoint` / `getDisplayMatching` / workArea 夹取 / 窗口命中测试 | OK |
| `42-cdp-dual-bridge` | P4 | 同一 browser ws 端点开两条独立连接、各 attach 不同 target、互不干扰、单独关闭不影响对方 | OK |
| `43-session-sharding` | P5 | 按 `tab-session:<key>` 分片、几何互不覆盖、旧 key 可安全迁移 | OK |
| `44-ipc-sender-routing` | P2 | 外壳 / BrowserView / 隐藏窗口三种 sender 均可归属到正确窗口 | OK |

**探测得出的 3 条硬约束（已写进设计）**：

1. **Electron 11 没有 `event.senderFrame` / `WebFrameMain`（12 才有）** → P2 只能依赖 `event.sender`（WebContents）+ 显式注册表，不能靠 frame 级信息。
2. **`BrowserWindow.fromWebContents(view.webContents)` 在 Electron 11 能返回宿主窗口**，但这属于"恰好可用"；`wc.hostWebContents` 为 `null`（Electron 11 的 BrowserView 不提供）。
   → P1 的 `getWindowForWebContents` 必须以 `fromWebContents` 为主，并保留显式 `wcId → window` 注册表兜底（probe 44 的 `recommendation` 字段已记录）。
3. **跨窗口迁移确实不重建渲染进程**（probe 40 实测 `wc.id` 与 pid 均不变、marker 保留、无额外导航）→ P7 的 tear-off 方案成立，不需要为"页面会重载"准备降级方案。

### 8.1 单元测试（vitest unit）

新增 `tests/unit/main/window-registry.spec.ts`：

- 注册 / 注销 / `getWindowForWebContents` / shim 退化顺序
- 不把非注册窗口（模拟后台隐藏窗口）算入 `getRegisteredWindows`

新增 `tests/unit/main/tab-manager-routing.spec.ts`（mock electron）：

- 两个 manager 的 tabId 索引互不干扰
- facade 转发到正确实例
- 越窗校验拒绝
- `getMemoryDiagnostics` 聚合两窗口

### 8.2 集成 / 冒烟

- `npm run test:electron`：BrowserView 生命周期（现有）
- `npm run probe:deep`：manager + BrowserView 运行时
- 已落地（8.0）：`probes/38` ~ `probes/44` 共 7 个阶段可行性探测
- 实施阶段新增：
  - `probes/45-tab-manager-routing.cjs`：双窗口 TabManager 事件归属（P3 完成后）
  - `probes/46-tab-transfer.cjs`：真实 TabManager 实例间迁移（P7 完成后，替代 probe 40 的裸 BrowserView 验证）

### 8.3 手工验收清单

1. `npm start` → 双击图标两次 → 共 3 个窗口。
2. 窗口 A 开 3 标签、B 开 2 标签 → 标签栏不串、页面位置正确。
3. 关闭 A → B 的标签与页面不受影响，进程仍在。
4. 关闭 B → 进程退出；重启恢复两个窗口。
5. A 登录 4399 → B 打开 4399 保持登录。
6. B 打开密码本 → "填充当前页面"只作用于 B。
7. 自动化工作台在 A 选择目标标签运行 → 不影响 B。
8. A 中 `Ctrl+N` → 新建窗口（而非新标签）。
9. 拖动标签到窗口外释放 → 生成新窗口，页面不重载、Flash 继续播放。
10. 把标签拖到另一个窗口的标签栏 → 标签移动过去，原窗口保留其余标签。
11. 拖走旧窗口的最后一个标签 → 旧窗口自动关闭。
12. 自动化运行中拖拽该标签 → 被拒绝并给出提示。

---

## 9. 风险与回滚

| 编号 | 风险 | 触发场景 | 对策 |
| --- | --- | --- | --- |
| K1 | 事件串窗 | 双窗口下标签标题/加载态互相污染 | 事件守卫加窗口归属；`send` 绑定实例；P3 专项 probe |
| K2 | 关窗误判正常退出 | 关掉非最后窗口后崩溃恢复失效 | P1 即移除逐窗标记，改 `before-quit` |
| K3 | CredUI 属主错误 | 验证框被压到其他窗口后面或无任务栏图标 | 用 sender 解析窗口，禁止回退主窗口 |
| K4 | DevToolsBridge 冲突 | 两个窗口的抽屉互相抢 attach | 桥改为每窗口实例，targetId 与连接生命周期均按窗口隔离；双窗口同时开抽屉纳入 P8 手工验收 |
| K5 | 内存预算翻倍 | 多窗口各自挂起，总量超预算 | 全局预算，由 memory-monitor 聚合下发 |
| K6 | 旧会话丢失 | 首次升级时 key 变更导致标签不见 | 先写新 key 成功再删旧 key |
| K7 | 隐藏窗口混入枚举 | 用户脚本后台窗口被当作浏览器窗口 | 只用显式注册表 |
| K8 | 前台激活受限 | 二次启动新窗口不获得焦点 | 新建顶层窗口 + `show()` + `focus()` |
| K9 | 拖拽丢事件 | BrowserView 原生层盖住页面区域，渲染层收不到 `mousemove` / `mouseup` | 拖拽开始即隐藏活动 BrowserView；`setPointerCapture` + 主进程鼠标钩子兜底 |
| K10 | 迁移后空白 / 闪烁 | Chromium 87 合成器表面重建 | 迁移后立即 `setBounds` + `invalidate()`；必要时复用 `refreshActiveViewAfterHostRestore` 的隐藏→可见过渡 |
| K11 | 迁移打断自动化 / 密码填充 | tab 正被 CDP 租约占用 | 迁移前校验，直接拒绝并 toast 说明原因 |

**回滚策略**：P1/P2 纯基建，回滚无副作用；P3 是行为分水岭，回滚需同时还原 facade；P5 保留旧会话数据直到首次成功写入。

---

## 10. 已确认决策

| 编号 | 问题 | 结论 |
| --- | --- | --- |
| Q1 | 新窗口默认打开什么？ | **跟随设置里的首页**：`settings.homepage \|\| about:newtab`，与正常启动完全一致 |
| Q2 | 新建窗口快捷键？ | **`Ctrl+N`**，与 Chrome 一致（`Ctrl+T` 仍是新标签；`new-window` 动作已存在但渲染层未接） |
| Q3 | 关闭所有窗口后下次是否恢复多窗口？ | **恢复**：退出时落盘窗口顺序、几何与各自会话 |
| Q4 | 开发者工具箱在多窗口下怎么处理？ | **A：每窗口独立桥**，双窗口可同时使用抽屉（严格对齐 Chrome） |
| Q5 | `Ctrl+Shift+T` 最近关闭标签？ | 本期不做 |

### 10.1 Q4 落地方式（已选 A）

- 每个 BrowserWindow 持有独立的 DevToolsBridge 实例，`host` / `targetId` / CDP 会话 / 统计全部按窗口隔离。
- 桥的生命周期跟随窗口：窗口关闭即关闭该桥的 ws 与调试会话。
- 抽屉里的"桥接状态"按窗口独立展示，不跨窗口共享。
- 双窗口同时开抽屉纳入 P8 手工验收。若 Chromium 87 下并发桥出现不可接受的问题，**先记录阻塞证据再回退到 B**，不允许静默降级。

### 10.2 严格对齐 Chrome 的补充项（本轮一并纳入）

| 行为 | 现状 | 阶段 |
| --- | --- | --- |
| 二次启动新建窗口 | 只 `restore + focus` | P1 / P6 |
| `Ctrl+N` 新建窗口 | 动作已定义，渲染层未处理 | P6 |
| `Ctrl+Shift+W` 关闭当前窗口 | 未定义 | P6 |
| 右键链接「在新窗口打开」 | 只有「在新标签页打开」 | P6 |
| 窗口标题跟随活动标签 | 固定应用名（`page-title-updated` 被 `preventDefault`） | P6 |
| 每个窗口独立的开发者工具箱 | 单桥 | P4 |
| 每窗口独立位置 / 大小恢复 | 无 | P5 |
| 关闭最后一个窗口才退出 | 退出逻辑已有，但关任一窗口会误标正常退出 | P1 |

### 10.3 明确保留的差异（本期不做）

| 差异 | 原因 |
| --- | --- |
| `Ctrl+Shift+T` 最近关闭标签 | 已确认本期不做 |
| 隐身窗口 | 应用无此模式 |
| 多 Profile（Chrome 的"用户"概念） | 需要独立 userData，与密码库、下载目录冲突 |

---

## 11. 审核清单

请逐项确认；任一项打回则按意见修改后重新提交。

- [ ] 方案 B（单进程多窗口、共享 profile）符合预期，不要求多进程多实例
- [ ] **8.0 节的 7 个可行性探测结论已确认**（Electron 11.5.0 下全部可行）
- [ ] 8.0 节列出的 3 条硬约束（无 `senderFrame`、`hostWebContents` 为 null、迁移不重建 wc）已接受
- [ ] 非目标（窗口间标签实时同步、独立 userData、多 Profile）可接受
- [ ] 需求 R1-R9 与验收标准覆盖了你的诉求，无遗漏
- [ ] R8 / R9（tear-off 与跨窗口移动）纳入本期，由 P7 交付
- [ ] 分阶段顺序与"P3 为行为分水岭"的安排可接受
- [ ] 第 10 节决策（Q1 / Q2 / Q3 / Q4=A / Q5）无异议
- [ ] 10.2 的 Chrome 严格对齐补充项纳入本期范围
- [ ] 10.3 明确保留的差异可接受
- [ ] 风险对策（尤其 K3 CredUI 属主、K4 每窗口独立桥）可接受
- [ ] 允许新增文件：`modules/window-state.ts`、2 个单测、可选 1 个 probe

审核通过后，按第 7 节 P1 → P8 顺序实施，每阶段完成后汇报并等待确认是否继续。
