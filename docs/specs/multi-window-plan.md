# 多窗口改造计划书（对齐 Chrome 行为）

- 状态：**v7.1 决策已确认（Q6/Q7/Q8），待开工**
- 审计基线：v6（2026-11-09）。v7 修正 1 处范围自相矛盾、7 个 P0 级缺口、12 个 P1 级缺口、5 个 P2 级口径问题，逐条见 §12
- 决策状态：Q6 / Q7 / Q8 已于 2026-11-09 确认（tear-off 在本期、工具箱按 L、并发写入策略接受），见 §10.4
- 适用版本：BaoFlashBrowser 1.1.2（Electron 11.5.0 / Chromium 87，版本锁定）
- 文档定位：Spec + Design + Tasks 三合一，审核通过后按第 7 节顺序实施
- 关联代码：`src/main/index.ts`、`src/main/modules/window.ts`、`src/main/modules/tabs.ts`、`src/main/modules/session-recovery.ts`、`src/main/modules/window-state.ts`（新增）、`src/main/ipc/*`、`src/main/modules/devtoolbox*.ts`、`src/main/modules/view-gate*.ts`、`src/renderer/hooks/useTabManager.ts`、`src/renderer/services/{tab-session,id.service}.ts`、`src/renderer/store/useTabsStore.ts`、`src/renderer/App.tsx`

---

## 0. 一页摘要

**问题**：再次双击图标时，第二个进程被单实例锁拦下并退出，已有进程只做 `restore + focus`，用户没有任何可见反馈；同时不支持多窗口。

**结论**：可以对齐 Chrome，且**不需要推翻重来**。Chrome 的真实模型是"单进程 + 多窗口 + 共享 profile"，本项目的 `TabManager` 状态本就全在实例字段上，改造重点是"把它从单例变成一窗口一实例"，并把事件、IPC、持久化补上窗口归属。

**改造规模（v7 实测口径）**：

| 维度 | 数量 |
| --- | --- |
| 直接改动文件 | 约 35 个：28 个文件已引用 `getMainWindow` / `tabManager`，另加 `preload`、`electron.d.ts`、`shared/types/ipc.ts` 与 IndexedDB 层 3 个 |
| 新增文件 | 1 个模块（`modules/window-state.ts`）+ 5 个单测 + 5 个 probe（45~49） |
| 需要适配的调用点 | `getMainWindow()` **37 个调用点**（52 处引用）/ `tabManager.*` 60 处 / `tab:*` 通道 **22 个** |
| 行为分水岭 | 阶段 P3（TabManager 多实例化）；P1/P2 对外行为不变 |

**核心风险（6 项）**：事件串窗、关窗误判"正常退出"、CredUI 属主挂错窗口、**会话/崩溃恢复的多窗口竞争**、**tear-off 后事件归属丢失**、**开发者工具箱的信任模型是单窗口假设**。对策见第 9 节。

**可行性状态**：已在 Electron 11.5.0 落地 7 个阶段探测（8.0 节），但**每个 probe 的覆盖范围都有明确边界**（8.0 节"已知边界"）。其中"跨窗口迁移不重载页面"已由 probe 40 证明；**PPAPI/Flash 实例能否跨窗口存活、跨窗口拖拽能否收到事件**尚未验证，由新增 probe 47 / 48 在 P7 开工前补测。

**决策状态**：本期范围已定——R8/R9（tear-off 与跨窗口移动）在本期实现（Q6）；开发者工具箱"每窗口独立桥"按 L 成本接受（Q7）；收藏/设置的并发写入改为增量写 + 事务内合并，接受（Q8）。

---

## 1. 背景与问题定义

### 1.1 现状

- `app.requestSingleInstanceLock()` 在 `src/main/index.ts:30` 已生效：二次启动的进程会立即 `app.quit()`。
- `second-instance` 处理器只做 `restore + focus`（`src/main/index.ts:35-41`），命令行参数被忽略；若窗口已在前台则表现为"点了没反应"。
- `src/main/modules/window.ts` 只有一个模块级 `mainWindow`（第 7 行），`getMainWindow()` 返回它（第 151 行）；每个窗口的 `close` 都会 `markCleanShutdown()`（第 134-136 行）。
- `src/main/modules/tabs.ts` 的 `TabManager` 被导出为全局单例（第 812 行），内部 5 处硬编码 `getMainWindow()`（358 / 421 / 583 / 663 / 808 行）；`preloadPath` 由 `setPreload()` 在 `index.ts:144` 注入一次。
- `destroyAll()`（`tabs.ts:667`）目前**没有任何调用点**：单窗口时代依赖 Electron 在窗口销毁时连带销毁 BrowserView。
- 唯一的模块级可变状态是 `optionalServices`（`tabs.ts:27`，可选服务装配，与窗口无关）；`HIDDEN_BOUNDS` / `AUTOMATION_*` 是常量。也就是说多实例化不会争抢共享可变状态。

### 1.2 对 Chrome 行为的澄清

Chrome / Edge 双击图标**不会**启动第二个浏览器进程。真实链路是：

1. 新进程启动，ProcessSingleton 发现已有实例；
2. 把命令行转交给已有进程；
3. 新进程退出；
4. 已有进程新建一个窗口。

任务管理器中的多个 `chrome.exe` 是渲染 / GPU / 网络子进程，属于多进程渲染架构。本项目的 BrowserView 已经是一标签一渲染进程，与该模型一致。

### 1.3 为什么现在的架构适合改造

`TabManager` 的 `tabs` / `wcToId` / `activeId` / `rect` / `automationTargets` 全部是实例字段（`src/main/modules/tabs.ts:104-115`）。也就是说"一窗口一实例"在类设计上是现成支持的，缺的只是：

1. 归属层（窗口注册表 + 全局 tab/wc 索引）；
2. 路由层（IPC、推送、快捷键按宿主窗口解析）；
3. 持久化层（`windowKey` 分片与迁移）。

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
| R4 | 窗口生命周期 | 关闭 A 只销毁 A 的标签，B 正常；关闭最后一个窗口后进程退出（Windows/Linux）；macOS 关完不退出且功能不退化（抽屉/下载/监控仍可用，见 6.4） |
| R5 | 事件路由 | A 的标签事件不出现在 B 的标签栏；A 的页面标题/加载态变化不触发 B 的 UI 更新 |
| R6 | 会话恢复 | 两窗口各带标签退出后重启，恢复为两个窗口，标签归属与顺序正确；异常退出后两窗口各自恢复自己的快照，互不覆盖 |
| R7 | 横切功能定位正确 | 截图、自动化、开发者工具箱、密码填充、内存监控作用于正确的窗口或 tab |
| R8 | 标签拖出成新窗口（tear-off） | 拖动标签离开标签栏并释放 → 生成新窗口；页面不重载（probe 46/47），加载/播放状态不中断，迁移后标题/加载态/地址栏继续更新 |
| R9 | 标签跨窗口移动 | 从窗口 A 拖到窗口 B 标签栏并释放 → 标签出现在 B、从 A 消失，页面不重载，事件仍投递给 B |

### 2.3 非目标（本期明确不做）

| 项 | 原因 |
| --- | --- |
| 每窗口独立 `userDataDir` 的多实例 | 会撕裂密码库、下载目录、自动化租约与 DevTools 端口发现；Chrome 也不这么做 |
| 每窗口独立浏览器进程 | 与 Chromium profile 锁冲突，且无收益 |
| 窗口间标签实时同步 | Chrome 本身也不做 |
| 多 Profile / 隐身窗口 | 依赖独立 userData，与密码库、下载目录冲突（见 10.3） |

---

## 3. 现状与影响面（完整清单）

> 口径说明：`getMainWindow` 实测 52 处引用 / 37 个调用点；`tabManager.*` 60 处；`tab:*` 通道 22 个。下表按**文件**列全，凡未列出者默认不改。

| 位置 | 现状 | 需要的改动 | 规模 |
| --- | --- | --- | --- |
| `main/index.ts` | 单窗口创建；`window-all-closed` 里做完所有 teardown 后 `quit`；`render-process-gone` 按唯一窗口比较；zoom/shortcut 绑定只对首窗口 | 多窗口启动/关闭/崩溃；teardown 上移；按窗口绑定 restore/maximize | M |
| `main/modules/window.ts` | 单例 `mainWindow`；每窗口 `close` 都 `markCleanShutdown()` | 注册表 + `windowKey` + shim + 生命周期上移 | M |
| `main/modules/session-recovery.ts` | `recoveryRequired` 全局单值；`resolve` 一调全局清零 | 状态在进程内只读；resolve 按 `windowKey`；不跨窗口清零 | M（v7 上调） |
| `main/modules/tabs.ts` | 单例、5 处硬编码宿主、`send` 只发主窗口、`_disposeView` 会 `destroy()` wc、`create` 遇重复 tabId 静默复用、`preloadPath` 事后注入 | 多实例 + 全局索引 + 迁移原语 + 构造注入 preload + 事件可重绑 | L |
| `main/modules/window-state.ts` | 不存在 | 新增：几何/顺序持久化（electron-store） | S |
| `main/utils/ipc-wrapper.ts` | `createHandler` 丢弃 `event` | 新增带事件上下文的工厂（保留旧签名） | S |
| `main/ipc/window.ipc.ts` | 全部通道走 provider | 按 `event.sender` 路由；新增 `win:get-context`/`win:new-window` | S |
| `main/ipc/tabs.ipc.ts` | 22 个 `tab:*` 通道直调全局单例；同文件的 `password:form-detected` / `get-ruffle-mode` / `ruffle:diagnostic` 已按 sender 定位 | `tab:create`/`tab:setBounds`/`tab:focusActive` 按 sender；其余按 tabId + 越窗校验 | M |
| `main/ipc/shortcut.ipc.ts` | 动作一律发 `getMainWindow()`；`registerZoomShortcuts` 只绑首窗口 focus/blur；`startMouseHook` 只解析 `ZOOM_IN/ZOOM_OUT` | 来源窗口路由；zoom 按窗口注册；删除"鼠标钩子可兜底拖拽"的错误假设 | M（v7 上调） |
| `main/ipc/password.ipc.ts` | 调全局单例 | 走 facade（多数无需改）；`password:reveal` 需带属主窗口 | S |
| `main/ipc/automation-v3.ipc.ts` | tabId 解析走单例；`getWin()`/`getFocusedWindow` 兜底 | 走全局索引；宿主按 sender | S |
| `main/ipc/diagnostics.ipc.ts` | `file:open-swf` / `diagnostics:export` 用主窗口作 dialog 属主 | 按 sender | S |
| `main/ipc/automation-assistant-bridge.ts` | `ui:toast` 只发主窗口；tabId 走全局单例 | toast 发 tab 所属窗口；索引 | S |
| `main/ipc/userscripts.ipc.ts` | `open-in-tab` 在 `hostWebContents` 为 null 时挑"第一个可见窗口" | 按 sender 所属窗口 | S |
| `main/ipc/userscripts-admin.ipc.ts` | 已带 tabId | 走全局索引 | S |
| `main/modules/screenshot.ts` / `screenshot.ipc.ts` / `screenshot-http.ts` | 主窗口 + 单活动 tab + 单 `getContainerRect()` | 按 tab 归属窗口取 rect / 最小化；未指定时取 sender 窗口 | M |
| `main/modules/devtoolbox*.ts`（bridge / host / collector / snapshot / workspace / ipc / targets） | 桥、前端容器 BrowserView、采集缓冲、sink、targetId 全是进程级单例；`isTrustedSender` 只承认主窗口 | **每窗口一组**：bridge + 前端容器 + collector + targetId；信任模型改为"sender 属于该窗口自己的前端/外壳" | L（v7 上调） |
| `main/modules/password-capture.ts` / `view-gate-win.ts` / `view-gate.ts` | 属主 HWND 是模块级单 setter；5 次失败 30 分钟锁是全局 | 属主参数化（按 sender）；明确全局锁是刻意行为 | M（v7 上调） |
| `main/modules/download.ts` / `ipc/download.ipc.ts` | 事件只发主窗口；目录弹窗用 `getFocusedWindow()` | 广播所有注册窗口；宿主用 sender | S |
| `main/modules/memory-monitor.ts` | 只有聚合，**不存在**挂起预算 | 仅保留聚合；不新增预算（见 6.6） | S |
| `main/modules/ui-language.ts` | `ui:set-language` 用 `sender.id !== getWindow()?.webContents.id` 鉴权；语言变更已广播所有 wc | 鉴权换 `getWindowForWebContents` | S |
| `renderer/hooks/useTabManager.ts` | 全局会话 key；崩溃恢复读全局状态；每窗口各一套挂起 timer | `windowKey` 分片 + 单归属迁移 + 恢复状态按窗口 | M |
| `renderer/services/tab-session.ts` | `TAB_SESSION_META_KEY` 单 key | key 分片 + 迁移归属 + 旧数据兼容 | S |
| `renderer/services/id.service.ts` | `tab-${Date.now()}-${counter}`，counter 按进程 | tabId 全局唯一（带 `windowKey` 前缀） | S |
| `renderer/services/db.ts` / `store/useDataStore.ts` / `components/data/DatabaseHydrator.tsx` | 单库单连接；favorites `clear()+bulkPut` 全量替换；`useLiveQuery` 回灌 store | 收藏改增量写；settings 读改写合并；水合前不写库 | M |
| `renderer/components/layout/TopBar.tsx` / `components/tabs/TabItem.tsx` | HTML5 `draggable` + `dataTransfer`，窗口外释放无事件 | 改用 pointer events（P7 替换，不是增量） | M |
| `renderer/store/useDevToolStore.ts` | 抽屉尺寸/停靠存 localStorage 单键 | 按窗口区分或明确接受共享 | S |
| `renderer/App.tsx` / `index.tsx` | `new-window` 未处理；外壳标题固定 `'Bao — loaded'`；每窗口挂载即发 `ui:set-language` / `theme:set-source` | 接入新窗口；标题改主进程 `setTitle`；挂载写入需容错 | S |
| `preload/index.ts` / `renderer/types/electron.d.ts` / `shared/types/ipc.ts` | 三套白名单（invoke / on / 类型）已存在漂移 | 新增通道三处同步（见 6.3） | S |
| `main/modules/session-manager.ts` | 每分区 `setupSessionOnce`（幂等） | 不变 | — |
| `renderer/services/toast.ts` | 纯函数，无模块级队列（队列在 `useDataStore.ts:97`） | 不需要改（v6 曾误列） | — |

---

## 4. 方案选型

| 方案 | 描述 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- | --- |
| A. 保持单窗口 | 二次启动只在现有窗口开新标签 | 十几行代码 | 不满足"多开窗口"，仍无法并排对照两个页面 | 否决（作为降级保底） |
| **B. 单进程多窗口 + 共享 profile** | 一个主进程，多个 BrowserWindow，各自标签栏 | 与 Chrome 完全一致；登录态/密码/下载共享；实现成本可控 | 需要重做窗口归属与 IPC 路由；工具箱需按窗口重建 | **采用** |
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
 │    └─ 每个窗口持有稳定 windowKey（跨重启不变）+ index + isPrimary
 ├─ window#1 ↔ TabManager#1 ── BrowserView(tab1..n) → send 到窗口#1
 ├─ window#2 ↔ TabManager#2 ── BrowserView(tab1..m) → send 到窗口#2
 ├─ 全局索引: tabId → TabManager, wcId → TabManager
 ├─ 每窗口: DevToolsBridge / 工具箱前端容器 / collector（10.1 方案 A）
 ├─ 共享: persist: 分区 / Cookie / 密码库 / 下载目录 / 自动化资源
 └─ second-instance ──▶ createWindow()（不再只 focus）
```

### 5.3 关键原则

1. **窗口是内容归属单位**：tab 的常规生命周期不跨窗口；唯一例外是 P7 的显式 tear-off / 跨窗口移动，必须走专用迁移原语，**不重建 WebContents**。
2. **运行时 id 与持久化 key 分离**：`BrowserWindow.id` 只在本次进程内有效；`windowKey`（18 位十六进制随机串，`crypto.randomBytes(9)`；恢复时由 `CreateWindowOptions.windowKey` 指定）用于会话与几何持久化。**tabId 全局唯一（带 `windowKey` 前缀）且在迁移前后保持不变**。
3. **推送事件带归属**：所有 `tab:*` 推送只发给 tab 所属窗口；事件处理必须按动态归属解析宿主，不得闭包旧 manager 实例。
4. **跨窗口只读共享**：下载列表、密码库的读取全局可见，写入仍走既有通道；渲染层 IndexedDB 写入不得做"全量替换"。
5. **`getMainWindow()` 是迁移期 shim**：仅供既有调用点过渡，新代码禁止使用；语义改为 `getFocusedRegisteredWindow()`。

---

## 6. 详细设计

### 6.1 窗口注册表（`src/main/modules/window.ts`）

新增/调整的导出：

| 接口 | 语义 |
| --- | --- |
| `createWindow(options?: CreateWindowOptions): BrowserWindow` | 可多次调用；注册并返回。`options` 含 `bounds?` / `windowKey?` / `index?` / `isPrimary?` |
| `getWindowById(id: number): BrowserWindow \| null` | 运行时 id 查找 |
| `getRegisteredWindows(): BrowserWindow[]` | 仅浏览器窗口，**不含**用户脚本后台隐藏窗口与 DevTools 窗口 |
| `getWindowForWebContents(wc): BrowserWindow \| null` | 主路径 `BrowserWindow.fromWebContents`，兜底显式 `wcId → window` 注册表 |
| `getFocusedRegisteredWindow(): BrowserWindow \| null` | 最近聚焦的已注册窗口（新名称） |
| `getMainWindow(): BrowserWindow \| null` | **兼容 shim（@deprecated）**：等价于 `getFocusedRegisteredWindow()` |
| `getWindowKey(win): string` | 稳定 key |
| `getWindowContext(win): { windowKey, index, isPrimary }` | 供 `win:get-context` |

实现要点：

- 显式注册表，**禁止**使用 `BrowserWindow.getAllWindows()`（userscripts `@background` 与 DevTools 窗口会混入）。
- 监听 `focus` 事件维护"最近聚焦窗口"，供 shim 使用；`closed` 时从注册表移除并通知 `disposeTabManager`。
- **首个创建的窗口 `isPrimary = true`**，用于会话迁移的单归属（6.5）。
- `createWindow` 内部不得再写模块级 `mainWindow`；所有窗口级事件（`restore`/`maximize`/`session-end`）在注册时按窗口绑定。

### 6.2 TabManager 多实例（`src/main/modules/tabs.ts`）

```ts
class TabManager {
  constructor(
    private readonly win: () => BrowserWindow | null,
    private readonly preloadPath: string,
  ) {}
  // 内部 5 处 getMainWindow() → this.win()
  // send() → 动态归属解析（见下）
}

function createTabManager(win: BrowserWindow, preloadPath: string): TabManager
function getTabManagerForWindow(runtimeId: number): TabManager | undefined
function findTabManagerByTabId(tabId: string): TabManager | undefined
function findTabManagerByWebContents(wcId: number): TabManager | undefined
function getTabManagerForSender(wc: Electron.WebContents): TabManager | undefined
function disposeTabManager(win: BrowserWindow): void   // destroyAll + 索引清理
```

**preload 注入是构造参数，不是事后 setter**：`tabs.ts:318` 的 `setPreload` 只有 `index.ts:144` 一个调用点，新实例若漏注入会得到空 `preload`，第二窗口的 Ruffle、userscript、密码桥全部失效。

**事件归属与迁移原语**（P3 定接口，P7 落地实现）：

```ts
interface DetachedTab { tabId: string; entry: TabEntry; view: BrowserView; }
detachForTransfer(tabId: string): DetachedTab | null
  // 删除 tabs / wcToId 条目；this.win()?.removeBrowserView(view)；
  // 卸载该 view 的事件监听；**不 destroy view，不 destroy wc**
adoptTransferred(tab: DetachedTab, index: number): void
  // 新宿主 addBrowserView(view)；setBounds；按新实例重装事件监听；
  // 重建 wcToId；恢复 zoom / muted；tabId 不变
```

- `_disposeView`（`tabs.ts:657-665`）会 `removeBrowserView` 并 `destroy()` WebContents，**迁移路径禁止复用它**。
- `create()` 遇到已存在的 tabId 会静默复用旧条目（`tabs.ts:389-398`）。tabId 唯一化后仍需在 `create` 里加 `log.warn`，避免撞 id 表现为"点了没出现"。
- `send()` 的归属必须能解析到 tab：签名改为 `send(channel, payload, ownerTabId = payload.tabId)`，优先 `findTabManagerByTabId(ownerTabId)?.win()`，否则退回 `this.win()`。注意 `tab:newwindow` 的 payload 只有 `{ url }`，调用处必须显式传当前 tabId，否则迁移后会发到旧窗口。
- **双重保险**：动态解析 + 迁移时重绑监听器。任意一侧漏掉，另一个窗口都收不到推送。

**兼容 facade**（保留 `export const tabManager`，降低 60 处调用的改造风险）：

| 方法类别 | 转发规则 |
| --- | --- |
| tabId 作用域（close / suspend / activate / navigate / back / forward / reload / stop / zoom / mute / devtools / find / stopFind / setRuffleMode / fillPassword / getUserscriptCommandsForTab / invokeUserscriptCommand / beginAutomation / inspectAutomationTarget / getWebContents / isTabActive / getTabIdForWebContents / getRuffleForWC） | `findTabManagerByTabId(tabId)` |
| 窗口作用域（create / setBounds / focusActive / getActiveId / getContainerRect / refreshActiveViewAfterHostRestore） | **由调用方显式传实例**；facade 只允许在无 sender 的旧调用点退化为 `getFocusedRegisteredWindow()` 的实例，并在日志里警告 |
| 聚合（getMemoryDiagnostics） | 遍历所有实例合并 |
| 广播（refreshPasswordCapture / refreshPasswordFill） | 遍历所有实例 |

`create`、`setBounds`、`focusActive`、`getActiveId`、`getContainerRect` 是**必须带窗口上下文**的方法：`tabs.ipc.ts` 用 `event.sender` 解析实例后直接调用，不再经过 facade。`getActiveId` 被工具箱/截图/HTTP 用作 `tabId ?? getActiveId()` 的兜底（`screenshot.ipc.ts:31`、`devtoolbox-snapshot.ts:63/82` 等），必须解析成**调用方所属窗口**的活动标签，不能是"聚焦窗口"。

### 6.3 IPC 路由协议

`ipc-wrapper` 新增（保留旧签名）：

```ts
createEventHandler<T, R>(channel, fn: (ctx: { event, window, args }) => R | Promise<R>)
createValidatedEventHandler<S, R>(channel, schema, fn)
```

| 通道组 | 路由依据 | 变更 |
| --- | --- | --- |
| `tab:create`、`tab:setBounds`、`tab:focusActive`、`tab:setViewVisibility`（新增） | `event.sender` → 窗口 → 实例 | 改为按 sender（`setBounds` 的 payload 仍是 rect，不需加 tabId；`setViewVisibility` 只影响活动视图的可见性，不改 `rect`） |
| `tab:close/suspend/activate/navigate/goBack/goForward/reload/stop/zoom/mute/devtools/find/stopFind/setRuffleMode` | `tabId` → 实例，并校验该 tab 属于 sender 窗口 | 增加越窗校验 |
| `win:minimize/maximize/unmaximize/close/setFullscreen/toggleFullscreen/isMaximized` | `event.sender` → 窗口 | 改为按 sender |
| `win:get-context`（新增） | `event.sender` → `{ windowKey, index, isPrimary, isMaximized, bounds }` | 新增；渲染层会话 key 与迁移归属都依赖它 |
| `win:new-window`（新增） | 任意窗口均可触发；`{ url?, bounds? }` | 新增 |
| `ui:set-language` | `event.sender` 必须是某个注册窗口的外壳 | 换 `getWindowForWebContents`，保留"广播所有 wc" |
| `tab:updated/tab:found/tab:load-error/tab:crashed/tab:newwindow/password:filled` | 由 tab 所属实例发送 | 只发所属窗口 |
| `tab:detached` / `tab:adopted`（新增） | 旧实例 → 旧窗口；新实例 → 新窗口 | P7 迁移用；新窗口必须等渲染层就绪后再发 |
| `ui:toast` / `automation-assistant:toast` | tab 所属窗口 | 改为按 tab 所属窗口发送（现在固定发主窗口） |
| `shortcut` | `before-input-event` 的 WebContents 所属窗口 | 改为按来源窗口 |

越窗校验规则：`tabId` 的归属窗口必须等于 `event.sender` 所属窗口，否则拒绝并记 `log.warn`。这既能防串窗，也能防渲染层被注入后跨窗口操作。

**三套白名单必须同步**（现状已漂移，`devtoolbox:frontend-intent` 是裸 `ipcRenderer.on`，不在白名单内）：

1. `preload/index.ts` 的 `ALLOWED_INVOKE_CHANNELS` / `ALLOWED_ON_CHANNELS`；
2. `renderer/types/electron.d.ts` 的 invoke 重载与 `win` 对象；
3. `shared/types/ipc.ts` 的 `IPCMainToRenderer` 与 `ShortcutAction`。

新增 `win:get-context` / `win:new-window` 时三处一起改，并在 P2 加一条静态单测：解析 preload 白名单与 `electron.d.ts`，断言新通道同时存在。

### 6.4 生命周期

| 事件 | 行为 |
| --- | --- |
| 二次启动 `second-instance` | `createWindow()` → 新窗口打开首页新标签（argv 带 URL 则打开该 URL）→ `show()` + `focus()` |
| 单窗口 `close` | 只销毁该窗口的 TabManager 与 BrowserView（`disposeTabManager`）；**不**标记正常退出；视图已随宿主销毁时跳过 `destroy()` |
| 最后一个窗口关闭 `window-all-closed` | **只决定是否退出**：Windows/Linux → `app.quit()`；macOS → 不退出，**不做任何 teardown** |
| `before-quit` / `will-quit` | 标记正常退出；落盘窗口几何与顺序；关闭 devtools 前端服务、workspace watcher、`devToolsBridge`、memory monitor、automation（OCR/vision）、aria2。全部必须幂等 |
| macOS `activate` | 无窗口时 `createWindow()` |
| `session-end`（Windows 关机） | 保留 `markCleanShutdown()` |
| `render-process-gone` | `getWindowForWebContents(wc)` → 只 reload 该窗口的外壳；`crashCount` **按窗口**计数；超阈值只重建该窗口，**不 `app.quit()`** |

macOS 分支必须与 teardown 迁移一起上线：否则会出现"进程活着、抽屉/下载/OCR 全死"的半死状态，`activate` 重建窗口也救不回来。

### 6.5 会话、几何与迁移

存储分工（v6 混淆，v7 明确）：

- **窗口几何与顺序**：`src/main/modules/window-state.ts`（electron-store），`windows: WindowState[]`，`WindowState = { key, bounds, maximized, index }`。
- **标签会话快照**：仍在渲染层 IndexedDB `db.meta`，key 改为 `tab-session:<windowKey>`（`TAB_SESSION_META_KEY` 仅保留为旧 key 常量）。

启动流程：

1. 主进程读 `windows`（无记录则建一个窗口，`isPrimary = true`）；
2. 按顺序 `createWindow({ bounds, windowKey, index, isPrimary })`；
3. 渲染层 `win:get-context` 取 `windowKey`，读写 `tab-session:<windowKey>`。

旧数据迁移（**单归属**，避免 v6 的 N 窗口抢同一快照）：

- 只有 `isPrimary` 窗口允许认领旧 `TAB_SESSION_META_KEY`；
- 条件：库中不存在任何 `tab-session:*` 且旧 key 有值；
- 顺序：写入 `tab-session:<primaryKey>` **成功后**再删旧 key；写入失败保留旧 key 并记日志（K6）；
- 非 primary 窗口**不得**读取或删除旧 key，也不得因"没有自己的快照"而删旧 key。

崩溃恢复（v6 的 `recoveryRequired` 全局清零会让第二个窗口读不到异常状态）：

- `session:recovery-status` 返回**启动时那一刻**的 `abnormalExit`，进程内只读；
- `session:resolve-recovery(windowKey)` 只记录该窗口已决策，不清全局；
- 每个窗口只恢复自己的 `tab-session:<windowKey>`；无快照时创建新标签，不动别人的 key。

tabId 唯一性：

- `services/id.service.ts` 生成 `tab-<windowKey 短后缀>-<Date.now()>-<counter>`；
- 恢复旧快照时，若快照内 id 与当前全局索引冲突，重新分配 id 并同步 store（id 只用于 IPC/Renderer 关联，不承载语义）；
- P3 的全局索引以此为前置；`create` 遇到重复 id 记 `log.warn`。

IndexedDB 并发（多窗口后从"理论问题"变成"必然问题"）：

- favorites 不能再 `clear() + bulkPut()` 全量替换（`useDataStore.ts:63-67`）：改为按 id `put`/`delete` 增量，或在同一事务内先读库再合并；
- settings 是整对象覆盖（`useDataStore.ts:158-165`）：写入前在同一事务内读最新库值再合并，避免窗口 A 的旧副本覆盖窗口 B 刚改的另一项；
- `DatabaseHydrator` 的 `useLiveQuery` 回灌不得触发写库（已有 `skipPersist`），且**水合完成前不得发** `theme:set-source` / `ui:set-language`（新窗口挂载即发会用默认值覆盖）；
- history 已是增量（`put`/`bulkDelete`），无需改。

### 6.6 横切模块适配

| 模块 | 规则 |
| --- | --- |
| 截图（IPC / HTTP） | 显式 tabId → 该 tab 所属窗口的 `rect` 与最小化状态；未指定 → **发起请求的窗口**（sender）的活动 tab；HTTP 口子仍退回"最近聚焦窗口"并记日志 |
| 自动化 | tabId → 实例；`getTabIdForWebContents` 走全局索引；仍在原窗口内保持"目标标签必须激活"的既有约束 |
| 开发者工具箱 | **每窗口独立一组**：bridge 实例、前端容器 BrowserView、collector 缓冲与 sink、targetId 解析；`isTrustedSender` 改为"属于该窗口自己的前端/外壳"；抽屉尺寸/停靠按窗口区分。**成本 L**（10.1 方案 A） |
| 密码 view gate | 属主 HWND 按发起请求的窗口参数化（`verify` / `authorizeView` / `password:reveal` 增 `ownerWin?`），setter 仅作兜底；5 次失败 30 分钟锁**保持全局**（同一 profile 的安全策略），需在 UI 提示与文档中明说 |
| 下载 | 进度/完成事件广播所有注册窗口；目录选择弹窗宿主 = sender 窗口（不用 `getFocusedWindow()`，它会命中独立 DevTools 窗口或隐藏窗口） |
| 内存监控 | **只做聚合**（`getMemoryDiagnostics` 遍历实例）。**不引入**"全局挂起预算"：当前不存在该机制，挂起是渲染层每窗口一套 timer（`useTabManager.ts:16`）。若确需预算，单独立项（主进程 governor + 推送 + 渲染层应答式改造） |
| 用户脚本 admin | 已带 tabId，走全局索引 |
| 快捷键 | 动作发**来源窗口**；`globalShortcut` 的 zoom 兜底按窗口 focus 注册/注销（每个窗口聚焦时注册自己的处理器、失焦注销；不要两个窗口同时注册，否则一次按键双发）；`startMouseHook` 只服务 Ctrl+滚轮的全局兜底，**不提供拖拽坐标**（见 6.8/K9） |
| 语言 / 主题 | 语言：`ui:set-language` 鉴权按 sender，广播逻辑保留；主题：`nativeTheme.themeSource` 是进程级，所有窗口天然一致，**无需按窗口改**，但挂载写入需等水合 |
| 助手 / 诊断 | `ui:toast`、`file:open-swf`、`diagnostics:export`、`userscript:open-in-tab` 全部按 sender 解析宿主 |

### 6.7 可观测性

- 所有窗口级日志加 `win=<runtimeId> key=<windowKey>` 前缀，便于排查串窗。
- 新增诊断项：窗口数、每窗口标签数、事件投递统计、`tabId` 冲突计数（可选，不强制）。
- 迁移、越窗拒绝、tabId 冲突一律 `log.warn`，便于事后从日志复现。

### 6.8 标签跨窗口迁移（tear-off / cross-window move）

**交互流程**

1. 标签上按下并拖动超过 6px 进入拖拽态。**现有实现是 HTML5 `draggable` + `dataTransfer`（`TopBar.tsx:126-148`、`TabItem.tsx:29-34`），只在同一渲染进程内有效，必须换成 pointer events**（`pointerdown/move/up` + `setPointerCapture`），并处理 `-webkit-app-region: drag` 区域的冲突。
2. 拖拽期间**隐藏当前窗口的活动 BrowserView** —— 新增 `tab:setViewVisibility({ visible: false })`（或等价 API），**不得复用 `tab:setBounds(-9999,-9999,1,1)`**：该 IPC 会写 `TabManager.rect`（`tabs.ts:332-337`），把容器矩形永久改成隐藏值，后续标签定位、自动化视口、截图 rect 全部错乱。
3. 用 `setPointerCapture` 保持指针事件，`Escape` 取消拖拽并恢复视图。
4. 释放点判定放在**主进程**：`screen.getCursorScreenPoint()` + 注册表窗口 `bounds` 判断落点：
   - 落在本窗口标签栏 → 仅重排序；
   - 落在其他窗口标签栏 → 跨窗口移动；
   - 落在窗口外 → 新建窗口（tear-off）。

**事件投递前提（P7 开工前必须验证）**：拖拽期间源窗口能否在指针离开窗口后继续收到 `pointermove` / `pointerup`。这依赖 Chromium 的 OS 级鼠标捕获，**probe 41 只验证了几何数学，没有验证事件投递**。P7 之前补 `probe 48-cross-window-drag`：

- 通过则直接按本方案实现；
- 不通过则降级：扩 `native/mouse-hook` 协议上报 `DRAG x y BUTTON`（需重编 win32/linux 二进制），**不要**再假设现有 mouse-hook 能兜底——它只输出 `ZOOM_IN`/`ZOOM_OUT`。

**迁移步骤（WebContents 不重建）**

1. 前置校验：该 tab 无自动化租约、无进行中的密码填充；否则拒绝并 toast 提示。
2. 目标窗口已存在则复用；否则 `createWindow({ initialBounds: dropPoint })`。**新窗口必须等渲染层就绪**（`did-finish-load` 或渲染层主动 `win:get-context` 握手）后才能接收 `tab:adopted`，否则事件必丢。
3. 旧 manager `detachForTransfer(tabId)`：删除 `tabs` / `wcToId` 条目 → `hostWin.removeBrowserView(view)` → 卸载事件监听；**不销毁 view、不 `destroy()` wc**。
4. 新 manager `adoptTransferred(tab, index)`：`win.addBrowserView(view)` → `setBounds` → 按新实例重装事件监听 → 重建 `wcToId` → 恢复 zoom / muted。**tabId 保持不变。**
5. 旧窗口收到 `tab:detached { tabId }`，新窗口收到 `tab:adopted { tab, index }`，渲染层据此增删 store 条目。
6. 旧窗口标签被拖空后**自动关闭**（Chrome 行为）；走 6.4 的"单窗口 close"，不标记正常退出。

**硬性约束**

- 禁止 `loadURL` / 重建 WebContents：登录态、Flash 播放进度、自动化资源都不能被打断。
- userscript 注册与 password capture 都按 `wc.id` 绑定，迁移窗口不需要重新注册；但 `registerView` 的 `token` 是 tabId，**tabId 必须不变**，否则需重注册。
- 迁移瞬间调用一次 `invalidate()`（Electron 11 无此 API，现有代码是 `best-effort` 调用，`tabs.ts:382`），并立即 `setBounds`。
- 事件必须"重绑 + 动态解析"双保险（6.2）：只重绑而 `send` 闭包旧实例、或只动态解析而 `_isCurrentWebContents` 仍查旧 `wcToId`，都会让迁移后的标签静默失去标题/加载态/地址栏更新。

**坐标**

新窗口以释放点为中心，并夹取到当前显示器工作区内，避免生成到屏幕外。

---

## 7. 实施计划（审核通过后按序执行）

> 每阶段独立提交、独立回滚。P1/P2 对外行为不变。

### P1 窗口注册表与生命周期

- [x] `window.ts` 引入注册表、`windowKey`、`index`、`isPrimary`；`createWindow(options?)`
- [x] `getFocusedRegisteredWindow()` + `getMainWindow()` 兼容 shim（标注 deprecated）
- [x] 移除逐窗口 `markCleanShutdown()`
- [x] `window-all-closed` 只决定是否退出；teardown（devtools 服务 / workspace watcher / bridge / memory monitor / OCR+vision / aria2）全部上移到 `before-quit`/`will-quit`，幂等
- [x] `render-process-gone` 按窗口路由、`crashCount` 按窗口
- [x] `index.ts` 按注册表为每个窗口绑定 `restore`/`maximize`/`session-end`
- 改动：`modules/window.ts`、`index.ts`
- 判据：单窗口行为不变；`before-quit` 后所有服务关闭一次；测试中可创建第二个窗口
- 验证：`npm run typecheck:main`、`npm run test:electron`
- **状态：已完成**。单测 `tests/window-registry.test.ts`（7 例）、`npm run typecheck`、`npm test -- --run`（137 文件 / 961 例）、`npm run build:main`、`npm run test:electron` 全绿；`render-process-gone` 的 teardown 与崩溃策略属 `index.ts` 入口逻辑，由代码审查 + electron smoke 覆盖（无独立单测）。

### P2 IPC 路由基建

- [ ] `ipc-wrapper` 新增带事件上下文的 handler 工厂
- [ ] `window.ipc` 全部按 sender 路由
- [ ] `tabs.ipc` 的 `tab:create` / `tab:setBounds` / `tab:focusActive` 按 sender；tabId 通道加越窗校验
- [ ] 新增 `win:get-context`（含 `windowKey` / `index` / `isPrimary`）、`win:new-window`
- [ ] `preload` 三套白名单同步 + `electron.d.ts` + `shared/types/ipc.ts`
- [ ] `ui:set-language` 鉴权改 `getWindowForWebContents`
- 改动：`utils/ipc-wrapper.ts`、`ipc/window.ipc.ts`、`ipc/tabs.ipc.ts`、`modules/ui-language.ts`、`preload/index.ts`、`renderer/types/electron.d.ts`、`shared/types/ipc.ts`
- 判据：单窗口全功能回归通过；新增白名单静态单测通过
- 验证：`npm run typecheck`、`npm run test:electron`

### P3 TabManager 多实例化

- [ ] 构造注入 `win` + `preloadPath`，替换 5 处硬编码
- [ ] 建立 tabId / wcId 全局索引与清理（`create` 撞 id 记 warn）
- [ ] tabId 全局唯一化（`id.service.ts` 带 `windowKey` 前缀）
- [ ] 实现 facade 转发、聚合、广播；`send()` 动态解析宿主
- [ ] 声明迁移原语 `detachForTransfer` / `adoptTransferred`（P7 落地实现）
- [ ] 窗口关闭时 `disposeTabManager`
- [ ] 落地 `probe 45-tab-manager-routing`
- 改动：`modules/tabs.ts`、`renderer/services/id.service.ts`、`index.ts`
- 判据：probe 45 双窗口标签事件互不串窗；第二窗口标签有 preload（Ruffle/userscript 可用）
- 验证：`npm run typecheck:main`、`npm run probe:deep`

### P4a 横切模块适配（不含工具箱）

- [ ] 截图链路按 tab 归属窗口（未指定时 sender 窗口）
- [ ] 自动化链路走全局索引
- [ ] view-gate 属主窗口参数化；明确全局锁
- [ ] 下载事件广播 + 目录弹窗宿主按 sender
- [ ] 内存监控聚合（不加预算）
- [ ] 快捷键按来源窗口路由；zoom 全局热键按窗口 focus 注册
- [ ] `ui:toast` / 诊断对话框 / `userscript:open-in-tab` 按 sender
- 改动：`modules/screenshot*.ts`、`ipc/automation-v3.ipc.ts`、`modules/automation/service-v3.ts`、`ipc/password.ipc.ts`、`modules/view-gate*.ts`、`modules/download*.ts`、`ipc/download.ipc.ts`、`modules/memory-monitor.ts`、`ipc/shortcut.ipc.ts`、`ipc/diagnostics.ipc.ts`、`ipc/automation-assistant-bridge.ts`、`ipc/userscripts.ipc.ts`
- 判据：R7 手工验收通过
- 验证：`npm run typecheck:main`、`npm run probe:deep`

### P4b 开发者工具箱每窗口独立桥（L）

- [ ] `DevToolsBridge` 从单例改为 `Map<winId, bridge>`，生命周期随窗口
- [ ] 工具箱前端容器 BrowserView 每窗口一个
- [ ] collector 缓冲 / sink / `describeContents` 按窗口归属
- [ ] `isTrustedSender` 改为"该窗口自己的前端或外壳"
- [ ] targetId 解析按窗口；抽屉尺寸/停靠状态按窗口
- 改动：`modules/devtoolbox*.ts`、`ipc/devtoolbox.ipc.ts`
- 判据：两个窗口同时打开抽屉、各自 attach 各自标签、互不干扰
- 验证：`npm run typecheck:main`、`npm run probe:deep`、P8 手工清单第 7 项
- **若 Chromium 87 并发桥出现不可接受问题：先记录阻塞证据再回退到单桥方案，不允许静默降级**

### P5 渲染层会话、恢复与几何

- [ ] `useTabManager` 使用 `windowKey` 分片会话；旧 key 仅 primary 窗口认领
- [ ] 崩溃恢复状态按窗口决策（主进程只读 + 按窗口 resolve）
- [ ] 收藏改增量写；settings 读改写合并；水合前不写库
- [ ] 窗口几何持久化（防抖 500ms）+ 启动按已存窗口数恢复
- 改动：`hooks/useTabManager.ts`、`services/tab-session.ts`、`services/db.ts`、`store/useDataStore.ts`、`components/data/DatabaseHydrator.tsx`、`modules/window-state.ts`（新增）、`preload/index.ts`
- 判据：R6 手工验收通过；两窗口同时加收藏/改设置不互相覆盖
- 验证：`npm run typecheck:renderer`、`npm run typecheck:preload`

### P6 新建窗口入口与平台行为

- [ ] `second-instance` → `createWindow()`（argv 带 URL 则加载该 URL）
- [ ] `Ctrl+N` 接入新建窗口（动作已在 `shortcut.ipc.ts:47`，渲染层 `App.tsx` 未处理）
- [ ] `Ctrl+Shift+W` 关闭当前窗口
- [ ] 右键链接菜单增加「在新窗口打开」（`tab:newwindow` 的 `disposition` 需要真正被消费）
- [ ] 窗口标题跟随活动标签：**在主进程 `tab:updated` 里调用 `win.setTitle()`**（不要只移除 `page-title-updated` 的 `preventDefault`——外壳 document.title 固定为 `'Bao — loaded'`，不会跟随标签）
- [ ] 新窗口默认地址 = `settings.homepage || about:newtab`（与正常启动一致）
- [ ] macOS `activate` 重建窗口
- 改动：`index.ts`、`ipc/shortcut.ipc.ts`、`renderer/App.tsx`、`preload/index.ts`
- 判据：R1、R4 手工验收通过；标题在两窗口各自跟随
- 验证：`npm run typecheck`、`npm run lint`

### P7 标签跨窗口迁移（tear-off）

- [ ] 落地 `detachForTransfer` / `adoptTransferred`，迁移时**重绑事件**且 tabId 不变
- [ ] 拖拽交互从 HTML5 `draggable` 改为 pointer events（`TopBar`/`TabItem`/`useTabManager`）
- [ ] 新增视图显隐 API（不复用 `tab:setBounds`）；`setPointerCapture` + `Escape` 取消
- [ ] 主进程落点判定（本窗口排序 / 跨窗口 / 窗口外新建），按 probe 48 结论决定是否需要扩 native 钩子
- [ ] 新窗口 `tab:adopted` 就绪握手
- [ ] 旧窗口标签拖空后自动关闭
- [ ] 自动化租约 / 密码填充进行中时拒绝迁移并提示
- [ ] 落地 `probe 46-tab-transfer`、`47-flash-tear-off`、`48-cross-window-drag`
- 改动：`modules/tabs.ts`、`modules/window.ts`、`ipc/tabs.ipc.ts`、`preload/index.ts`、`renderer/types/electron.d.ts`、`shared/types/ipc.ts`、`renderer/components/tabs/*`、`renderer/components/layout/TopBar.tsx`、`renderer/hooks/useTabManager.ts`、`renderer/store/useTabsStore.ts`
- 判据：R8、R9 手工验收通过；页面不重载，迁移后标题/加载态/地址栏继续更新
- 验证：`npm run typecheck`、`npm run probe:deep`

### P8 全量验证

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm run test:electron`
- [ ] `npm run probe:deep`（含 45~49）
- [ ] `npm run test:e2e`（多窗口下首个窗口的断言语义）
- [ ] `npm run test:smokes`（可选；先 `node scripts/ensure-build.cjs`）
- [ ] 第 8.3 节手工清单

---

## 8. 测试计划

### 8.0 已完成：阶段可行性探测（Electron 11.5.0 实测）

```
npx electron tools/probe/host-electron.cjs --only 38,39,40,41,42,43,44
→ 7 probes, 0 failed
```

| Probe | 对应阶段 | 验证内容 | 结论 |
| --- | --- | --- | --- |
| `38-electron11-api` | 全部 | Electron 11.5.0 的 20 项必需 API 存在；`setWindowOpenHandler` / `contentView` 确认不存在 | OK |
| `39-multi-window` | P1 | 两窗口 + 两 BrowserView 并存；关一个不影响另一个；`window-all-closed` 只在最后触发 | OK |
| `40-view-migration` | P3 / P7 | `removeBrowserView` → 另一窗口 `addBrowserView`：`wc.id` 与 pid 不变、文档**未重载**、监听器仍有效 | OK（范围有限，见下） |
| `41-drag-geometry` | P7 | `getCursorScreenPoint` / `getDisplayMatching` / workArea 夹取 / 窗口命中测试 | OK（仅几何，见下） |
| `42-cdp-dual-bridge` | P4b | 同一 browser ws 端点开两条独立连接、各 attach 不同 target、互不干扰、单独关闭不影响对方 | OK |
| `43-session-sharding` | P5 | 按 `tab-session:<key>` 分片、几何互不覆盖、旧 key 可安全迁移 | OK（语义模拟，见下） |
| `44-ipc-sender-routing` | P2 | 外壳 / BrowserView / 隐藏窗口三种 sender 均可归属到正确窗口 | OK（断言写法需修，见下） |

**已知边界（v7 新增，审核时必须一起看）**：

1. **probe 40 只证明"DOM 状态保留"**：它用 `data:` 页面 + `window.__migrateMarker`，**没有**覆盖 PPAPI/Flash 实例、`capturePage`、CDP、焦点/IME。R8 的"Flash 继续播放"必须由 `probe 47` 补证，不得引用 probe 40 作为证据。
2. **probe 41 只验证几何数学**：命中测试用的是写死的假矩形，**没有**验证"指针离开源窗口后还能否收到 `move`/`up`"。P7 的核心交互由 `probe 48` 把关（6.8）。
3. **probe 43 是文件语义模拟**：它用临时 JSON 文件模拟 electron-store 语义，不等于真实的 electron-store / IndexedDB 行为；P5 需补真实 store 的单测。
4. **probe 44 的 Electron 11 断言是自指的**：`senderFrameSupported` 由 `mainFrame !== undefined` 赋值后再断言为 `false`（`probes/44-ipc-sender-routing.cjs:60-69`），并没有检查 `event.senderFrame`。结论（Electron 11 无 senderFrame）仍然成立，但 P2 开工前应把该断言改成直接检查 `event.senderFrame`（或在注释里明确它等价于"mainFrame 不存在"）。
5. **probe 42 验证的是裸 CDP**，不是生产 `DevToolsBridge`；生产改造由 P4b + probe 45 覆盖。

**证据要求**：每次运行把 `--json` 输出落到 `artifacts/probes/`（文件名带日期），计划/PR 里附片段与时间戳。v6 的"7/7 通过"没有落盘证据，复核时无法复现（本次审计环境因沙箱拒绝命名管道，Electron 在创建第二个窗口时崩溃，只跑到 probe 38 OK）。

**探测得出的 3 条硬约束（已写进设计）**：

1. **Electron 11 没有 `event.senderFrame` / `WebFrameMain`（12 才有）** → P2 只能依赖 `event.sender`（WebContents）+ 显式注册表，不能靠 frame 级信息。
2. **`BrowserWindow.fromWebContents(view.webContents)` 在 Electron 11 能返回宿主窗口**，但这属于"恰好可用"；`wc.hostWebContents` 为 `null`（Electron 11 的 BrowserView 不提供）。
   → P1 的 `getWindowForWebContents` 必须以 `fromWebContents` 为主，并保留显式 `wcId → window` 注册表兜底（probe 44 的 `recommendation` 字段已记录）。
3. **跨窗口迁移确实不重建渲染进程**（probe 40 实测 `wc.id` 与 pid 均不变、marker 保留、无额外导航）→ P7 的 tear-off 方案成立，不需要为"页面会重载"准备降级方案。

### 8.1 单元测试（vitest unit）

新增 `tests/window-registry.test.ts`（本仓库单测直接放在 `tests/` 根目录，unit project 收录 `tests/**/*.{test,spec}.ts`）：

- 注册 / 注销 / `getWindowForWebContents` / shim 退化顺序
- 不把非注册窗口（模拟后台隐藏窗口）算入 `getRegisteredWindows`
- `isPrimary` 只有首个窗口为真
- 关闭单个窗口不标记 clean shutdown

新增 `tests/tab-manager-routing.test.ts`（mock electron）：

- 两个 manager 的 tabId 索引互不干扰
- facade 转发到正确实例
- 越窗校验拒绝
- `getMemoryDiagnostics` 聚合两窗口
- `create` 遇重复 tabId 记 warn

新增 `tests/tab-transfer.test.ts`：

- `detachForTransfer` 不销毁 view / wc
- `adoptTransferred` 后事件回调发往新窗口（重绑生效）
- tabId 迁移前后一致

新增 `tests/session-sharding.test.ts`（真实 electron-store 临时目录）：

- 分片 key、单归属迁移、失败不删旧 key
- 崩溃恢复状态按 `windowKey` 独立

新增 `tests/id-uniqueness.test.ts`：

- 两个窗口前缀下的 id 不冲突；恢复冲突 id 会重分配

### 8.2 集成 / 冒烟

- `npm run test:electron`：BrowserView 生命周期（现有）
- `npm run probe:deep`：manager + BrowserView 运行时
- 已落地（8.0）：`probes/38` ~ `probes/44` 共 7 个阶段可行性探测
- 实施阶段新增：
  - `probes/45-tab-manager-routing.cjs`：双窗口 TabManager 事件归属（**P3 开工前先落**）
  - `probes/46-tab-transfer.cjs`：真实 TabManager 实例间迁移（P7，替代 probe 40 的裸 BrowserView 验证）
  - `probes/47-flash-tear-off.cjs`：PPAPI BrowserView 迁移后仍出帧（`capturePage` 非空白）+ 页面 JS 状态保留（P7 前）
  - `probes/48-cross-window-drag.cjs`：指针离开源窗口后仍收到 `pointermove`/`pointerup`（P7 前；失败则走 native 钩子降级）
  - `probes/49-routing-smoke.cjs`：窗口标题 / zoom 全局热键 / `ui:toast` / 对话框属主 按窗口路由（P6 后）

### 8.3 手工验收清单

1. `npm start` → 双击图标两次 → 共 3 个窗口。
2. 窗口 A 开 3 标签、B 开 2 标签 → 标签栏不串、页面位置正确。
3. 关闭 A → B 的标签与页面不受影响，进程仍在。
4. 关闭 B → 进程退出；重启恢复两个窗口。
5. A 登录 4399 → B 打开 4399 保持登录。
6. B 打开密码本 → "填充当前页面"只作用于 B；A 连续输错 5 次后 B 也进入 30 分钟锁（**预期行为**，确认提示文案说明）。
7. 自动化工作台在 A 选择目标标签运行 → 不影响 B。
8. A 中 `Ctrl+N` → 新建窗口（而非新标签）。
9. 拖动标签到窗口外释放 → 生成新窗口，页面不重载、Flash 继续播放；新窗口内标题/加载态/地址栏继续更新。
10. 把标签拖到另一个窗口的标签栏 → 标签移动过去，原窗口保留其余标签；移动后的标签继续更新标题与 favicon。
11. 拖走旧窗口的最后一个标签 → 旧窗口自动关闭，且下次启动不做崩溃恢复提示。
12. 自动化运行中拖拽该标签 → 被拒绝并给出提示。
13. 两个窗口各打开抽屉 → 各自 attach 各自标签，关闭一个抽屉不影响另一个。
14. 关闭最后一个窗口（macOS）→ 进程不退出；再次激活 → 新窗口可用，抽屉/下载/OCR 仍工作。
15. 崩溃恢复：两窗口各开标签后强杀进程 → 重启后两窗口各自弹出恢复提示，恢复后标签归属正确、不重复。
16. 两窗口同时各加一个收藏 / 同时改不同设置项 → 重启后两条都在（不被全量覆盖）。
17. 窗口 B 中通过助手/诊断/打开 SWF 触发提示或对话框 → 都出现在 B，不跑到 A。
18. 窗口 B 聚焦时 Ctrl+滚轮缩放 → 生效（globalShortcut 兜底路径）。
19. 每个窗口标题跟随各自活动标签，互不覆盖。
20. `ui:set-language` 在两个窗口都能成功（非聚焦窗口启动时不报 `Invalid UI language request`）。

---

## 9. 风险与回滚

| 编号 | 风险 | 触发场景 | 对策 |
| --- | --- | --- | --- |
| K1 | 事件串窗 | 双窗口下标签标题/加载态互相污染 | 事件守卫加窗口归属；`send` 动态解析 + 迁移重绑双保险；P3 专项 probe 45 |
| K2 | 关窗误判正常退出 | 关掉非最后窗口后崩溃恢复失效 | P1 即移除逐窗标记，改 `before-quit` |
| K3 | CredUI 属主错误 | 验证框被压到其他窗口后面或无任务栏图标 | 属主参数化（按 sender），setter 仅兜底；禁止回退主窗口 |
| K4 | DevToolsBridge 冲突 | 两个窗口的抽屉互相抢 attach / 信任校验拒绝 | 每窗口一组实例；`isTrustedSender` 改为按窗口前端；双窗口同时开抽屉纳入 P8 验收；成本按 L 计 |
| K5 | 内存占用上升 | 多窗口各自挂起/保留标签，进程内存总量上升 | **本期不做全局预算**（现无该机制，挂起仍是每窗口 timer）；若后续需要，单独立项主进程 governor
| K6 | 旧会话丢失 | 首次升级时 key 变更导致标签不见 | 单归属迁移：先写新 key 成功再删旧 key；非 primary 窗口不碰旧 key |
| K7 | 隐藏窗口混入枚举 | 用户脚本后台窗口被当作浏览器窗口 | 只用显式注册表；`getWindowForWebContents` 对未注册窗口返回 null |
| K8 | 前台激活受限 | 二次启动新窗口不获得焦点 | 新建顶层窗口 + `show()` + `focus()` |
| K9 | 拖拽丢事件 | BrowserView 原生层盖住页面区域 / 指针离开窗口 | 拖拽开始即隐藏活动视图（专用 API）；`setPointerCapture`；**probe 48 先验证事件投递**，失败则扩 native mouse-hook 协议（现有钩子只报缩放，不能兜底） |
| K10 | 迁移后空白 / 闪烁 | Chromium 87 合成器表面重建 | 迁移后立即 `setBounds` + `invalidate()`（best effort）；必要时复用 `refreshActiveViewAfterHostRestore` 的隐藏→可见过渡 |
| K11 | 迁移打断自动化 / 密码填充 | tab 正被 CDP 租约占用 | 迁移前校验，直接拒绝并 toast 说明原因 |
| K12 | tabId 碰撞 | 两窗口同毫秒创建标签 | tabId 带 `windowKey` 前缀；全局索引冲突记 warn；恢复旧快照时重分配 |
| K13 | 迁移后标签"静默失联" | 事件监听闭包旧 manager / `_isCurrentWebContents` 查旧索引 | 迁移必须重绑监听器且 tabId 不变；probe 46 断言迁移后标题仍更新 |
| K14 | macOS 半死状态 | `window-all-closed` 提前 teardown 但进程不退出 | teardown 全部上移 `before-quit`；`window-all-closed` 只决定退出 |
| K15 | 崩溃扩散 | 一个窗口外壳崩溃被全局计数升级为整应用退出 | `crashCount` 按窗口；只重建该窗口 |
| K16 | 渲染层数据覆盖 | 两窗口并发写收藏/设置 | favorites 增量写；settings 事务内读改写；水合前不写库 |

**回滚策略**：P1/P2 纯基建，回滚无副作用；P3 是行为分水岭，回滚需同时还原 facade 与 tabId 生成；P4b（工具箱）独立提交，可单独回退到单桥；P5 保留旧会话数据直到首次成功写入；P7 独立提交，回退后拖拽退回 HTML5 行为（仅窗口内排序）。

---

## 10. 已确认决策

| 编号 | 问题 | 结论 |
| --- | --- | --- |
| Q1 | 新窗口默认打开什么？ | **跟随设置里的首页**：`settings.homepage \|\| about:newtab`，与正常启动完全一致 |
| Q2 | 新建窗口快捷键？ | **`Ctrl+N`**，与 Chrome 一致（`Ctrl+T` 仍是新标签；`new-window` 动作已存在但渲染层未接） |
| Q3 | 关闭所有窗口后下次是否恢复多窗口？ | **恢复**：退出时落盘窗口顺序、几何与各自会话 |
| Q4 | 开发者工具箱在多窗口下怎么处理？ | **A：每窗口独立桥**，双窗口可同时使用抽屉（严格对齐 Chrome）。成本按 **L** 计，见 10.1 |
| Q5 | `Ctrl+Shift+T` 最近关闭标签？ | 本期不做 |
| Q6 | R8/R9（tear-off 与跨窗口移动）是否仍在本期？ | **在本期实现**（2026-11-09 确认），由 P7 交付，独立提交、可单独回退 |
| Q7 | 工具箱每窗口桥的成本按 **L** 计是否接受？ | **接受**（2026-11-09 确认），按 P4b 全量实现，不降级到单桥 |
| Q8 | 收藏/设置的多窗口并发写入策略是否接受？ | **接受**（2026-11-09 确认）：收藏增量写、settings 事务内读改写、水合前不写库 |

### 10.1 Q4 落地方式（已选 A）

- 每个 BrowserWindow 持有独立的 DevToolsBridge 实例，`host` / `targetId` / CDP 会话 / 统计 / 前端容器全部按窗口隔离。
- 桥的生命周期跟随窗口：窗口关闭即关闭该桥的 ws、调试会话与前端容器。
- `isTrustedSender` 必须改为"属于该窗口自己的前端或外壳"，否则第二个窗口的抽屉会直接返回 `untrusted-sender`（不是冲突，是不可用）。
- 抽屉里的"桥接状态"按窗口独立展示，不跨窗口共享；抽屉尺寸/停靠状态也按窗口区分。
- 双窗口同时开抽屉纳入 P8 手工验收。若 Chromium 87 下并发桥出现不可接受的问题，**先记录阻塞证据再回退到 B**，不允许静默降级。

### 10.2 严格对齐 Chrome 的补充项（本轮一并纳入）

| 行为 | 现状 | 阶段 |
| --- | --- | --- |
| 二次启动新建窗口 | 只 `restore + focus` | P1 / P6 |
| `Ctrl+N` 新建窗口 | 动作已定义，渲染层未处理 | P6 |
| `Ctrl+Shift+W` 关闭当前窗口 | 未定义 | P6 |
| 右键链接「在新窗口打开」 | 只有「在新标签页打开」，且 `tab:newwindow` 的 `disposition` 未被消费 | P6 |
| 窗口标题跟随活动标签 | 固定应用名；外壳 document.title 是 `'Bao — loaded'`，移除 `preventDefault` 不够 | P6（主进程 `setTitle`） |
| 每个窗口独立的开发者工具箱 | 单桥 + 单前端容器 + 单窗口信任校验 | P4b |
| 每窗口独立位置 / 大小恢复 | 无 | P5 |
| 关闭最后一个窗口才退出 | 退出逻辑已有，但关任一窗口会误标正常退出 | P1 |

### 10.3 明确保留的差异（本期不做）

| 差异 | 原因 |
| --- | --- |
| `Ctrl+Shift+T` 最近关闭标签 | 已确认本期不做 |
| 隐身窗口 | 应用无此模式 |
| 多 Profile（Chrome 的"用户"概念） | 需要独立 userData，与密码库、下载目录冲突 |
| 窗口间标签实时同步 | Chrome 也不做 |

### 10.4 决策确认记录

| 编号 | 决策 | 确认日期 | 对计划的影响 |
| --- | --- | --- | --- |
| Q6 | R8/R9 在本期实现，允许开工 | 2026-11-09 | P7 保留；新增 probe 46/47/48 为 P7 前置 |
| Q7 | 工具箱每窗口桥按 **L** 接受 | 2026-11-09 | P4b 全量实现；10.1 的回退到 B 仅作为事故预案，不得预先降级 |
| Q8 | 并发写入策略（增量写 + 事务内合并）接受 | 2026-11-09 | P5 按 §6.5 实施；不启用"禁用第二窗口写入"的备选 |

---

## 11. 审核清单

请逐项确认；任一项打回则按意见修改后重新提交。

- [ ] 方案 B（单进程多窗口、共享 profile）符合预期，不要求多进程多实例
- [ ] **8.0 节的 7 个可行性探测结论已确认**，**并且接受 8.0 列出的 5 条"已知边界"**（Flash/拖拽事件未验证，由 probe 47/48 把关）
- [ ] 8.0 节列出的 3 条硬约束（无 `senderFrame`、`hostWebContents` 为 null、迁移不重建 wc）已接受
- [ ] 非目标（窗口间标签实时同步、独立 userData、多 Profile）可接受
- [ ] 需求 R1-R9 与验收标准覆盖了你的诉求，无遗漏
- [x] R8 / R9（tear-off 与跨窗口移动）纳入本期，由 P7 交付（Q6，2026-11-09 确认）
- [ ] 分阶段顺序与"P3 为行为分水岭"的安排可接受；P4 拆成 P4a / P4b
- [ ] 第 10 节决策（Q1 / Q2 / Q3 / Q4=A / Q5）无异议
- [ ] 10.2 的 Chrome 严格对齐补充项纳入本期范围
- [ ] 10.3 明确保留的差异可接受
- [x] 10.4 的 Q6/Q7/Q8 已确认（2026-11-09：Q6 在本期、Q7 接受 L、Q8 接受并发策略）
- [ ] 风险对策（尤其 K3 CredUI 属主、K4 每窗口独立桥、K9 拖拽事件投递、K13 迁移事件归属）可接受
- [ ] 允许新增文件：`modules/window-state.ts`、5 个单测、probe 45~49
- [ ] 允许修改 `id.service.ts` 的 tabId 格式（带 `windowKey` 前缀）

审核通过后，按第 7 节 P1 → P8 顺序实施，每阶段完成后汇报并等待确认是否继续。

---

## 12. 变更记录

### 12.1 v6 → v7（依据 2026-11-09 审计）

| # | 级别 | v6 问题 | v7 修正 |
| --- | --- | --- | --- |
| 1 | P0 | §5.3 写"本期不允许迁移"，R8/R9 却要求迁移 | §5.3 原则 1 改为"常规不迁移，唯一例外是 P7 专用迁移原语"；Q6 已确认保留（2026-11-09） |
| 2 | P0 | tear-off 未处理事件归属：监听器闭包旧 manager + `_isCurrentWebContents` 查旧索引 → 迁移后标签静默失联 | §6.2 增加 `detachForTransfer`/`adoptTransferred`、事件重绑 + `send` 动态解析；K13；probe 46 |
| 3 | P0 | tabId 全局索引与进程内计数器冲突 | §6.5 tabId 唯一性；K12；`id.service.ts` 列入 P3 |
| 4 | P0 | 工具箱"每窗口桥"实为信任模型重写，§3 只给一行 M | §3 四个文件、P4b 独立阶段、成本 L；10.1 明确 `isTrustedSender` |
| 5 | P0 | 会话/恢复/IndexedDB 多窗口竞争（单 key、全局 recovery、favorites 全量替换） | §6.5 重写：单归属迁移、恢复按窗口、增量写；K16；P5 |
| 6 | P0 | `window-all-closed` 的 teardown 未上移 | §6.4 teardown 全部移到 `before-quit`；K14；P1 |
| 7 | P0 | `render-process-gone` 未进影响面 | §6.4 按窗口路由与计数；K15；P1 |
| 8 | P1 | "复用 `tab:setBounds` 隐藏视图"会改写容器 rect | §6.8 改为专用显隐 API |
| 9 | P1 | 窗口标题通过移除 `preventDefault` 不会跟随标签 | §10.2 + P6：改为在 `tab:updated` 里主进程 `setTitle` |
| 10 | P1 | `registerZoomShortcuts` 只绑首窗口 | §6.6 按窗口 focus 注册；P4a |
| 11 | P1 | K9"鼠标钩子兜底"不成立（钩子只报缩放） | §6.8/K9 明确降级需扩 native 协议；probe 48 |
| 12 | P1 | view-gate 属主是单 setter，K3 无法按 sender | §6.6 参数化；全局锁明示；P4a |
| 13 | P1 | memory-monitor 无"挂起预算" | §6.6/K5 删除虚构预算 |
| 14 | P1 | `ui:set-language` 身份鉴权、`ui:toast`/诊断/`open-in-tab` 串窗 | §6.3/§6.6 按 sender；P2/P4a |
| 15 | P1 | 新 manager 漏注入 preloadPath | §6.2 构造注入；P3 |
| 16 | P1 | HTML5 draggable 不能在窗口外工作，计划未写替换 | §6.8/P7 明确替换 TopBar/TabItem |
| 17 | P1 | probe 41 只测几何、probe 40 不覆盖 Flash | §8.0"已知边界"；新增 probe 47/48 |
| 18 | P1 | probe 44 的 senderFrame 断言自指 | §8.0 边界 4；P2 前修正 |
| 19 | P2 | 规模统计偏乐观（36/22 文件） | §0 实测：37 调用点、28 个文件、22 通道；§3 完整表 |
| 20 | P2 | §3 表漏列 9 个文件 | §3 补 `diagnostics`/`assistant-bridge`/`download.ipc`/`ui-language`/`userscripts.ipc`/devtoolbox 四件套 |
| 21 | P2 | probe 结果无落盘证据 | §8.0 证据要求；`artifacts/probes/` |
| 22 | P2 | P3 判据依赖后置 probe 45 | P3 清单内直接落地 probe 45 |
| 23 | P2 | e2e 未纳入 | P8 增加 `npm run test:e2e` |
| 24 | P2 | §3 误列 `services/toast.ts` 为全局队列 | §3 标注"不需要改"（队列在 `useDataStore`） |

### 12.2 版本历史

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| v6 | 2026-11-09 | 7 个可行性探测通过；R8/R9 纳入 |
| v7 | 2026-11-09 | 依据审计修正范围矛盾、7 个 P0、12 个 P1、5 个 P2；补完整影响面、已知边界、探针 45~49 与验收项 |
| v7.1 | 2026-11-09 | Q6/Q7/Q8 决策确认（§12.3）：tear-off 在本期、工具箱按 L、并发写入策略接受；状态转为"待开工" |

### 12.3 v7.1 决策确认（2026-11-09）

| 编号 | 用户决定 | 落地要求 |
| --- | --- | --- |
| Q6 | "在本期，允许实现" | P7（tear-off / 跨窗口移动）保留在本期；P7 开工前必须先落 probe 46/47/48，事件归属（K13）与 tabId 不变是硬验收 |
| Q7 | "接受" | P4b 按每窗口独立 bridge + 前端容器 + collector 全量实现，成本 L；10.1 的回退到单桥仅作为事故预案，不得预先降级 |
| Q8 | "接受" | P5 按增量写 + 事务内合并实施（§6.5），不启用"禁用第二个窗口数据面板"的备选 |

审核清单中 Q6/Q7/Q8 一项已勾选；其余条目（方案 B、探测结论与已知边界、非目标、R1-R9、阶段顺序、风险对策、新增文件清单）仍待逐项确认后进入 P1。
