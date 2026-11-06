# 抽屉 DevTools 去端口改造（file:// + 独立分区 + 路径白名单）

- 日期：2026-11-06
- 状态：**规格已定，未开工**
- 关联：`2026-11-06-devtools-cdp-bridge-design.md`（桥 v2，默认关闭）
- 代码入口：`src/main/modules/devtoolbox.ts`、`src/renderer/components/devtools/*`

## 1. 目的

当前抽屉里的 DevTools 前端通过 `http://127.0.0.1:<系统分配端口>/devtools_app.html` 加载，
静态服务随应用生命周期监听。这带来两个问题：

1. **多一个监听端口**（虽然已随机化、只绑回环、随退出释放，但仍是"为了跑一个本地前端而开服务"）；
2. **origin 每次启动都变**（`http://127.0.0.1:<随机端口>`）→ localStorage 被 origin 隔离 →
   DevTools 的设置**每次重置**：显式选择的语言、面板宽度、Elements 侧栏 tab 顺序、实验开关。

目标：把前端改成 **`file://` 加载**（origin 恒为 `file://`），从而

- 删掉静态服务与它占用的端口；
- 前端设置跨启动保留。

`file://` 的代价是同源 —— 见 §5 铁律与 §4 的三层收敛。

## 2. 非目标

- 不动 CDP 端口。它是 Chromium 自己的 DevToolsHttpHandler，前端（或桥）要拿 CDP 数据流就得有它，
  且已随机化 + 只绑回环。
- 不改 DevTools 前端版本（仍是降级到 Chromium 87 的 M97 构建）。
- 不动标签页的 file:// 行为（用户打开本地 html / swf 的路径保持现状，见 §3 E10）。
- 不做"用户文档目录动态登记"那套白名单 —— 前端搬进独立分区后不需要（§3 E9/E11）。

## 3. 实测证据（全部真机，脚本在 `tools/devtools-spike/`）

| 编号 | 结论 | 脚本 |
| --- | --- | --- |
| E1 | `file://` 下 ES module / localStorage / fetch 本地 JSON **全部可用**；`origin` 恒为 `file://` | `file-origin-probe.cjs` |
| E2 | `file://` 父页 + `file://` iframe 能把**真实前端**跑起来（`Main._createAppUI: 8.6ms`） | `file-origin-probe.cjs` |
| E3 | 裸 `file://` iframe 越界能力：**能调 `parent.electronAPI`、读 `parent.localStorage`、`fetch` 读整个磁盘** | `file-origin-threat-check.cjs` |
| E4 | 标准 Chromium 的做法：把每个本地文档降级为**互相隔离的 origin**，连 parent 都读不到；`fetch` 到 `file://` 一律失败 | `chrome-file-origin-compare.cjs` |
| E5 | 路径白名单（`interceptFileProtocol` + 前缀校验）**有效**：自身资源正常，越界的 script/fetch 全部 block（含 `password-store.json`、`C:/Windows/win.ini`） | `file-guard-check.cjs` |
| E6 | **IPC `frameId` 无法区分调用者**：子帧调 `parent.electronAPI` 时走主帧 preload，主进程看到的 frameId 与主帧一致 → 不能靠来源帧校验封住父帧 API | `file-guard-check.cjs` |
| E7 | 独立 WebContents + `partition:'persist:devtools'` 与默认 session **存储互不可见**、**跨启动持久**、**没有 parent** | `partition-check.cjs` |
| E8 | 拦截器可以只挂在**指定分区**上：默认 session 完全不受影响 | `session-scoped-guard-runner.cjs` |
| E9 | `partition: 'persist:'`（空名字）**就是 default session**（对象恒等）→ 标签页与外壳共用 session | `intercept-scope-runner.cjs` |
| E10 | 白名单若挂在默认 session，本地 `.swf` 会 `ERR_ACCESS_DENIED`、本地 html 变错误页（`origin: null`、同级脚本 MISSING） | `swf-allowlist-runner.cjs`、`tab-local-file-check.cjs` |
| E11 | 在**前端私有分区**挂白名单时：默认 session（外壳 + 标签页 + 本地文件）跨目录、任意目录、`win.ini` 全部照常可读 | `session-scoped-guard-runner.cjs` |
| E12 | 抽屉拖拽的 bounds 同步**零延迟**：逐帧记录两侧，页面视口跟上布局中位 0–1ms、最大 9ms（<1 帧）；dpr=1.5 下亚像素缝为 0 | `drag-tear-frames.cjs`、`drawer-drag-tear-check.cjs` |
| E13 | 独立窗口加载真实前端（ws 直连）**已经跑通**：Elements 树正常渲染 | `dock-switch-check.cjs` |

E9/E10 是本规格的转折点：**白名单不能挂在默认 session**（会砸掉本地文件浏览），
只能挂在前端的私有分区；而"私有分区"要求前端不再是外壳的 iframe 子帧（子帧继承 host session）。

## 4. 目标架构

```
外壳 renderer（file://，default session）
 └─ 抽屉（HTML flex 子项，4 种停靠：bottom / left / right / undocked）
     └─ #devtools-host（占位 div，只负责报矩形）
          ⇢ BrowserView（原生视图，bounds 由渲染层逐帧同步）
               └─ DevTools 前端 WebContents
                    · URL：file:///<dist>/devtools_app.html?ws=127.0.0.1:<cdp>&can_dock=true
                    · session：persist:devtools（独立存储分区）
                    · 白名单：只允许 App 目录（dist/devtools-frontend、dist/renderer）
                    · 没有 parent → 拿不到 shell 的 electronAPI / IndexedDB / DOM

标签页 BrowserView（persist: → 实为 default session，无拦截器）
```

三层收敛（对应 E3 的三条越界能力）：

| 越界能力 | 收敛手段 |
| --- | --- |
| 调 shell 的特权 API | **无 parent**（独立 WebContents + 独立 frame 树） |
| 读 shell 的存储（历史/收藏） | **独立分区** `persist:devtools`（E7） |
| 读磁盘 | **分区级路径白名单**（E5/E8/E11） |

三者缺一不可：白名单封不住 parent API（E6），分区隔离封不住读盘（读写走 URL loader）。

## 5. 铁律

- **B1｜白名单只挂在前端分区**。挂到默认 session 会砸掉本地 `.swf` / 本地 html（E10）。
- **B2｜前端不得是外壳的 iframe 子帧**。子帧继承 host session，分区与白名单都无从谈起。
- **B3｜白名单必须 realpath 归一化后做前缀比较**（尾分隔符），防 `..` 与 Windows junction。
- **B4｜回退开关必须保留**：环境变量 `BAO_DEVTOOLS_LEGACY_HTTP=1` 时走旧的 http iframe 路径。
- **B5｜不落流量**：桥/日志只记条数与字节，不记 CDP 内容（沿用桥 v2 的 B4）。

## 6. 批次划分

### B1 前置闸门

1. ~~**`file://` 页面能否 `new WebSocket('ws://127.0.0.1:<port>')`**~~ **已通过**
   （`file-ws-gate.cjs`：`{"ws":"OPEN","secure":true,"origin":"file://"}`，只有"页面无 CSP"的常规告警）。
   ⇒ 去端口后前端可继续**自连 CDP**，不必提前改 preload 传输。
2. **`can_dock=true` 在 file:// 下是否仍生效**（应有：它只读 query 参数，与协议无关）。
3. **白名单在 `persist:devtools` 上对**前端自己的**资源无副作用**（E5 已在默认 session 验过，
   需在该分区复验一次）。

### B2 换容器（不碰 URL、不碰端口）

- 主进程：`createDevToolsView()` / `setDevToolsViewBounds()` / `destroyDevToolsView()` + 三个 IPC；
  视图挂在主窗口上，`webPreferences: { partition: 'persist:devtools', contextIsolation: true }`。
- 渲染层：`DevToolsTab` 的 `<iframe>` → `#devtools-host` 占位 div；ResizeObserver 上报矩形；
  卸载/切标签时销毁视图。
- URL 仍是 http（静态服务照旧），以便单独回归容器本身。

### B3 去端口

- URL 换成 `file:///<dist>/devtools_app.html?...`；
- 在 `persist:devtools` 上挂路径白名单（App 目录）；
- 删除静态服务（`ensureFrontendServer` / `frontendServer` / MIME 表 / 端口解析中的前端部分）；
- 独立窗口（undocked）同样走 file://。

### B4 桥传输迁移（可选，可延后）

- 桥 v2 目前靠"iframe 内 postMessage → 外壳中继"，容器换了就没有 parent。
- 改为：前端 preload 暴露 `bfbBridge.{send,onEvent}` → IPC → 主进程桥。
- 桥默认关闭，故可延后；但 B3 之后 `BAO_DEVTOOLS_BRIDGE=1` **必须明确报错**而不是静默失效。

### B5 清理与回归

- 删除 `useDevToolsBridgeRelay` 的 postMessage 路径（或整体替换为 preload 版）；
- 文档：`docs/modules/12-devtoolbox.md` §8 重写端口与安全章节；
- 记忆与 AGENTS.md 的端口策略表格更新。

## 7. 验收标准

| 项 | 判据 |
| --- | --- |
| 无静态服务端口 | 启动后 `netstat` 里不再有前端静态服务；三处探针（`dock-switch-check`）仍能列出前端 target |
| 设置持久 | 在 DevTools 里把语言显式改成英文 → 重启 → 仍是英文（当前必丢） |
| 前端隔离 | 从前端 target 求值：`typeof window.parent.electronAPI === 'undefined'`、`fetch('file:///C:/Windows/win.ini')` 失败 |
| 本地文件不受影响 | 打开本地 `.swf` 与本地 html（含同级 js/css/fetch、跨目录引用）全部正常 |
| 四模式停靠 | bottom / left / right / undocked 的抽屉矩形、页面区矩形、被调试页视口与当前一致（1280×264 / 742×711 / 742×711 / 1280×711） |
| 拖拽 | 逐帧延迟仍为 <1 帧（复用 `drag-tear-frames.cjs`） |
| 密码链路 | 前端存活期间 `[PasswordCapture] attached` 正常、无 `unmanaged client` 冲突 |
| 质量门 | typecheck 0 错、lint 0 警、865 单测全过、`dock-shell-check` / `bridge-check` 可复跑 |
| 回退 | `BAO_DEVTOOLS_LEGACY_HTTP=1` 时行为与改造前完全一致 |

## 8. 风险与回滚

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| `file://` 连不上 `ws://127.0.0.1`（B1.1） | **高** | 闸门先测；不通则前端改走 preload IPC，工期 +1 批 |
| 原生视图在 4 种停靠下的 bounds 抖动 | 中 | E12 已证底部模式零延迟；左右模式复用同一套同步逻辑，用同一探针复测 |
| 拖拽时原生表面 1 帧残影 | 中 | 预留"拖拽中隐藏视图、显示占位色带"的降级开关 |
| 白名单误伤前端自身资源 | 中 | 上线前在真实 dist 上跑 E5 的白名单探针 |
| `persist:devtools` 首次创建时是空存储 | 低 | 首次启动等于现状（默认跟随系统语言），可接受 |
| 删静态服务后探针全部失效 | 低 | 探针改为直连 CDP 端口（本来就支持） |

回滚：保留 `BAO_DEVTOOLS_LEGACY_HTTP=1` 分支一个版本周期；确认稳定后再删。

## 9. 影响面矩阵

| 模块 | 影响 | 说明 |
| --- | --- | --- |
| `devtoolbox.ts` | **中改** | 前端静态服务删除；新增视图生命周期与白名单 |
| `DevToolsTab.tsx` | 中改 | iframe → 占位 div + 矩形上报 |
| `useDevToolsBridgeRelay.ts` | 待定 | B4 之前保留但仅 iframe 回退路径使用 |
| `DevToolDrawer.tsx` | 小改 | 内容区换承载方式；四种停靠不变 |
| 密码 / 自动化 / cdp-lease | **零** | 桥与 embedded 均不受影响（E5–E8 已证） |
| 标签页 / 下载 / 会话 / 用户脚本 | **零** | 默认 session 不挂任何拦截器（E11） |
| 打包 | 小改 | file:// 路径要兼容 asar（`app.getAppPath()`） |

## 10. 遗留

- 独立窗口（undocked）在改造后仍会重载前端（换容器必然重建 WebContents），状态不保留 —— 与现状一致。
- 前端设置里"面板宽度 / dockSide"会被 DevTools 自己的 UI 改动，但我们的容器不读它，
  只影响它内部布局；改造后它们能持久，属附带收益。
- B1.2 / B1.3 两个闸门在 B2 开工前一并跑掉。
