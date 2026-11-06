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

| 环节          | 现状                                                                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------------------- |
| 前端入口        | `devtools_app.html?ws=127.0.0.1:<cdp>/devtools/page/<id>&can_dock=true`（`devtoolbox.ts` 的 `getDevToolsTargetUrl`） |
| 连接方式        | iframe 内 M97 前端直连 page-ws（Chromium 的 `/devtools/page/<id>` 端点）                                                    |
| 目标跟随        | 主进程 `tabTargetBindings`（tabId → targetId，74b7e0d）；切标签 → URL 变 → iframe 重载                                         |
| 无 target 语义 | `{ url, reason }` 三态（未做 no-target / no-port / ok，925ceb7）                                                         |
| 端口          | `appendSwitch('remote-debugging-port','0')`，Chromium 随机分配，`DevToolsActivePort` 发现（343695e）                        |
| embedded 通道 | 密码 capture/fill 长期/短时 attach；automation 经 `cdp-lease` 短租约；**桥 v2 不碰它**                                            |
| 既有"桥"       | `page-bridge`（BrowserView preload ↔ 用户脚本）、contextBridge（preload IPC）——与桥 v2 同属"不可信侧 ↔ 特权侧"模式，但代码零复用               |

## 1. 实测证据（决定设计的事实，全部真机）

| 编号 | 结论                                                                                               | 探针                             |
| -- | ------------------------------------------------------------------------------------------------ | ------------------------------ |
| S1 | page-ws × 2 共存，双方 evaluate 全通                                                                    | `cdp-coexist-check.cjs`        |
| S2 | page-ws + browser 级 `Target.attachToTarget(flatten)` 共存，事件互通                                     | `cdp-coexist-check.cjs`        |
| S3 | embedded + page-ws × 2 共存；**flatten evaluate 在应用本体报"域未找到"**（最小 runner 不复现，前置待查）                  | `cdp-coexist-check.cjs`        |
| S4 | `openDevTools`（detach/docked）与 `wc.debugger` 共存（两种顺序）                                            | `cdp-opendevtools-coexist.cjs` |
| S5 | `setDevToolsWebContents` 容器方案成立（bounds 全控、免端口），但承载的是 **87 内置前端且不可替换**，`isDevToolsOpened` 恒 false | `cdp-container-check.cjs`      |
| S6 | attach 阻塞页面脚本在本地 JSONP 证伪（五场景耗时持平 104–115ms）；7k7k landmine 是站点特定条件                               | `attach-block-check.cjs`       |
| S7 | flatten session 与 embedded attach/detach/re-attach **零耦合**                                       | `flatten-embedded-check.cjs`   |
| S8 | **contextBridge 不注入抽屉 iframe**（`nodeIntegrationInSubFrames` 默认 false）→ 桥前端侧必须 postMessage 中转     | `s8-debug-targets.cjs`         |
| S9 | 应用本体上 flatten 四组合全部正常；S3 的"域未找到"是 attach 后立即 evaluate 的瞬时竞态，**非结构性冲突**                    | `flatten-app-mystery.cjs`      |
| S13 | 桥自身的 DOM 域正常（getDocument/requestChildNodes/11 条事件）；"桥 DOM 坏"是环形缓冲被噪音冲掉的假象                     | `bridge-dom-domain-check.cjs`  |
| S14 | **page-ws 基线逐条录流**：前端自己发 `setAutoAttach`+`setDiscoverTargets`，收到**全部** page target 的 `targetCreated`（`attached:true`）、**事件全无 sessionId**、从不发 `attachToTarget` | `page-ws-baseline-capture.cjs` |
| S15 | Elements 树残缺的真因：**响应与事件走了两条路，顺序错乱**；同一 fixture 桥里画的是 html 下的注入层，真实 body 只有 `div#mark`+徽标        | `bridge-mode-check.cjs`        |
| S16 | 桥模式切标签热切换成立：`iframe reloaded=false`，树跟随新标签，桥重放 32 条域开关命令                                          | `bridge-tab-switch-check.cjs`  |

S5 是"为什么不用容器方案"的完整答案；S7 是"桥可以走 flatten 而不必碰 embedded"的依据；
S14 是"Target 域该怎么模拟"的唯一权威口径（此前两轮基于推理的伪造全是错的）；
S15 是"桥必须保持单流有序"的证据。

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

| 方向   | 消息                                                                | 说明           |
| ---- | ----------------------------------------------------------------- | ------------ |
| → 外壳 | `{ kind: 'cdp', id, method, params }`                             | 一条 CDP 命令    |
| 外壳 → | `{ kind: 'result', id, result }` / `{ kind: 'error', id, error }` | 命令响应（id 配对）  |
| 外壳 → | `{ kind: 'event', method, params }`                               | 域事件          |
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

| 模块                                                                                           | 影响                                 | 备注                                                                |
| -------------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------- |
| `password-capture.ts` / `password-fill.ts` / `view-gate.ts` / `password-store.ts`            | **零**                              | embedded 通道原样；S7 证零耦合                                             |
| `cdp-lease.ts` + automation（`browserview-input-service.ts`、`game-surface-detector.ts`）       | **零**                              | 租约语义不动                                                            |
| `session-manager.ts` / `proxy.ts` / `flash.ts` / `tabs.ts` / `download.ts` / `userscripts/*` | **零**                              | 无 CDP 交集                                                          |
| `screenshot-http.ts` / `app-update.ts`                                                       | **零**                              | 无关                                                                |
| 865 单测                                                                                       | **零**                              | 不涉及                                                               |
| `scripts/build-devtools-frontend.cjs`                                                        | +1 SOURCE_PATCH                    | 未命中即构建失败（既有兜底）                                                    |
| `src/preload/index.ts`                                                                       | +1 API / +2 channel                | `devtoolsBridge`（send/onEvent），白名单同步                              |
| `src/main/modules/devtoolbox.ts`                                                             | 新增桥模块 + `getDevToolsTargetUrl` 改签名 | 绑定表（tabId→targetId）复用为路由依据，不废弃                                    |
| `src/main/ipc/devtoolbox.ipc.ts`                                                             | +2 channel                         | bridge-send / bridge-event                                        |
| `src/renderer/components/devtools/DevToolsTab.tsx`                                           | 中改                                 | 跟随逻辑从"URL 重载"改为"桥切 session"；iframe 不再随 targetId 重载                |
| `src/renderer/index.html` CSP                                                                | **零**                              | postMessage 不归 `connect-src` 管；`frame-src` 已有                     |
| 探针 `tab-switch-check.cjs` / `dock-shell-check.cjs`                                           | 适配                                 | 断言从"iframe URL 变化"改为"面板内容变化"；`page-elements-repro` 等旧探针保留 ws 入口对拍 |

## 6. 批次与验收

### B1 前置探针（不做完不进 B2）

1. ~~**S3 之谜复验**~~ **已通过（2026-11-06，`flatten-app-mystery.cjs`）**：应用本体上  
   flatten evaluate 在「flatten only / +1 page-ws / +2 page-ws / detach 后重连」四种组合  
   下全部正常（`flat:2`）。S3 当时的"域未找到"是瞬时竞态（attach 后立即 evaluate，域尚未  
   就绪），不是结构性冲突——桥实现里 attach 后需等 `Target.attachedToTarget` 或首条  
   事件再放行前端流量。**不再作为风险项。**
2. ~~**7k7k 真站定级**~~ **已通过（2026-11-06）**，见下方「B1.2 真站定级」。
3. ~~**IPC 负载基线**~~ **已通过（2026-11-06）**，见下方「B1.3 IPC 负载基线」。

### B2 主进程桥

flatten client + 路由 + session 生命周期 + 合批下发 + 统计日志。

**状态：已完成（`409fe65`，2026-11-06）**。`src/main/modules/devtoolbox-bridge.ts`。

### B3 前端桥接 + 端到端跑通

构建脚本 patch `core/sdk/sdk.js` 的 Connection 工厂（无 ws 参数且在 iframe 内 →  
`BfbBridgeConnection`，postMessage 客户端）+ 外壳中继 + 桥侧 Target 域模拟。

**状态：已完成（`e234eae` → `0a1ba2d`）**。中途踩到并修掉的两个真问题：

1. **响应与事件必须走同一条有序流**（`0a1ba2d`）。原先响应经 IPC promise 快车道、
   事件走 16ms 合批，顺序被打乱：`DOM.setChildNodes` 可能先于它所属请求的响应到达，
   前端把子节点挂到尚未建立的父节点上直接丢弃 → Elements 树残缺/闪回旧文档。
   page-ws 的 WebSocket 是严格串行单流，桥必须等价。响应信封要用**前端的请求 id**
   （不是桥内部 messageId）。
2. **Target 域必须按 page-ws 真实语义模拟**（依据 S14 基线）：
   `setAutoAttach` 不能转发到 browser 级（会 attach 无关 target 并回
   `attachedToTarget`，前端拿到别人的 sessionId）；`setDiscoverTargets` 要补发
   **全部 page target** 的 `targetCreated`（`attached: true`）；主 target 不发
   `attachedToTarget`。

### B4 渲染层中继与跟随改造

DevToolsTab 内 postMessage 中继（origin 校验）+ 切标签热切换。

**状态：已完成（`45e8f79`）**。桥模式 URL 恒定（不含 target id）→ iframe 不重载；
切标签由渲染层重新 `bridge.attach()`，桥换 target 后**重放前端的域开关命令**并
发 `DOM.documentUpdated` + `Runtime.executionContextsCleared`，前端据此重建面板
（实测一次切换重放 32 条）。热切换途中的 `about:blank` 过渡态静默重试，不回
`detached`（那会让前端显示断开横幅并停掉请求）。渲染层 effect 依赖必须含
`activeTabUrl`——新建标签时 tab id 不变、只有 URL 变。

### 验收标准

- **切标签不重载**：切到另一标签，iframe DOM 节点保持（不重建），面板内容切换 < 300ms；  
  切回原标签，Elements 选中状态保留。  
  → **已验证（`bridge-tab-switch-check.cjs`）**：`iframe reloaded=false`、`url changed=false`，
  tab2 树 `hasTwo=true / hasOne=false`。
- **同标签导航**：面板自动跟随（现状已达成，不得回退）。
- **密码链路**：桥开启时 7k7k 密码捕获/填充正常（真机复验）。**待做（B1.2）**。
- **稳定性**：Network 面板重站点 5 分钟无消息丢失/乱序；主进程 CPU 增量 < 10pp。
  **待做（B1.3）**。
- **回退**：`BAO_DEVTOOLS_BRIDGE=0` 立即可用 page-ws 模式，行为与 925ceb7 一致。**已达成**。
- **质量门**：typecheck 0 错、lint 0 警、865 单测全过、S1–S8 探针可复跑。**已达成**。

### B1.2 真站定级（2026-11-06 完成）

`tools/devtools-spike/bridge-realsite-check.cjs`，7k7k 真站 + 桥模式抽屉打开：

| 项 | 结果 |
| --- | --- |
| Elements 树 | 236 个 span，含真实结构 `<body id="theme-blue">`、`<div class="header" id="header">`、`<div class="main">`、`<div class="footer">` 与真实脚本 `www.7k7kjs.cn/...` |
| 经桥求值 | title「小游戏,7k7k小游戏…」、url `https://www.7k7k.com/`、`readyState=interactive`、4680 节点 |
| 桥 stats | sent 167、events 1743、dropped 1、bytesIn 2.30 MB、bytesOut 22.0 KB |
| 密码捕获（embedded） | `[PasswordCapture] attached` ×1、`attach failed` ×0、`already attached by an unmanaged client` ×0 |

结论：真站上桥的数据通路与 fixture 一致；**桥 session 存活期间密码捕获的 embedded attach 正常，零冲突**。

**未覆盖**：automation 输入线没有驱动（需要一份完整 v3 工作流文档 + 包 + 授权）。它的底层与捕获是同一个 embedded 通道（`acquireAutomationCdpLease`），桥完全不碰 embedded，故由捕获那条覆盖；**如果要一条真机证据，需另做一次带 workflow 的自动化回放**。

### B1.3 IPC 负载基线（2026-11-06 完成）

`tools/devtools-spike/bridge-load-baseline.cjs`。受控页面（1500 节点 + 500 条 CSS 规则）+ 每 200ms 一次
DOM 变更与 fetch，三种模式跑同一份负载：

| 模式 | **主进程 CPU** | 总 CPU（不可靠） | events/s | bytesIn/s |
| --- | --- | --- | --- | --- |
| page-ws | 2.3% | 103.4% | — | — |
| 桥 | 4.0% / 6.0% / 3.7% | 95.8% / 152.2% / 101.0% | 33.9–34.7 | ≈25 KB |
| 不开抽屉 | 0.9% | 59.9% | — | — |

- **主进程增量：桥相对 page-ws +1.7~3.7pp，相对不开抽屉 +2.8~5.1pp —— 满足「< 10pp」。**
- **总 CPU 在本机不可分辨**：同一模式重复跑波动达 ±30pp（不开抽屉 21%~61%），应用自身后台
  （OpenCV/OCR 预热、视觉检测）的抖动远大于桥相关差异。要测总量必须先把这些后台压掉，
  或改用"同实例内开关抽屉"的对照法。
- **2 分钟长窗口**：events/s 34.7 与 24s 窗口的 33.9 一致，`dropped` 恒为 1（启动期 browser
  级事件），无漂移、无丢事件。规格要求 5 分钟，此处只跑到 2 分钟。

## 7. 风险与缓解

| 风险                       | 等级            | 缓解                                                                                  |
| ------------------------ | ------------- | ----------------------------------------------------------------------------------- |
| IPC 高频负载（Network 事件风暴）   | 中             | 16ms 合批；真站 CPU 基线（B1.3）；超阈值降级为"事件抽样 + 恢复时全量拉取"                                      |
| browser ws 单 client 被桥独占 | 中             | 审计确认现无其他消费者（探针只连 page 端点）；桥崩溃时自动重连该 ws                                              |
| S3 之谜（应用内 flatten 异常）    | ~~中~~ **已排除** | S9 复验：应用本体 flatten evaluate 四组合全通；原失败是 attach 后立即 evaluate 的竞态，桥实现需等 attached 事件再放行 |
| 前端 patch 上游漂移            | 低             | SOURCE_PATCHES 未命中即构建失败                                                             |
| iframe origin 校验绕过       | 低             | origin 精确匹配静态服务端口；静态服务只绑回环、端口随机                                                     |

## 8. 边界

- **不做**：去端口（flatten 依赖 CDP 端口）；替换 M97 前端（S5 已堵死容器路线）；  
  多标签同时调试的 UI；把密码模块迁到桥（S7 证明没必要）。
- **假设**：`DevToolsActivePort` 第二行（browser ws 路径）在 Chromium 87 稳定可用  
  （343695e 已实测写入）。
- **遗留**：`no-target` / `no-port` 三态由 925ceb7 落地，桥沿用同一契约。
