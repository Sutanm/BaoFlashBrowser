# DevTools CDP 桥 v2（IPC + flatten session）设计 —— 规格

> 目的：把抽屉 DevTools 从「前端 page-ws 直连 target」改为「前端 ↔ 主进程桥 ↔
> flatten session」。解决三件已确证的痛点：① 切标签 iframe 重载 → Elements/Console
> 状态全丢；② 前端与 agent 之间没有可插入的仲裁层（过滤/审计/限流无处落）；③ 每增加
> 一个 CDP 消费者都要单独设计连接方式。
>
> **非目标**（明确不承诺）：去端口（flatten 仍走 CDP 端口，已随机化，见 343695e）、
> 替换前端版本（维持 M97，见 §1 的容器方案评审）、多标签同时调试的 UI（v1 只跟
> 活动标签）。
>
> 上游：`docs/modules/12-devtoolbox.md` §8（停靠壳、目标跟随、共存矩阵）、
> `tools/devtools-spike/` 的 S1–S8 探针（全部 Electron 11 / Chromium 87 真机）。

## 0. 现状（2026-11-06 核实）

| 环节 | 现状 |
|---|---|
| 前端入口 | `devtools_app.html?ws=127.0.0.1:<cdp>/devtools/page/<id>&can_dock=true`（`devtoolbox.ts` 的 `getDevToolsTargetUrl`） |
| 连接方式 | iframe 内 M97 前端直连 page-ws（Chromium 的 `/devtools/page/<id>` 端点） |
| 目标跟随 | 主进程 `tabTargetBindings`（tabId → targetId，74b7e0d）；切标签 → URL 变 → iframe 重载 |
| 无 target 语义 | `{ url, reason }` 三态（未做 no-target / no-port / ok，925ceb7） |
| 端口 | `appendSwitch('remote-debugging-port','0')`，Chromium 随机分配，`DevToolsActivePort` 发现（343695e） |
| embedded 通道 | 密码 capture/fill 长期/短时 attach；automation 经 `cdp-lease` 短租约；**桥 v2 不碰它** |
| 既有"桥" | `page-bridge`（BrowserView preload ↔ 用户脚本）、contextBridge（preload IPC）——与桥 v2 同属"不可信侧 ↔ 特权侧"模式，但代码零复用 |

## 1. 实测证据（决定设计的事实，全部真机）

| 编号 | 结论 | 探针 |
|---|---|---|
| S1 | page-ws × 2 共存，双方 evaluate 全通 | `cdp-coexist-check.cjs` |
| S2 | page-ws + browser 级 `Target.attachToTarget(flatten)` 共存，事件互通 | `cdp-coexist-check.cjs` |
| S3 | embedded + page-ws × 2 共存；**flatten evaluate 在应用本体报"域未找到"**（最小 runner 不复现，前置待查） | `cdp-coexist-check.cjs` |
| S4 | `openDevTools`（detach/docked）与 `wc.debugger` 共存（两种顺序） | `cdp-opendevtools-coexist.cjs` |
| S5 | `setDevToolsWebContents` 容器方案成立（bounds 全控、免端口），但承载的是 **87 内置前端且不可替换**，`isDevToolsOpened` 恒 false | `cdp-container-check.cjs` |
| S6 | attach 阻塞页面脚本在本地 JSONP 证伪（五场景耗时持平 104–115ms）；7k7k landmine 是站点特定条件 | `attach-block-check.cjs` |
| S7 | flatten session 与 embedded attach/detach/re-attach **零耦合** | `flatten-embedded-check.cjs` |
| S8 | **contextBridge 不注入抽屉 iframe**（`nodeIntegrationInSubFrames` 默认 false）→ 桥前端侧必须 postMessage 中转 | `s8-debug-targets.cjs` |

S5 是"为什么不用容器方案"的完整答案；S7 是"桥可以走 flatten 而不必碰 embedded"的依据。

## 2. 铁律

- **B1 桥不碰 embedded**：桥只走 browser-level ws + flatten session。密码 capture/fill、
  automation 的 `cdp-lease` 保持原样。桥与 embedded 无共享状态、无复用器、无互斥协调。
- **B2 双模式可回退**：URL 带 `ws` 参数 → 走现行 page-ws；不带 → 走桥。开关为
  env（`BAO_DEVTOOLS_BRIDGE`），默认关，验收通过后默认开。回退 = 关开关，不改代码。
- **B3 前端 patch 只加不替**：IPCConnection 作为 Connection 工厂的新分支加入，
  WebSocketConnection 原路保留（老入口与对拍探针继续可用）。
- **B4 流量不落日志**：CDP 消息含页面数据（含凭据字段），日志只记条数/字节/耗时统计。
- **B5 双向来源校验**：iframe → 外壳只接受 `http://127.0.0.1:<staticPort>` 的消息
  （`event.origin` 精确匹配）；外壳 → 主进程只接受外壳 renderer 的 IPC
  （`event.sender === 主窗口 webContents`）。

## 3. 架构

```
M97 前端（iframe, http://127.0.0.1:<static>）
   │  postMessage（CDP 消息封装，origin 校验）
   ▼
外壳 React（DevToolsTab 内的 bridge 中继）
   │  IPC: devtoolbox:bridge-send（invoke）/ devtoolbox:bridge-event（push）
   ▼
主进程桥（devtoolbox-bridge.ts）
   │  browser ws → Target.attachToTarget({targetId, flatten:true})
   ▼
各 target agent（session 隔离，域状态互不干扰）

密码 capture / fill、automation ── embedded（wc.debugger）── 直达 agent（不变）
```

## 4. 协议

**iframe ↔ 外壳**（postMessage，`{ source: 'bfb-devtools', ... }`）：

| 方向 | 消息 | 说明 |
|---|---|---|
| → 外壳 | `{ kind: 'cdp', id, method, params }` | 一条 CDP 命令 |
| 外壳 → | `{ kind: 'result', id, result }` / `{ kind: 'error', id, error }` | 命令响应（id 配对） |
| 外壳 → | `{ kind: 'event', method, params }` | 域事件 |
| 外壳 → | `{ kind: 'attached', targetId }` / `{ kind: 'detached', reason }` | session 生命周期 |

**外壳 ↔ 主进程**：`devtoolbox:bridge-send`（invoke，返回响应）；`devtoolbox:bridge-event`
（webContents.send 推送事件）。**合批**：`event` 类消息按 16ms 窗口合并成数组下发，
避免 Network 面板事件风暴逐条跨 IPC。

**桥内部**：`browser ws` 只在启动时连一次（`/json/version` 的 `webSocketDebuggerUrl`，
从 `DevToolsActivePort` 第二行取路径）；每个活动 target 一个 flatten session；
`sessionId → targetId` 表；target 关闭（`Target.targetDestroyed`）时清理并推
`detached`。

**前端 patch**（`scripts/build-devtools-frontend.cjs` 的 SOURCE_PATCHES，
`core/sdk/sdk.js` 的 Connection 工厂）：无 `ws` 参数且 `window.__bfbBridge` 存在时
构造 IPCConnection（postMessage 收发 + id 配对 + 事件分发）；否则原路。

## 5. 影响面矩阵（2026-11-06 审计）

| 模块 | 影响 | 备注 |
|---|---|---|
| `password-capture.ts` / `password-fill.ts` / `view-gate.ts` / `password-store.ts` | **零** | embedded 通道原样；S7 证零耦合 |
| `cdp-lease.ts` + automation（`browserview-input-service.ts`、`game-surface-detector.ts`） | **零** | 租约语义不动 |
| `session-manager.ts` / `proxy.ts` / `flash.ts` / `tabs.ts` / `download.ts` / `userscripts/*` | **零** | 无 CDP 交集 |
| `screenshot-http.ts` / `app-update.ts` | **零** | 无关 |
| 865 单测 | **零** | 不涉及 |
| `scripts/build-devtools-frontend.cjs` | +1 SOURCE_PATCH | 未命中即构建失败（既有兜底） |
| `src/preload/index.ts` | +1 API / +2 channel | `devtoolsBridge`（send/onEvent），白名单同步 |
| `src/main/modules/devtoolbox.ts` | 新增桥模块 + `getDevToolsTargetUrl` 改签名 | 绑定表（tabId→targetId）复用为路由依据，不废弃 |
| `src/main/ipc/devtoolbox.ipc.ts` | +2 channel | bridge-send / bridge-event |
| `src/renderer/components/devtools/DevToolsTab.tsx` | 中改 | 跟随逻辑从"URL 重载"改为"桥切 session"；iframe 不再随 targetId 重载 |
| `src/renderer/index.html` CSP | **零** | postMessage 不归 `connect-src` 管；`frame-src` 已有 |
| 探针 `tab-switch-check.cjs` / `dock-shell-check.cjs` | 适配 | 断言从"iframe URL 变化"改为"面板内容变化"；`page-elements-repro` 等旧探针保留 ws 入口对拍 |

## 6. 批次与验收

### B1 前置探针（不做完不进 B2）

1. ~~**S3 之谜复验**~~ **已通过（2026-11-06，`flatten-app-mystery.cjs`）**：应用本体上
   flatten evaluate 在「flatten only / +1 page-ws / +2 page-ws / detach 后重连」四种组合
   下全部正常（`flat:2`）。S3 当时的"域未找到"是瞬时竞态（attach 后立即 evaluate，域尚未
   就绪），不是结构性冲突——桥实现里 attach 后需等 `Target.attachedToTarget` 或首条
   事件再放行前端流量。**不再作为风险项。**
2. **7k7k 真站定级**：抽屉（桥模式）开着 + 密码捕获 + automation 输入，三线并行是否互相
   影响（S6 只证了本地 JSONP）。
3. **IPC 负载基线**：Network 面板重站点（如 7k7k）下桥的 IPC 消息速率与主进程 CPU。

### B2 主进程桥
flatten client + 路由 + session 生命周期 + 合批下发 + 统计日志。

### B3 前端 IPCConnection
构建脚本 patch + polyfill 环境桥接（iframe 内 `window.__bfbBridge` 由外壳注入）。

### B4 渲染层中继与跟随改造
DevToolsTab 内 postMessage 中继（origin 校验）+ 切标签指令；`dock-shell-check` /
`tab-switch-check` 适配。

### 验收标准
- **切标签不重载**：切到另一标签，iframe DOM 节点保持（不重建），面板内容切换 < 300ms；
  切回原标签，Elements 选中状态保留。
- **同标签导航**：面板自动跟随（现状已达成，不得回退）。
- **密码链路**：桥开启时 7k7k 密码捕获/填充正常（真机复验）。
- **稳定性**：Network 面板重站点 5 分钟无消息丢失/乱序；主进程 CPU 增量 < 10pp。
- **回退**：`BAO_DEVTOOLS_BRIDGE=0` 立即可用 page-ws 模式，行为与 925ceb7 一致。
- **质量门**：typecheck 0 错、lint 0 警、865 单测全过、S1–S8 探针可复跑。

## 7. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| IPC 高频负载（Network 事件风暴） | 中 | 16ms 合批；真站 CPU 基线（B1.3）；超阈值降级为"事件抽样 + 恢复时全量拉取" |
| browser ws 单 client 被桥独占 | 中 | 审计确认现无其他消费者（探针只连 page 端点）；桥崩溃时自动重连该 ws |
| S3 之谜（应用内 flatten 异常） | ~~中~~ **已排除** | S9 复验：应用本体 flatten evaluate 四组合全通；原失败是 attach 后立即 evaluate 的竞态，桥实现需等 attached 事件再放行 |
| 前端 patch 上游漂移 | 低 | SOURCE_PATCHES 未命中即构建失败 |
| iframe origin 校验绕过 | 低 | origin 精确匹配静态服务端口；静态服务只绑回环、端口随机 |

## 8. 边界

- **不做**：去端口（flatten 依赖 CDP 端口）；替换 M97 前端（S5 已堵死容器路线）；
  多标签同时调试的 UI；把密码模块迁到桥（S7 证明没必要）。
- **假设**：`DevToolsActivePort` 第二行（browser ws 路径）在 Chromium 87 稳定可用
  （343695e 已实测写入）。
- **遗留**：`no-target` / `no-port` 三态由 925ceb7 落地，桥沿用同一契约。
