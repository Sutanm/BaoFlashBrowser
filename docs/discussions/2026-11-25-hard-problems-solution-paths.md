# 七条难题的路径复核（对着 142 源码与既有实测，不是纸面推演）

2026-11-25 · 起因：外部 AI 对 [overlay-shared-process-demo.md](2026-11-25-overlay-shared-process-demo.md) §7.7 与标签线遗留问题给出的建议。
性质：**逐条核对**。判定分四类——`✅ 对` / `✔ 已做（它不知道）` / `✗ 本版不成立` / `◐ 需实验`。
核对对象是本机内核树 `D:\electron-build-142\cr\src`（Chromium 142.0.7444.265 / Electron 39.8.10），
不是文档、不是记忆。凡标「源码」的都给了 `文件:行`，可以当面对。

---

## 0. 一句话结论

1. **七个难题里只有一个真需要"加观测"**（A1 的归因、A2 的量化），其余四条（A3 竞态、A5 冷路径、B6 分解、B7 冻结）
   **外部回复都在重复我们已实测过或已修过的结论**——这是本轮最大的信息差，不是它的推理错。
2. **它给的三条"重武器"里两条在本版不成立**：`MemoryPurgeManager` 在 142 的 content 里**已经不存在**；
   冻结档（`SetPageFrozen`）我们已经测过**不释放内存**且会把 `executeJavaScript` 挂死。
3. **它没给、但本机源码确认可得的两条真收益**：`outlivesOpener: true`（一行，解掉"外壳刷新连带销毁浮层"）、
   `ImageView`（E39 就有，A5 想要的截图占位不用写内核补丁）。
4. **只剩三条路线级问题还开着**：A1 的硬保证怎么做、A4 的外壳进程共享、B6 的标签进程合并可行性。

---

## 1. 对那份回复的逐条判定

| # | 它的说法 | 判定 | 依据 |
| --- | --- | --- | --- |
| 1 | 主进程 ↔ 外壳 100 ms 心跳 RTT 能同时覆盖 A1/A2 | ✅ 对，且最该先做 | 与被阻塞的是同一条线程；无需渲染端 API |
| 2 | 外壳里挂 LoAF（`long-animation-frame`），靠 `windowAttribution` 看出"是不是浮层那个 window 干的" | ✗ **本版拓扑下拿不到** | `windowAttribution` 只按**帧树关系**分档：`self / descendant / ancestor / same-page / other`（`third_party/blink/renderer/core/timing/performance_script_timing.cc:44-61`）。浮层是**另一个顶层窗口**（独立 frame tree），与外壳既非祖先也非同页 → 最多 `other`。且 LoAF 条目只入**跑脚本那个文档**的队列（`core/frame/animation_frame_timing_monitor.cc:282-283`），外壳的 observer 看不到 |
| 3 | `contentTracing` 常开环形缓冲，RTT 超阈值就导出 | ✅ 对 | 类别 `toplevel / v8 / disabled-by-default-v8.gc / cc` 在 142 都存在 |
| 4 | 内存用 `memory-infra` 分解 | ✅ 对，但**度量口径**要先修（见 B6） | `app.getAppMetrics()` 只有 `workingSetSize / privateBytes`（`electron.d.ts:9259`），没有 `sharedBytes` |
| 5 | A1：用渲染进程内看门狗线程 + `isolate->TerminateExecution()` | ◐ 机制真实，但**不建议** | 前例在 `content/services/auction_worklet/auction_v8_helper.cc:200-248`（专线程 + Terminate/Cancel）。问题：只打断 JS（栈检查点），不打断 C++ 长任务；终止后该 isolate 上正在跑的**恰好可能就是外壳的**任务；浮层文档状态必须整个重建。代价/收益不如第 3 条（浏览器进程直接杀进程） |
| 6 | A2：先确认"预热中的浮层是不是真的隐藏" | ✔ **已做** | `shell-overlays.ts:107-118` `hide()` 先发 `overlay-hidden` 再 `setVisible(false)` + `removeChildView`；未进 view 树的 widget 不出 `BeginMainFrame`（§7.5 的 +6 MB 就是这么来的） |
| 7 | A2：动画只允许 `transform/opacity` | ✅ 对，属于纪律项 | 合成器可独立完成，不进主线程 |
| 8 | A2：`--max-semi-space-size` 只给外壳进程 | ✓ 方向对，但**没有"只给某个文档"这回事** | 合并后外壳与浮层是**同一个 isolate**，V8 旗标只能整进程 |
| 9 | A3：把竞态修掉，而不是靠挪预热时机躲 | ✔ **已做** | `App.vue:56/66/91/606` 的 `addressDirty`；结论见 demo §7.4 |
| 10 | A3：拆两段预热（先 `about:blank`，后挂载） | ◐ 就是我们的"零文档"档（注入后 5–6 ms 首帧），但 Vue 挂载省不掉 | demo §1 |
| 11 | A3：`electron-mksnapshot` 把 Vue 初始化做进快照 | ✗ 不建议 | 依赖 DOM 的代码进不了快照，维护成本 >> 40 ms |
| 12 | A4：让所有窗口的外壳共用一个渲染进程 | ✅ 对，但**必须先开 `outlivesOpener: true`**，否则关掉主窗口会连带销毁所有 guest | `electron/lib/browser/guest-window-manager.ts:91-118`；`electron.d.ts:19442-19445`、`docs/api/structures/window-open-handler-response.md` |
| 13 | A5：用截图占位，`ImageView` 显示 `nativeImage`（"记得 33 起有，请确认"） | ✅ **确认有** | `electron.d.ts:8486`、`shell/browser/api/views/electron_api_image_view.cc`、官方描述就是"给 splash 用，之后换成 `WebContentsView`" |
| 14 | A5：`incrementCapturerCount` | ✔ 上一轮已否决，本轮不重复 | demo 评审 §2：不是 JS API |
| 15 | B6-1：页面渲染进程 `sandbox: true` 可省 10 MB | ✔ **已做** | `browser-window.ts:660`（页面视图）、`:695`（内部页） |
| 16 | B6-2：只给页面进程加 `--enable-low-end-device-mode` | ◐ 开关真实，但**效果面比它说的大得多** | 读的是 `base::SysInfo::IsLowEndDevice()`；渲染进程由浏览器命令行统一透传（`content/browser/renderer_host/render_process_host_impl.cc:3694`），"只给页面进程"要改 content。副作用清单见 §4.1 |
| 17 | B6-3：只给页面进程 `--optimize-for-size` | ◐ 同上，`js-flags` 没有按进程分的接口 | — |
| 18 | B6-4：让 Chromium 的 `MemoryPurgeManager` 在标签进后台后清缓存 | ✗ **142 里没有这个类** | 全树 grep `MemoryPurge` / `kMemoryPurge` 在 `content/` 下 0 命中；只剩 `base::MemoryPressureMonitor`（OS 真实内存压力触发），Chrome 那套 `chrome/browser/` 的后台清理不随 Electron 发布 |
| 19 | B6-5：`ShouldTryToUseExistingProcessHost` 写自己的分组规则 | ◐ 钩子存在，但**表达不了"按引擎分池"** | `content/public/browser/content_browser_client.h:717`；调用点 `render_process_host_impl.cc:5071-5080`；选中逻辑是 `GetExistingProcessHost()` **随机挑一个合适的**（`:4946-4949`）。它能回答"能不能复用一个现成的"，不能回答"用哪一个" |
| 20 | B6：`--process-per-site` / `--renderer-process-limit` 未做实验 | ✅ 值得做，而且**零代码** | `--renderer-process-limit` 在 142 有效：`content/browser/browser_main_loop.cc:609-615` → `SetMaxRendererProcessCount()`。`--process-per-site` 走 `ShouldUseProcessPerSite`（`content_browser_client.h:472`） |
| 21 | B7：加一档"冻结"（`SetPageFrozen`）回收物理内存、保留状态 | ✗ **已实测否决** | ① 冻结不释放内存（`docs/reports/2026-11-24-tab-discard.md:11`，0～+0.21 MiB）；② 冻结后 `executeJavaScript` 3 秒不返回（`docs/discussions/2026-11-25-electron-patch-backport-audit.md:45`）→ CDP/自动化会挂死；③ API 在 `content/public/browser/web_contents.h:1073`，JS 侧只有 CDP `Page.setWebLifecycleState` |
| 22 | B7：discard 会丢 Flash 游戏状态，建议 discard 前先处理 | ✅ 对，而且**比它的描述更严重**：我们连"保存进度"都要主动做（`SharedObject.flush`），关渲染进程时异步写盘不保证落盘 | 架构 §1614「内存态冻结即丢，游戏进度是硬约束」 |

---

## 2. 先补观测（A1 / A2 / B6 / B7 共用）

> **已落地（2026-11-26）**：心跳 RTT 与浮层长任务归因都已实现，`heartbeat.test.cjs` 三条用例
> 覆盖「空闲 / 被同步长任务阻塞 / 浮层长任务跨窗口归因」。下面 §2.2 的结论（外壳侧 LoAF 永远
> 看不到浮层脚本）由实现与用例确认；§2.3 的 CDP 三件套仍未做（等真有人要回答「+6 MB 值不值」）。

四条线缺的是**归因**，不是"有没有指标"。四件东西装一次，后面全部复用。

### 2.1 主进程心跳（半小时，先上）

主进程每 100 ms 向**外壳**发一次 `ping`，外壳在渲染线程上同步回 `pong`；记 RTT。

- 它测的是"外壳渲染线程现在是不是能干活"，被浮层长任务挡住时 RTT 直接跳到任务时长（§7.7 表：2 ms → 402 ms）。
- 顺带把**浮层自己的心跳**也挂上（浮层文档通过借来的 opener 桥上报）：两个 RTT 一对比就能分出"谁占着线程"。
- 判据：p50 < 8 ms、p99 < 50 ms；任意一次 > 200 ms 记为事件并落盘（带时间戳）。

### 2.2 长任务归因：**在浮层文档自己的 realm 里装 observer**（这是回复里那条建议的正确形态）

LoAF 条目的归属是按帧树算的（§1 第 2 行），所以外壳侧挂 observer 只能知道"我这一帧晚了 400 ms"，
永远不知道是谁干的。正确做法：

```js
// 主进程里对浮层 guest 执行（不是外壳）：
const wc = flyout.view.webContents
await wc.executeJavaScript(`
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      // longtask: {duration, name='self', attribution[]}；LoAF 还额外给 scripts[].sourceURL/invoker
      window.__baoOverlay.__reportLongTask({ d: e.duration, t: e.startTime, n: e.name })
    }
  }).observe({ entryTypes: ['longtask', 'long-animation-frame'] })
`, true)
```

- `longtask` 给时长，LoAF 额外给 `scripts[].sourceURL / invoker / forcedStyleAndLayoutDuration`——**那才是"哪一行"**。
- 两个 RTT + 浮层自报的长任务，三者按时间戳对齐，"外壳卡了 400 ms"立刻变成"浮层 quick 面板的 `watch` 跑了 397 ms"。
- 开发期门槛：浮层单次同步任务 > 50 ms 直接 `console.error` 并让 `npm run smoke:foreground` 里新增的一条用例失败
  （该用例必须在**前台**跑：隐藏/自动化窗口不预热，也拿不到真实帧）。

### 2.3 GC 与帧预算（A2 的全部"零数据"就靠这三个数）

一个 CDP 会话（`webContents.debugger.attach()`）挂在**外壳** WebContents 上（合并后它代表整个 isolate）：

| 指标 | 取法 | 回答什么 |
| --- | --- | --- |
| 合并堆大小趋势 | `Runtime.getHeapUsage` 每 500 ms 一次 | 浮层常驻到底多吃多少堆（替代 `performance.memory`，也不用开 `--enable-precise-memory-info`） |
| scavenge 次数/耗时 | `Tracing.start`（`disabled-by-default-v8.gc`）+ 跑固定负载 + `Tracing.end` | 浮层分配是否推高外壳 GC 频率（A2 的核心问题） |
| 帧间隔 / 阻塞 | 外壳里 `requestAnimationFrame` 差值 + `longtask` | "浮层可见时是否偷外壳的帧" |

A/B 口径：同一段脚本负载，分别 `BAO_OVERLAY_SHARED=1`（浮层文档常驻）与 `=0`（不存在），比 p50/p99。

### 2.4 内存（先把口径修对，见 §4.1）

`app.getAppMetrics()` 每进程给 `workingSetSize` 与 `privateBytes`；**`shared` 只能自己算**（`WS − private`）。
求和时千万别把 `workingSetSize` 相加——同一份 DLL 代码页在每个进程的 WS 里各算一遍，
"6 标签 1161 MB"这类数字就是这么被放大的。要看"真的多占了"用 `privateBytes` 之和或系统 commit。

---

## 3. A 线（浮层）

### A1 合并后的长任务：三档，按"能不能抢占"排

**为什么这里必须谈抢占**：主线程被占用时，`reload()` / `close()` / 诊断 IPC 全部排在任务后面——
**浏览器进程发的任何恢复动作都不可能及时生效**。所以只有两种真抢占：V8 终止执行，或杀进程。

| 档 | 做法 | 效果 | 成本 |
| --- | --- | --- | --- |
| ① 约束（首选） | 浮层里**只允许** Worker 干重活；主线程单任务 ≤ 16 ms（`scheduler.yield()` 切片）；开发期 50 ms 门槛 + 前台用例 | 把问题消灭在写代码时 | 纪律 + 一条用例；0 行内核 |
| ② 兜底（便宜且唯一可靠） | 主进程心跳连续 3 次没回（≈300–3000 ms）→ `webContents.forcefullyCrashRenderer()` → 走**已有的**外壳自愈（实测 109 ms 重载） | 用户看到一次闪烁，UI 必回来 | 0 行内核；自愈已经在 `browser-window.ts` 里 |
| ③ 精细抢占（不建议） | 渲染进程内看门狗线程 + `TerminateExecution` | 只杀浮层的这段脚本，外壳不动 | 内核补丁 + 状态机：终止后必须重建浮层文档；无法打断 C++ 长任务；隔离域合并后"终止"本身就会伤到外壳正在跑的任务 |

建议只做 ①+②，②的阈值取 3 s 而不是 100 ms（避免把慢机器上正常的 Vue 挂载打成崩溃循环），
并且要三条开关：DevTools 已连接时不杀、自动化/隐藏窗口不杀、60 s 冷却。
**注意与 A4 的耦合**：一旦所有窗口共用一个外壳进程，②的爆炸半径从"一个窗口的 UI"变成"所有窗口的 UI"。

### A2 GC / 帧预算：机制已经清楚，缺的只是数

- 合并的到底是什么：**同一个 V8 isolate（同一堆、同一 scavenger）+ 同一条渲染主线程 + 同一条进程内合成线程**
  （两个 widget 各有 `LayerTreeHost`，但线程是进程级的）。
- 已经能排除的：**隐藏时不偷帧**（`hide()` 会 detach + `setVisible(false)`，未进 view 树就不出 `BeginMainFrame`）。
  真正要吃帧的是"浮层可见时的那一刻"——那是必须的，不算偷。
- 剩下的风险只有一个：浮层的分配让外壳的 scavenge 变密，外壳在动画/输入时被打断。
- 路径：① 用 §2.3 的 A/B 拿数；② 浮层里减少高频小对象（Vue `reactive` 大对象、`watch` 深比较、
  `scrollHeight` 反复读）；③ 若数据确实显示 scavenge 偏多，再考虑整进程的 `--max-semi-space-size`
  （合并后只有一个 isolate，这个旗标**没有**"只调浮层"的写法）。
- 判据：浮层常驻时外壳 `longtask` 数不增加、帧间隔 p99 不劣化 2 ms 以上。达不到就不必调参。

### A3 启动期的 ~40 ms：竞态已经修了，这条可以重新评估

现状是"预热挪到 `show()` 之前"（demo §7.4）——**当时挪的理由是躲地址栏竞态，而竞态已经用 `addressDirty` 修掉了**。
于是就剩一个纯工程问题：这 40 ms 要不要放在关键路径上。

三条路，按性价比：

1. **挪到 `show()` 之后的首个"用户意图"**（不是 idle）：`window.once('focus')` 或首次 `pointermove`。
   真人从窗口出现到把指针移到齿轮 ≥ 200 ms，比 40 ms 富余得多；`addressDirty` 已经能挡住广播覆盖。
2. **拆两段**：show 之前只 `window.open('about:blank')` 拿到 guest（几 ms），文档导航放到 show 之后。
   风险是 guest 的首次导航会回到"窗口已可见"的时刻，等于把竞态窗口又打开一次——所以必须配 1。
3. **不动**：40 ms 只付一次，且 §7.5 已经证明它换来的是"首次点开 3–10 ms"。若实测首帧（窗口出现）
   没被推迟，就没有优化空间，直接收掉这个 TODO。

先测再动：在 `show()` 前后各打一个时间戳（主进程即可），确认 40 ms 是**推迟了窗口出现**，还是只推迟了
"外壳可交互"。这两者对体感完全不同。

### A4 多窗口总量：真正的大头是每个窗口一个外壳进程

- 浮层的那 +6 MB/窗口 是线性但很小；**每个窗口一个外壳渲染进程（≈69–72 MB WS）才是大头**。
- 复用现成机制：外壳 A 用 `window.open(自己的 shell 文档)`，主进程在 `setWindowOpenHandler` 里
  `createWindow` 接管成 WCV，挂到**新 BaseWindow** 上——和浮层走的是同一条已验证路径（demo §1）。
- **前置条件只有一个，而且是一行**：`setWindowOpenHandler` 的返回里加 `outlivesOpener: true`。
  不加的话 opener 的 render view 一消失（窗口关、外壳 reload、崩溃自愈）就会 `guest.destroy()`
  （`guest-window-manager.ts:107-118`），多窗口会互相连坐。这也是 demo §6.4 第 4 条的正解。
- 代价与约束：
  - 崩溃域变成"所有窗口的工具栏 + 所有浮层"。自愈会重载**所有**窗口的 UI（状态都在主进程，能重建）。
  - 每个窗口仍然要有自己的外壳**文档**（一个 WCV 只能属于一个窗口），只是同进程。
  - 第一个窗口 = "壳主"：它关闭时不能让进程死。`outlivesOpener: true` 只解掉 destroy，
    不解掉"最后一个 document 的进程"——所以应当让**主窗口**在还有其它窗口时不可被关闭，或关闭时把
    壳主身份移交（重新在另一个窗口里 `window.open` 一批）。
- 判据：N=1..5 时 `privateBytes` 之和的斜率从 ≈70 MB/窗口 掉到 ≈10 MB/窗口；焦点/IME/拖动分栏
  在"外壳文档不是本窗口打开的那个"情况下仍然正常（这是唯一需要真验的交互面）。

### A5 冷路径 144 ms：优先级最低，但工具已经齐了

- 前提变化：`always` 已是默认档，冷开只发生在"用户主动选 never/auto 且没悬停"或"预热失败"。
- 先分段：现有 `overlay-metrics.ts` **只覆盖主进程侧的 open→visible→content**，不含文档侧
  （`window.open` → 首个脚本执行 → Vue 挂载 → 首帧）。这 144 ms 里很可能有一半是**外壳自己的**
  `ensureSharedOverlay` + `OverlayHost` 挂载，而不是 Chromium。
- 真要做占位：**`ImageView` 在 E39 就有**（`electron.d.ts:8486`），官方定位就是"给 splash 用，之后换成
  `WebContentsView`"，不用写内核补丁。代价三条，必须一起接受：
  ① `capturePage()` 在关闭前截（几 ms）+ 落盘；② 截图是**用户数据**（主题/引擎/设置值都在里面），
  持久化要按用户数据对待；③ 面板状态可能已变（陈旧），只能当骨架屏用。
- 我倾向：先做分段埋点。如果 144 ms 里 >60 ms 是外壳 JS，改外壳比截图便宜得多。

---

## 4. B 线（标签/页面）

### 4.1 B6 先修度量口径：69–72 MB 里有多少是"真的多占"

- 现在的 69–72 MB 是**空页面渲染进程的 workingSet**（`docs/evidence/probes/.../` 探针口径），
  而 WS 包含 Chromium 的共享代码页——每个进程都把它算进自己的 WS。
- 要回答"多合并一个标签能省多少"，只能看 `privateBytes`（Electron 直接给）与系统 commit。
  这也解释了 tab-discard 报告里的 111 MB/tab 和这里的 70 MB/tab 为什么对不上：两个口径。
- **这一步不做，后面所有进程合并的收益都是猜的。**

### 4.2 B6 进程合并：钩子真实，但"按引擎分池"表达不出来

三个入口的真实语义（源码结论）：

| 入口 | 能做什么 | 不能做什么 |
| --- | --- | --- |
| `--renderer-process-limit=N` | 全局上限；超了以后**随机**塞进某个合适的现成进程（`render_process_host_impl.cc:5103`）。零代码，可以先跑 | 不分引擎、不分站点；会把两个 Flash 标签塞进同一个进程 |
| `ShouldUseProcessPerSite(profile, site_url)` | 同站点所有标签固定进**同一个** SiteInstance→进程（`content_browser_client.h:472`） | 站点粒度；同一 Flash 站点仍会撞"一进程一个 Flash 实例" |
| `ShouldTryToUseExistingProcessHost(profile, url)` | 允许复用现成进程（`content_browser_client.h:717`） | 只能答"能不能"，选哪个是 `GetExistingProcessHost()` **随机**挑（`:4946-4949`） |

所以"Flash 独占、Ruffle 按站点分组进池"要真做，得在内核里同时改**判定**和**选择**
（约 30–60 行，改 `GetExistingProcessHost` 的过滤条件 + 一个 engine-class 概念）。
在动它之前，有一个更便宜、更关键的**成因实验**必须先做：

> **一页两个 `<embed>`，两个 Flash 实例能不能同时实例化？**
> 我们的"单实例"结论来自 `clone()` 实验（克隆帧与源同进程时第二个实例退化），那是**间接证据**。
> 若同页双实例可用，说明限制不在"一进程一实例"，进程合并对 Flash 标签也成立，整条 B6 的收益翻倍；
> 若不可用，就地确认硬约束，B6 只能做 Ruffle 侧。
> 这一个用例 15 分钟能出结果，而且 `--renderer-process-limit=2` 跑一轮冒烟可以顺带把它验证掉。

> **实验结果（2026-11-26，已写进 `app/tests/smoke/flash.test.cjs`）：约束被否证。**
>
> 同一页面里两个 `<embed type="application/x-shockwave-flash">` **都**到了
> `PercentLoaded() === 100`，且 `app.getAppMetrics()` 里只有**一个** `Pepper Plugin` 进程
> （`sandboxed: true`）。也就是说：
>
> 1. 「一进程一个 Flash 实例」**不成立**——一个渲染进程里可以同时跑多个 PPAPI 实例，
>    它们共用一个插件进程；
> 2. `clone()` 那条"第二个实例退化"的观察，**不能**再当作"双实例互踩"的证据。更可能的解释是
>    克隆体拿不到 preload / 插件注册（我们自己也实测到克隆体 `preload: undefined`），
>    属于那条路径的实现缺陷，而不是能力边界；
> 3. 因此 **B6 的进程合并对 Flash 标签也可行**，收益估算从"只能合并 Ruffle"扩到"可以合并所有
>    Flash 标签"；同时「复制标签」被否决的那条理由（Flash 单实例）需要重新审——它当初还叠了
>    Ruffle 注入的会话归属，那一条仍然成立，但不再是"Flash 不能同进程"。
>
> 待办：`docs/discussions/2026-11-25-electron-patch-backport-audit.md` 与架构里"Flash 单实例"
> 的表述需要按这条实测更正（该文档是别人的在途改动，本会话未擅改）。

叠加的其它问题：

- **引擎切换**：切引擎是重建 WebContents（`swapView`）。新 WebContents 默认新进程，
  合并规则要能跟着引擎走，否则"切一次引擎就多一个进程"。
- **Ruffle 注入**：注入走**页面 preload**（`createPageView` 里按引擎给 `preload`）。
  进程合并**不影响** preload——preload 是 per-RenderFrameHost 的；`window.open`/`clone` 拿不到 preload
  是另一回事（它们不带 webPreferences）。这点回复说"需验证 Electron 39 能否同进程不同 preload"，
  答案是**能**，只要走的是新建 WebContents（不是 guest）。
- **零成本的先手**：页面视图目前没关的几个 per-WebContents 开关值得试一轮
  （`spellcheck: false`、`v8CacheOptions: 'bypassHeatCheck'`），Flash 浏览器不需要拼写检查，
  而低端模式清单里正好有一项就是"关拼写"（`components/spellcheck/common/spellcheck_features.cc:50`）。

### 4.3 B6 关于 `--enable-low-end-device-mode`：开关真实，副作用面比想象大

它只读 `base::SysInfo::IsLowEndDevice()`，而这个值在**每个进程里各读一次**，
渲染进程是从浏览器命令行透传的（`render_process_host_impl.cc:3694`）。所以"只给页面进程加"= 改 content。

它到底改什么（本机 142 grep 结果，都是真会影响 3D 游戏/渲染的项）：

| 位置 | 影响 |
| --- | --- |
| `cc/trees/layer_tree_host_impl.cc:3377`、`blink/.../layer_tree_settings.cc:169/445/474/549` | 低内存瓦片策略、更小的瓦片/缓存 |
| `cc/tiles/image_decode_cache_utils.cc:42` | 图像解码缓存策略 |
| `components/discardable_memory/...:179`、`.../client...:59` | 可丢弃内存分配粒度变小 |
| `components/services/storage/dom_storage/local_storage_impl.cc:208/348` | DOM storage 配额变小（**老 Flash 站点可能靠 localStorage/SharedObject 存进度**） |
| `components/spellcheck/...:50` | 关拼写检查 |
| `gpu/config/gpu_preferences.cc:51`、`gpu/command_buffer/service/shared_context_state.cc:99` | GPU 侧缓存变小 |

结论：对**空页面/普通网页**大概率省内存；对**Stage3D 游戏**是净风险（缓存变小 → 卡顿）。
建议只在"Ruffle 且非游戏站点"或"低内存机器"上开，并且必须回归 Stage3D AUTO/SOFTWARE 两档
（`docs/reports/2026-11-21-142-flash-runtime.md` 里已有现成用例）。

### 4.4 B7 休眠：数字已经有了，缺的是 Flash 那边

> **前提已于同日定调**：[ADR-0004](../adr/0004-liveness-over-memory-reclaim.md) ——
> **游戏连续性 > 自动化可重复性 > 内存回收**。下面所有"回收多少"的讨论都受它约束：
> 含 Flash 内容的标签**不自动休眠**，回收量在游戏场景下直降到 0，这是有意接受的代价。

- 已有实测（tab-discard 报告）：**≈111 MB/标签**回收、唤醒 **120 ms**、6 标签 1161→619 MB；
  冻结与降优先级 **0～+0.21 MiB**（这就是"为什么没有中间档"的答案，不是没试过）。
- 缺的三块：
  1. **PPAPI 插件进程**：多标签共享一个 `Pepper Plugin` 进程，discard 掉其中一个 Flash 标签
     **不会**释放插件进程那部分 RSS。要把"Pepper Plugin / GPU / 浏览器进程"三类分开记，
     否则永远解释不清"为什么丢了 5 个标签只回收了 N MB"。
  2. **唤醒三段计时**：`select()` → `did-finish-load` → 首帧 → Flash/Ruffle 首帧。
     120 ms 是"重新加载"的口径，游戏站还要加插件实例化。
  3. **Flash 状态**：这是比内存更硬的约束。按 ADR-0004，含 Flash 内容的标签不再进自动休眠；
     真要回收（用户显式要求 / agent 显式请求）时必须 `save → ack` 成功后再 `close()`，
     无 ack 不丢（`SharedObject` 的异步写盘在进程被销毁时不保证落盘）。
- 同样按 ADR-0004 要补的三条守卫（现在都没有）：`contents.isLoading()`、**"不出声"不能当作"没在用"**
  （游戏有长静默期；静音本身不会造成误判，`SetAudioMuted` 只调输出端 `SetMuted`，不动
  `is_currently_audible_`——`audio_stream_monitor.cc:66-68`）、
  **自动化会话存在时扫描器整体停摆**（租约是按 tabId 的，agent 等游戏内回调时根本没有"具体标签"可挂）。


---

## 5. 建议顺序

| 顺序 | 做什么 | 为什么是现在 | 判据 |
| --- | --- | --- | --- |
| **0（现在）** | **按 [ADR-0004](../adr/0004-liveness-over-memory-reclaim.md) 收紧休眠守卫链**（批次 1 已落地：`isLoading` + 页面 DOM 的 Flash 判据 + `BAO_DISCARD_TRACE`；批次 2 待做：自动化全局闸 / `save → ack`） | **不是优化，是当前就在生效的丢存档缺陷**：`tab.discard` 默认 `auto` + TTL 10 分钟，而守卫链不认识 Flash。硬截止：M3 接自动化之前 | ADR-0004 §后果 的用例全过；游戏标签误杀为 0 |
| 1 | 心跳 RTT（主进程 ↔ 外壳 ↔ 浮层两路）+ 浮层 realm 里的 `longtask`/LoAF 上报 | A1/A2 的一切判断都依赖它；半天 | 任意一次 >200 ms 能落到具体 `sourceURL` |
| 2 | CDP 三件套（堆趋势 / scavenge / 帧间隔）跑一次 A/B | A2 现在是"零数据"，这是唯一缺口 | 拿到合并/不合并的 p50/p99 对照 |
| 3 | `--renderer-process-limit=2` + 同页双 `<embed>` 两个零代码实验 | 决定 B6 有没有第二条路线；顺带验证 Flash 单实例的成因 | **已完成（2026-11-26）**：双实例通过（约束否证，见 §4.2）；`--renderer-process-limit` **不合并进程**（探针见 [`evidence/probes/2026-11-26-renderer-limit`](../evidence/probes/2026-11-26-renderer-limit/RESULT.md)）→ 零代码路径是死路，合并只能写内核补丁 |
| 4 | 用 `privateBytes` 重算 69–72 MB，出一次 `memory-infra` 分解 | B6/B7 的所有收益估算都建立在这个口径上 | 得到"每标签私有 ≈X MB、共享 ≈Y MB" |
| 5 | A4 原型（多窗口共用一个外壳进程）；`outlivesOpener: true` **只给外壳文档的 guest**，不给浮层 | 省的是每窗口 ~70 MB，是七条里单笔收益最大的一条 | 5 窗口 private 之和斜率 <15 MB/窗口 |
| 6 | A1 的 ②兜底（心跳超时 → 杀进程 → 自愈） | 自愈已经在，包一层判定即可；这是唯一能抢占的方案 | 注入 3 s 死循环后 UI 在 5 s 内回来 |
| 7 | A3 的 40 ms 分段 + 挪到 focus/pointermove 的 A/B | 竞态已修，成本/收益要重新量 | 窗口出现时间不变、首次打开仍 3–10 ms |
| 8 | A5 的 144 ms 分段（先量再决定要不要 ImageView） | 只在 never/auto 档有体感 | 分段表能指出瓶颈在谁身上 |

---

## 6. 开工判据（什么时候才动）

这张表是本轮的正式答复：**七条里现在只有第 0 项该开工**，其余等触发条件，不按"看起来该做了"开。

| 项 | 开工触发条件 | 为什么不能提前 |
| --- | --- | --- |
| 0 休眠守卫 | **现在**（已触发：默认档在生效 + 丢的是存档） | 晚一天的代价是不可逆的数据丢失 |
| 1 心跳 + 长任务上报 | 现在可以顺手做（半天、dev-only、无产品面） | — |
| 2 CDP 三件套 / A2 调参 | 有人真要回答"浮层常驻值不值这 +6 MB"时 | 没有 1 的数据，调 V8 参数就是猜 |
| 3 两个零代码实验 | 下一次动 Flash 相关代码时顺带 | 结论要等 B6 立项才能用，但成本 15 分钟、且能修正一条**承重假设**（单实例） |
| 4 内存口径重算 | 有人在任何地方引用"每标签 70 MB"做决策之前 | 口径错了会把结论放大一倍 |
| 5 A4 多窗口 | 产品确认"多窗口是一等公民"（不是 tearoff 的副产品） | 会改故障域：所有窗口的 UI 同生共死；且浮层不能跟着开 `outlivesOpener` |
| 6 A1 硬保证 | 有人报告"外壳真的卡死了"，或浮层里要放第三方/重活 | 现网只有一个自家浮层，纪律 + 前台用例足够 |
| 7 A3 40 ms | M2 验收后的一次性 polish | 刚修完地址栏竞态，不要再动启动时序 |
| 8 A5 冷路径 | 用户开始抱怨"不预热时第一次点开慢" | 默认档是 always，冷路径只在用户主动关预热时出现 |

> 一条容易踩的坑：`outlivesOpener: true` **不能无条件打开**。浮层借的是 opener 的 contextBridge，
> 外壳 reload 之后 `window.opener` 换成了新文档、旧闭包全失效，开着这个开关只会把"连同销毁"
> 换成"僵尸视图 + 死桥"。它只对外壳文档这类**自带 preload、不借别人东西**的 guest 成立。

---

## 7. 明确不做（省时间）

| 提案 | 为什么不做 |
| --- | --- |
| 渲染进程内看门狗 + `TerminateExecution` | 只打断 JS、不打断 C++/布局；终止后必须重建文档；与"杀进程 + 自愈"的收益差一个数量级 |
| 冻结档（`SetPageFrozen` / CDP `setWebLifecycleState`） | 实测不释放内存，且会让 `executeJavaScript` 挂死（自动化直接废） |
| 全局 `--process-per-site` | 会把同站点的 Flash 标签合进一个进程，正面撞 Flash 实例限制；站点粒度也不符合"按引擎分组" |
| 全局 `--enable-low-end-device-mode` | 外壳、GPU、DOM storage 配额一起降级；应当按引擎/机型选择性开 |
| `MemoryPurgeManager` 类后台清理 | 142 的 content 里没有；Chrome 那套在 `chrome/browser/`，Electron 不带 |
| `electron-mksnapshot` 自定义快照 | DOM 依赖进不去快照，维护成本远超它要省的 40 ms |
| 用 `workingSetSize` 求和做内存结论 | 共享代码页重复计，会把收益和问题同时放大一倍以上 |
