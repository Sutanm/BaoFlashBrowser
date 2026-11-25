# 浮层共用外壳进程：迁移 demo 的实测结果

2026-11-25 · 承接 [方案评审](2026-11-25-overlay-shared-process-review.md)。在自编译 E39（`0A7C92A9`）上跑 `window.open` + `createWindow` + `WebContentsView` 接管。

## 1. 实测数据（玩具文档，`file://`，外壳 `showInactive()` 保证出帧）

| 指标 | 实测 | 说明 |
| --- | --- | --- |
| 同进程 | ✅ 单渲染进程（`renderers=[shellPid]`） | http 与 `file://` 都成立 |
| 冷开：触发 `window.open` → 双帧 | **45–49 ms** | 文档极小，模拟"零依赖浮层" |
| 其中 `createWindow` 被调用 | 14–19 ms | 浏览器端建 guest 的耗时 |
| 隐藏 → 显示首帧 | **10 ms** | 预热形态；内存不变 |
| 常驻增量（private） | **+3 MB**（ws +6 MB） | 玩具文档；真实 bundle 会更高 |
| 零文档（about:blank + 从外壳注入 DOM） | **注入后 5–6 ms 到首帧** | 最快的一档 |
| 子窗口 preload | ❌ **`undefined`** | 即使显式给 `overrideBrowserWindowOptions.webPreferences.preload` 也没生效 |
| `did-create-window` | **不触发**（0 次） | 与源码一致：该事件只在非 `createWindow` 分支 emit |
| `guest.close()` 后 | `popup.closed = true`，视图**自动脱离** `contentView` | 不需要手动 `removeChildView`，也不会留"视图还在、内容没了" |

采样说明：零文档那栏的 `readyMs≈4.6 s` 是我脚本的轮询瑕疵（在等一个注入后才出现的元素），**有效数字是"注入 → 首帧 5–6 ms"**。

## 2. 对上轮问答的核对

| 对方的说法 | 核对结果 |
| --- | --- |
| `window.open` + `createWindow` 让浮层与外壳共用渲染进程 | ✅ 成立（http / `file://` 双验证） |
| 冷开 <50 ms | ✅ 玩具文档 45–49 ms，与估算吻合 |
| 常驻"几 MB"（空文档估） | ✅ 玩具文档 +3 MB；真实 bundle 仍待测（其修正估计 10–30 MB） |
| 零文档路线最快 | ✅ 注入后 5–6 ms |
| preload "可能在导航后拿到" | ❌ **拿不到**：显式 `overrideBrowserWindowOptions.webPreferences.preload` 也无效 |
| `createWindow` 分支是否走 `outlivesOpener` | ✅ 走（`guest-window-manager.ts:56`）。附带发现：`outlivesOpener=false` 时监听的是 `embedder.once('current-render-view-deleted')` → **外壳刷新/导航/崩溃会 `destroy()` 掉 guest**（dev HMR 刷新外壳会连带杀浮层） |
| `did-create-window` | ❌ 该分支不 emit（测试里不能用它认浮层） |

## 3. 一个必须先做的前置条件

**真实浮层文档在共享进程下根本渲染不出来**，不是"慢"：

- `out/renderer/index.html?baoOverlay=overlay` 的 `OverlayHost` 直接调 `window.baoOverlay.subscribe(...)`；
- 而共享进程**永远拿不到 preload**（§1 实测），`window.baoOverlay` 是 `undefined`；
- 我尝试在独立探针里加载真实文档，它连外壳的 `browser:command` 都在等主进程注册——所以**真实文档的耗时/内存只能在你们的应用里测**，在此之前必须先改桥接方式。

也就是说：**迁移不是"换个打开方式"，而是"先把浮层到主进程的通道换掉"**。这正是对方 ③ 的建议（经 `window.opener` 调外壳已有的桥，或走零文档让组件直接跑在外壳 context 里）。

## 4. 建议的下一步（待你确认）

在应用里加一个**开关式原型**，不动默认路径：

1. `BAO_OVERLAY_SHARED=1` 时：外壳用 `window.open(overlayUrl)` 打开浮层，主进程在 `setWindowOpenHandler` 里接管成 WCV；
2. 浮层侧把 `baoOverlay.*` 换成 `window.opener` 上的等价调用（参数带浮层 id，主进程按 id 找 WCV，因为 IPC 的 `sender` 会是外壳）；
3. 用同一个玩具脚本在**真实文档**上量三个数：冷开、预热后开、常驻增量；
4. 与现状（90–110 MB 常驻 / 97 ms 冷开）对照，再决定是否切默认。

风险点已知：同进程连带崩溃、外壳卡顿拖累浮层、`current-render-view-deleted` 会连带销毁 guest、测试里按 URL 认浮层的写法要改。


## 5. 原型落地结果（真实文档，前台实测）

开关 `BAO_OVERLAY_SHARED=1`。落地改动：`app/src/renderer/main.ts`（借用 opener 的桥）、
`App.vue`（`ensureSharedOverlay` 单飞 + 悬停意图 + 打开前兜底）、`OverlayHost.vue`（宿主层落主题、挂载后 `pullOverlay`）、
`theme.ts`（`initialShellTheme`）、`shell-overlays.ts`（`pull-overlay` 命令）、`index.html`（删掉被 CSP 拦掉的内联脚本）。

### 5.1 先说清楚：共享进程解决的是**预热成本**，不是**预热延迟**

悬停预热早就把"预热完成后打开"压到 2–6 ms 了，共享进程不会让它更快。它改的是"一直热着"的**价格**：

| 指标（前台，E39 自编译运行时） | 基线（独立渲染进程） | 共享进程 |
| --- | --- | --- |
| 启动后（还没碰飞窗） | 2 个渲染进程 / 209–211 MB | 2 个 / 209–215 MB（浮层文档尚未创建，与基线一致） |
| **悬停预热完成后** | 3 个 / **325 MB（+114 MB）**，耗时 121 ms | 2 个 / **215 MB（+6 MB）**，耗时 28 ms |
| 预热后打开 visible / content | 3 / 12 ms | 3 / 9 ms |
| 键盘冷开（完全没预热） | 112 / 147 ms（端到端 218 ms） | 3 / 27 ms（端到端 144 ms） |
| 浮层进程 pid | 独立（24484 vs 3588） | **与外壳同一个**（13364） |

一句话：**把"预热一个常驻飞窗"的代价从 114 MB 降到 6 MB，顺便让"没预热就点"的冷路径也变快（218 → 144 ms 端到端）**；
预热后打开的延迟两种模式一样（3 ms 级），这部分本来就是悬停预热的功劳。

> 更正：本节早期版本写过"冷开 105 ms → 4 ms、启动 +48 ms"。那是原型把开窗放在 `onMounted` 的结果——
> 等于把预热的钱挪到启动期，既不符合现有 auto 策略，也让数字不可比。现在已改回"只由悬停触发"，启动期与基线一致。

### 5.2 四个卡点（都会**静默**失败，不看 DOM 根本发现不了）

| 卡点 | 症状 | 原因 | 处理 |
| --- | --- | --- | --- |
| 内联桥接脚本被 CSP 拦掉 | 浮层文档里 `window.baoOverlay === undefined`，`subscribe` 收不到任何事件 | 借用 opener 的代码写在**内联 `<script>`**，而 CSP 是 `default-src 'self'`（没有 `unsafe-inline`）→ 标签在 DOM 里但不执行 | 挪进 `main.ts` 的 `adoptOpenerBridge()` |
| 只借了 `baoOverlay` | 飞窗能开，但主题档全是 `tabindex=-1`，第一次 Tab 直接跳到引擎行 | `store.connect()` 用 `window.baoBrowser`，浮层文档没有 → store 永远没快照 | 一并借 `baoBrowser` |
| `window.open` 同名重开 = 导航 | 每次预热都把文档整页重载：marker 丢、`overlayIdle` 回 true、订阅全没 | 同名窗口复用但**会 navigate 到该 URL** | 缓存 `WindowProxy`，还活着就不重开 |
| **`window.open` 在 pointerenter 里同步开窗会吞掉紧随的 click** | 页面有内容时"悬停→立刻点击"：`click` 事件根本不触发（连原生监听器都收不到），飞窗打不开；测试里表现为 30 s 超时 | 机制**未定论**：当时归因为"开窗抢焦点"，但 §7.1 的采样证明开窗不动焦点；只确定"紧跟在 hover 里同步开窗"会让同一次指针序列的 click 不触发 | 悬停预热改成 **180 ms 悬停意图**，点击时取消；点击路径自己开窗兜底（`cancelHoverPrewarm` + `ensureSharedOverlay` 单飞） |

另外两个共享模式特有的时序坑：

- **冷路径事件比订阅先到**：文档是点击那一刻才建出来的，`panel-opened`/`quick-opened` 会被丢掉（视图亮着、内容还是默认 panel）。
  新增 `pull-overlay`：宿主挂载、订阅注册完后主动拉一次当前内容。推送漏了，就让它自己来拿。
- **主题被覆盖回浅色**：异步组件挂载时用 `matchMedia('(prefers-color-scheme: dark)')` 猜主题，而共享文档里这个媒体查询仍是 `light`
  （实测 `media:false`），于是把宿主刚设好的暗色盖回去。`initialShellTheme()` 改为优先沿用文档上已应用的 `data-shell-theme`。
- **`window.open` 的单飞**：Playwright/真人都是先 pointerenter 再 click（间隔十几毫秒），两个调用同时看到"还没开"→ 开两次同名窗口，第二次把第一次导航掉。

### 5.3 回归

| 模式 | 结果 |
| --- | --- |
| 默认（独立渲染进程） | `npm run smoke:foreground -- --serial` **66 pass / 0 fail / 0 skip**，152–156 s |
| 共享（`BAO_OVERLAY_SHARED=1`） | 首轮 65/66（`engine.test.cjs`「快捷切换保留导航栈」30 s 超时，单跑 1.9 s 通过），复跑 **66/66** |

### 5.4 还没定的事

1. 同进程连带风险未测：浮层渲染卡顿会直接拖外壳，崩溃同理（这是共享进程的主要代价）。
2. 外壳 reload/导航/崩溃会连带销毁 guest（`outlivesOpener=false` 的既有行为）。
3. 悬停意图的 180 ms 是经验值：太短会把 click 吞掉（实测必现），太长则预热来不及。
4. 测试里"按 URL 找 webContents"的写法仍然可用——浮层还是独立 webContents，只是同进程；但它的 `executeJavaScript` 与外壳共享事件循环。

### 5.5 两个代价的实测（这条决定要不要切默认）

在飞窗已打开的状态下做两组实验，两种模式各跑一次（前台）：

| 实验 | 基线（独立渲染进程） | 共享进程 |
| --- | --- | --- |
| 浮层文档里跑 400 ms 同步忙循环，同时量外壳一次 `evaluate` 往返 | 最长 **3 ms**（外壳毫无感觉） | 最长 **333 ms**（外壳跟着卡死） |
| `forcefullyCrashRenderer()` 崩掉浮层渲染进程 | 外壳存活，工具栏正常，飞窗视图消失，页面视图不受影响 | **外壳渲染进程一起崩**（`isCrashed: true`），`evaluate` 报 `Target crashed`，整个 UI 死掉，只剩窗口壳 |

结论：`+114 MB → +6 MB` 是真的，代价也是真的——**故障域与事件循环都合并了**。
页面视图（各标签）本来就在独立进程，外壳崩溃不影响它们；死的是工具栏 UI 和飞窗。
所以这条路能不能当默认，取决于两件事：崩溃后能否**自愈**（重载外壳并重建浮层），以及飞窗里允许跑多重的 JS。

## 6. 决策落地：共享进程成为默认（2026-11-25）

选的是"先补自愈，再切默认"。已全部落地：

### 6.1 外壳自愈（这一条是切默认的前提）

`shell-overlays`/`browser-window` 里加了两块：

1. **`render-process-gone` → 重载外壳文档**。标签、引擎、租约这些状态都在主进程，重载后由 `snapshot` 重建；
   页面视图是各自独立的 WebContents，完全不受牵连。60 秒内最多重载 3 次（防崩溃循环闪屏），并先把浮层按关闭处理。
2. **准入规则**：共享浮层只能是外壳自己的同源文档，`will-frame-navigate` / `will-redirect` 一并钉死。
   注意这里**不能无条件 `preventDefault`**——guest 的首次加载本身就是渲染进程发起的导航，一律拦掉会得到永远空白的飞窗
   （实测把 5 个叠加层用例全部打成 30 s 超时，改成"放行本层文档 URL，其余拦掉"才对）。

实测（`shell-crash-heal.test.cjs`，两种模式都跑）：

| 步骤 | 结果 |
| --- | --- |
| `forcefullyCrashRenderer()` 崩外壳渲染进程 | `gone reason=crashed` |
| 自动重载 | 共享模式 **109 ms**、独立进程模式 **279 ms** 后报告 `recovered` |
| 重载后 | `gear: true`（工具栏回来）、标签行重建、`isCrashed: false`、页面视图仍在且未崩 |

> 测试写法上有个坑：渲染进程崩溃后 **Playwright 的 Page 句柄永久失效**（`Target crashed`，也不再发 `window` 事件，
> `app.close()` 会挂住）。所以断言不能从页面侧做——改成主进程写诊断文件（`BAO_SELFHEAL_TRACE`，未设置时是空操作），
> 测试只读文件，并在 `finally` 里限时关闭 + `taskkill` 兜底。第一次不知道这点时测试直接卡死。

### 6.2 默认值反转

`sharedOverlayMode` 由 `BAO_OVERLAY_SHARED === '1'` 改成 `BAO_OVERLAY_SHARED !== '0'`：
**默认共享进程**，需要故障域隔离时用 `BAO_OVERLAY_SHARED=0` 退回老路径。

### 6.3 验收（2026-11-25 当天，全部实跑）

| 跑法 | 结果 |
| --- | --- |
| 隐藏并行 `npm run smoke`（默认共享） | 27 个文件 **0 失败**，77 s |
| 前台 `npm run smoke:foreground --serial`（默认共享） | **67 pass / 0 fail / 0 skip**，158 s |
| 前台 + `BAO_OVERLAY_SHARED=0`（回退路径） | 叠加层相关 6 条 **6/6 通过** |

### 6.4 仍然存在的代价（写进文档，不再是未知）

1. **事件循环合并**：浮层里 400 ms 同步忙循环会让外壳一次 `evaluate` 往返从 3 ms 涨到 333 ms。
   结构上无解，只能靠"浮层里不放重活"的纪律（自家 UI，可控）。
2. **故障域合并**：崩浮层会连外壳一起崩——现在有自愈兜底（重载 ~0.1 s），但用户能感知到一次闪烁。
3. **同源限制**：共享浮层只能装外壳自己的文档；将来要放外来内容，得回到零文档注入或 iframe 方案。
4. 外壳 reload/导航会销毁 guest（`outlivesOpener=false` 的既有行为），自愈路径依赖"重载后重新预热/打开"。

## 7. 常驻预热落地 + `overlay.prewarm` 三档语义（2026-11-25 晚）

交接时列的「当前待决 1、2」在这一节收口。待决 3（事件循环长任务告警）与 4（GC/帧预算）仍未做，见 §7.5。

### 7.1 先证伪一个前提：`window.open` 不抢焦点、也不吞键

交接文档把"启动后空闲时建文档"挡回的理由是：*会抢焦点、吞掉用户正在敲的键，整轮前台套件因此
7 条随机失败*。这个结论**没有复现**。

`app/scripts/probe-overlay-focus.cjs`（前台悬停预热）与 `probe-overlay-focus-background.cjs`
（应用在后台、记事本持前台时建文档）各测一遍：

| 场景 | `BrowserWindow.getFocusedWindow()` | `win.isFocused()` | `getFocusedWebContents()` | `document.hasFocus()` | 地址栏打 "abc" |
| --- | --- | --- | --- | --- | --- |
| 基线（地址栏已聚焦） | 1 | true | 外壳 | true | — |
| 前台悬停预热之后 | 1 | true | 外壳 | true | 落进地址栏 ✅ |
| 后台（记事本前台）建文档之前 | null | false | null | — | — |
| 建完之后 / 再等 1.5 s | null | false | null | — | — |

即：浮层文档确实建出来了（`webContents` 里能按 URL 找到），但**OS 激活与 WebContents 焦点
一格没动**，前台仍是记事本。

**那为什么仍然加了焦点还原**：这条链路的**上游具备**抢焦点的能力——Chromium
`WebContentsImpl::CreateNewWindow` 在 `!renderer_started_hidden` 时会先 `widget_view->Show()`、
再 `contents_to_load->Focus()`（`content/browser/web_contents/web_contents_impl.cc:5408`、`:5529`），
现在只是被 Electron 的 WCV 宿主形态挡掉了。常驻预热把开窗挪到"用户没在操作本窗口"的时刻，
上游形态一变，代价就是随机吞键这种最难查的故障。所以 `createWindow` 里先记下
`(BrowserWindow.getFocusedWindow(), webContents.getFocusedWebContents())`，adopt 之后若焦点
**确实**被 guest 拿走就还原（`restoreSeedFocus`）——只在外壳窗口仍 active 时动手，绝不把后台
窗口拉到前台。实测这条兜底从未触发（每次读回都不是 guest），它是给上游变化的确定性防线。

### 7.2 三档语义：`never` 曾被完全忽略，`always` 在共享模式下没人建

切默认之后 `overlay.prewarm` 三档是**同一档**：

| 档位 | 改前 | 现在 |
| --- | --- | --- |
| `never` | 悬停照样 `window.open`（渲染层不看 `prewarm()` 的返回值），建完也不回收 | 悬停/启动都不建；只有点击或 toast 才建 |
| `auto` | 悬停 180 ms 预热；隐藏后不回收（`armRetire` 挂在共享模式下没有可管的文档） | 悬停 180 ms 预热；隐藏后空闲 `RETIRE_AFTER_MS`（默认 5 分钟）回收，再打开自动重建 |
| `always` | 主进程 `prewarm()` 在共享模式下是空操作 → **根本没人建** | 启动后常驻；第一次点开复用同一个文档；不回收。**2026-11-25 晚起是默认档** |

### 7.3 契约：主进程决定，外壳执行

共享模式下"建文档"只有外壳做得出来（`window.open`），但"该不该建"取决于主进程独占的信息：
设置项、`canPrewarm()`（自动化/后台窗口不预热，否则会给「页面视图计数」类断言多一个 webContents）、
以及 `BAO_OVERLAY_PREWARM` 覆盖。

第一版在这里就错了：渲染层从 `BrowserState.settings.overlayPrewarm` 自己读策略，而策略覆盖只在
主进程里 → `always` 档永远不生效（探针当时就抓到了）。两边各读一次设置，必然对不上。

现在只有一个判定点（`shell-overlays.ts` 的 `canPrewarmNow()`），分工是：

| 动作 | 谁做 | 通道 |
| --- | --- | --- |
| 悬停时问"这一档准不准" | 主进程回答，**不建任何东西** | `can-prewarm` 命令 |
| "现在就建"（启动、切档、自愈重载后） | 主进程推，外壳执行 | `prewarm` 命令 / `overlay-prewarm` 事件 |
| 什么时候建 | 外壳 | 悬停 180 ms 意图；常驻档用 `requestIdleCallback`（不占启动关键路径） |

顺带修掉一处死代码：`shell-overlays.ts` 的 `shared-mode` 分支里"预热闸门"那行 `return` 永远执行
不到（同一 `case` 里已经有 `return`），所以闸门从来没生效过。

### 7.4 常驻档的真实拦路虎：不是焦点，是地址栏草稿被状态广播清空

`BAO_OVERLAY_PREWARM=always` 跑前台套件会整片 30 s 超时（这正是交接文档里"7 条随机失败"的来源）。
一开始按交接文档的假设去查焦点，三条线索全部落空：

| 假设 | 实测 | 结论 |
| --- | --- | --- |
| 抢 OS 激活 | `win.isFocused()` / `getFocusedWindow()` 前后台都不变（p50 采样 2 ms × 310 点） | ✗ |
| 抢 WebContents 焦点 | `getFocusedWebContents()` 始终是外壳；guest 从未成为焦点 | ✗ |
| 外壳文档失焦吞键 | `document.hasFocus()` 在受控开窗的 2 ms 采样里一次都没变成 false | ✗ |

真正的机制（应用内埋点抓到的失败样本）：

```
open-start 415ms → open-done 426ms → submit 444ms value=""     ← 回车提交的是空地址
```

即：外壳启动后的**首份状态广播**落在用户输入之后，`App.vue` 的
`watch([active.id, active.address])` 把地址栏重置成 `active.address`（新标签页是空串）→
回车等于导航到空地址 → 标签永远停在新标签页。常驻预热把一次状态广播推到了"用户已经填好地址"
之后，于是这条竞态从偶发变成必现；`active:''` + 标签仍是「新标签页」+ 外壳没崩，三条现场全都对上。

修法不是给预热加延迟，而是两步：

1. **地址栏草稿不被后台状态刷新覆盖**（`addressDirty`：用户敲过且尚未提交时，状态广播不动输入框；
   提交/离开输入框后照旧跟随标签）。`tab` 切换与导航仍然同步——第一版用"值是否与上次同步不同"
   判断，把程序化切标签也当成"正在输入"，把 `Ctrl+,` → 设置页那条用例钉死在旧地址上（实测抓到的）。
2. **常驻预热挪到 `window.show()` 之前**：那时窗口还不可见，用户不可能正在输入，
   "建文档"与"用户打字"从此不可能重叠。价格是启动期多付一次开窗（~40 ms 量级），
   比"偶发吞掉一次回车"划算得多。

第 1 条与共享进程无关（独立进程档同样存在，只是触发概率低得多）。

### 7.5 价格

仍是 §5.1 的 **+6 MB**：文档常驻、视图 `visible=false` 且未挂到 `contentView`。
常驻档只是把"第一次点开"从冷开（144 ms 端到端）变成热开（3/9 ms 级）。

把默认从 `auto` 改成 `always` 的代价实测（`scripts/probe-overlay-prewarm-memory.cjs`，
`never` / `always` 交替各两轮、取 20 s 稳定后的中位数，`app.getAppMetrics()` 口径）：

| 指标 | `never` | `always` | 差值 |
| --- | --- | --- | --- |
| 总 working set | 508.4 MB | 513.9 MB | **+5.5 MB** |
| 总 private | 331.5 MB | 336.5 MB | **+5.0 MB** |
| 渲染进程 working set | 210.6 MB | 215.8 MB | +5.2 MB |
| 渲染进程 private | 91.9 MB | 96.3 MB | +4.4 MB |
| 浏览器进程 working set | 122.2 MB | 123.8 MB | +1.6 MB |
| 渲染进程数 / 总进程数 | 2 / 5 | **2 / 5** | 0 |

即：**每个窗口 +5～6 MB（≈基线的 1.1%），不多一个进程**；20 s 与 6 s 两个采样点无趋势差，
不是缓慢增长。注意这是**每窗口**成本——多窗口各建各的浮层文档，按窗口数线性叠加。
隐藏/后台自动化窗口不预热（`canPrewarm()` 为 false），那两种模式下不涨。

**结论：默认已切到 `always`（2026-11-25 晚，用户裁决）**。依据：+5～6 MB 换掉"第一次点开的冷开"
在浮层寄居外壳进程之后变得便宜（独立进程时代这一档要 +90–110 MB，所以当初默认是 `auto`）；
需要省内存的用户仍可在设置里退到 `自动` / `不预热`。
`PREWARM_MODES` 的顺序也调成 `always, auto, never`（设置页分段控件把默认档放最前），
文案同步为「常驻（默认，更快）/ 自动（悬停预热，省内存）/ 不预热（最省内存）」。

### 7.6 验收（2026-11-25 晚，全部实跑）

默认档切成 `always` 之后又整轮复验了一遍：

| 跑法 | 结果 |
| --- | --- |
| `npm run typecheck` / `npm run build` | ✅ |
| 单元层 `npm run test:unit` / 数据层 `npm run test:data` | **148 / 148**、**11 / 11** |
| 隐藏并行 `npm run smoke` | **28 个文件 0 失败**，88.5 s（新增 1 个策略用例文件） |
| 前台串行 `npm run smoke:foreground -- --serial`（**默认 = `always` + 共享**） | **70 通过 / 0 失败 / 0 跳过**，162 s |
| 前台串行 + `BAO_OVERLAY_PREWARM=auto`（旧默认对照） | **70 / 0 / 0**，167 s |
| 前台串行 + `BAO_OVERLAY_SHARED=0`（回退路径 + 新默认） | **70 / 0 / 0**，175 s |

常驻档把整轮前台套件从 167 s 推到 171 s（切默认前那一轮）——**常驻预热的实际套件代价 ≈ 4 s**，
与 §7.5 的 +5～6 MB 一起看，这个价格可以接受；它此前被挡回是因为地址栏竞态，不是因为它本身贵。

### 7.7 仍未做

1. **事件循环合并的开发期告警**（待决 3）：共享进程把"工具栏"和"浮层"放进同一个渲染进程主线程，
   任何一方跑同步长任务，另一方都得排队。实测（`app/scripts/probe-overlay-longtask.cjs`，2026-11-25）：

   | 指标 | 空闲 | 浮层忙 400 ms（共享） | 同上，独立进程模式 |
   | --- | --- | --- | --- |
   | 外壳一次 IPC 往返（`baoBrowser.run`） | 2 ms | **402 ms**（撞上阻塞窗口的那次） | 3 ms |
   | 外壳帧间隔 | ≤5 ms | **401 ms**（≈丢 24 帧） | ≤6 ms |
   | 卡住期间 Esc 关浮层 | ✅ | ✅（`before-input-event` 在主进程，不经过被占住的线程） | ✅ |

   判据：浮层里单次同步任务 <16 ms（一帧）无感、<50 ms 可接受、>100 ms 用户必然可感。
   建议在叠加层文档里挂 `PerformanceObserver('longtask')`，开发期 >50 ms 就告警，
   把"浮层里不放重活"从纪律变成门槛。
2. **GC 与帧预算**（待决 4）：合并 V8 heap 后浮层分配会推高外壳 GC 频率，**完全没测过**。
