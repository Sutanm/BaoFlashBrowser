# 引擎切换的手感：点击为什么没有即时反馈

2026-11-27 · 诊断报告 + 方案 + **实施记录**。

**状态：已实施（2026-11-27）。** §1–§6 是诊断原文（不含代码改动），采用方案是 §7 的 **D（候选先挂载）+ A（回执）**；
最终落地的不是 §4 的 A/B/C 任何一档，§4 B 的判据被推翻（见 §7.4）。

关联：[ADR-0004 §3b](../adr/0004-liveness-over-memory-reclaim.md)（手动切换引擎是显式动作，不受 `save → ack` 约束）、
[`kickoff/m2-beta.md`](../kickoff/m2-beta.md)（两阶段引擎切换「已交付」）、
提交 `c174ca2`（两阶段引擎切换：候选准备 / 提交 / 取消）。

**与既有结论的关系**：`kickoff/m2-beta.md` 说两阶段「已交付」是准确的——候选准备、提交校验、取消与回滚
都有用例覆盖。本报告不推翻它，只补一条它没覆盖的东西：**切换过程对用户完全不可见**。

---

## 1. 结论

问题的落点不是「切换慢」，而是三件事叠在一起：

1. **切换动作被绑在「整页加载完成」上**。`switchEngine()` 等到候选视图 `did-finish-load`
   才提交（`app/src/main/browser-window.ts#L2113`、`#L2273`、`#L2212`），所以一次点击的 IPC
   往返 = 页面重新加载的墙钟时间，最长 15 s（`#L311`–`#L314`）。
2. **这段等待里界面一个字节都不变**。候选视图未挂载（旧页照旧）、旧页没在加载（标签不转圈）、
   快照不更新（`createEngineAttempt` 里一次 `publish()` 都没有）、面板不打勾也不禁用。
   实测：点击后 **4.2 s 内唯一的变化出现在最后那一刻**（图标翻转 + 面板关闭同时发生）。
3. **连点被静默吞掉，而且吞得很彻底**。`ShellOverlay.submit()` 的 `busy`
   （`app/src/renderer/ShellOverlay.vue#L45`）在切换结束前一直是 true；引擎面板又住在
   **常驻共享叠加层文档**里，关掉再打开不会重建组件，`busy` 仍为 true。所以第 2、3 次点击
   **连 IPC 都不发**，主进程的 `cancelEngineSwitch()` 根本不会被调用——既不是「重来一次」，
   也不是「取消」，是纯粹的丢失。

一句话：**用户点下去，然后在 4 秒（或 15 秒）里得不到任何“我收到了”的证据**，于是继续点，
每次都被丢掉。

---

## 2. 实测

环境：真实自编译运行时 `app/.runtime/win-x64/electron.exe` + 独立 `--user-data-dir` 临时 profile，
时间 2026-11-27。主进程只挂只读监听（`app.on('web-contents-created')` 打点），未改仓库代码；
复现方法见附录 A。

### 2.1 一次切换要多久（点击 → `set-engine` IPC 返回）

| 场景 | 耗时 | 主进程打点 |
| --- | --- | --- |
| 极简本地页 ppapi→ruffle | **121 ms** | 创建→dom-ready 105 ms→finish 107 ms |
| 极简本地页 ruffle→ppapi | **91 ms** | — |
| 本地 Flash 样本（`probe.swf`） | 154 / 94 ms | — |
| 页面含 1 张 4 s 才返回的图片（`no-store`） | **4 133 ms** | dom-ready 124 ms → **did-finish-load 4 118 ms** |
| 同一地址「普通导航」（对照） | **4 ms** | 导航不等加载，立刻返回 |
| 4399 首页（已 `complete`） | 414 ms | — |
| 4399 游戏页 `flash/210650.htm` | **3 153 ms**（切 Ruffle）/ 576 ms（切 PPAPI） | dom-ready 570 ms → **finish 3 139 ms** |
| 页面里挂一个永不返回的 iframe | **15 021 ms → `engine-switch-failed`** | 卡满 15 s 上限，页面毫无变化 |

两条最关键的对照：

- **同一页面、同一地址**：普通导航 4 ms 返回，切引擎 4 133 ms 返回——差别只在「等不等加载」。
- **4399 游戏页**：`dom-ready` 只用 570 ms，剩余 2.5 s 全在等 `g.php`、`cdn.comment.4399pk.com`
  这些第三方 iframe 的 onload（顶层 load 事件会等子帧）。

### 2.2 点击 → 界面变化的时间轴（慢资源页，切换固定 ~4.2 s，真点工具栏按钮与面板档位）

```
点击 Ruffle …
+0ms      面板可见=true；Flash 档 aria-pressed=true；Ruffle 档 aria-pressed=false
+1500ms   面板：Flash 仍 pressed=true、Ruffle 仍 pressed=false
          两档 aria-disabled=false、aria-busy 标记数=0、无 spinner
          （期间外壳引擎按钮 title 也不变）
+2681ms   外壳引擎按钮 title 变 + 面板同时关闭   ← 唯一的视觉变化
```

同一次 100 ms 采样里出现的两项变化（图标翻转、面板关闭）无法区分先后，但它们**同时**发生在结束那一刻。

### 2.3 连点到底发生了什么

| 场景 | 新建候选 WebContents | 从第一次点击到面板关闭 |
| --- | --- | --- |
| 点一次 | 1 个 | 4 213 ms |
| 400 ms 后再点一次 | **1 个** | 4 212 ms（不是 2 个，也没有重来） |
| 点一次 → 关面板 → 重开 → 再点 | **1 个** | 4 127 ms |

三次实验都只产生 1 个候选 → 第二次起的点击没有走到主进程。若第二次真的重来过，总时长会是
`4 s + 1.2 s + 4 s ≈ 9 s`，实测仍是 ~4.1 s。

---

## 3. 代码事实

> 行号按 2026-11-27 的工作副本核对（当时工作区里有他人未提交的收藏夹改动，与引擎切换无关）。

### 3.1 主进程：切换动作 = 一次「等加载」的 IPC

| 位置 | 事实 |
| --- | --- |
| `app/src/main/browser-window.ts#L2113` | `switchEngine()` 是 `async`，`await prepareEngineCandidate(...)` 之后才 `commitEngineAttempt()` |
| `#L2273` | `prepareEngineCandidate()`：有导航栈就 `navigationHistory.restore()`，没有就 `loadURL(fallbackUrl)`，两种都等 `createLoadWaiter` |
| `#L2212` | `createLoadWaiter()`：成功唯一判据是 `did-finish-load`；`did-fail-load`(≠-3)、崩溃、销毁、`ENGINE_PREPARE_TIMEOUT_MS`(=15 000，`#L314`) 都算失败 |
| `#L2349` | `commitEngineAttempt()`：**此刻**才换视图、推进绑定代际、更新 `tab.engine`、关闭旧 WebContents、`publish()` |
| `#L2185` | `createEngineAttempt()`：建候选视图、`revive` 绑定，**不 publish**——界面此时对「正在切换」一无所知 |
| `#L2169` | `cancelEngineSwitch()`：只清候选，不改已提交状态（连点的正确落点，但界面从来没调到它） |

### 3.2 界面：点了就等，等到结束才关面板

| 位置 | 事实 |
| --- | --- |
| `app/src/renderer/ShellOverlay.vue#L45` | `submit()`：`if (busy.value) return false`，`busy` 只在 `store.run()` 兑现后的 `finally` 复位 |
| `ShellOverlay.vue#L57` | `choose()`：`await submit({type:'set-engine'})` **成功后**才 `closePanel()`——面板关闭被绑在切换完成上 |
| `ShellOverlay.vue#L113` | 档位按钮的 `aria-pressed` 取 `active?.engine`（提交后才变），`aria-disabled` 不含 `busy` → 等待期间外观零变化 |
| `app/src/renderer/App.vue#L961` | 引擎按钮同样只在快照变化时变（`engine-${active.engine}`、title），没有「切换中」态 |
| `app/src/shared/browser.ts#L168` | `BrowserTab` 没有 pending 字段；`tab.engineSwitch` 只出现在 `debugState()`（`browser-window.ts#L2893`、`#L2902`，调试通道） |
| `docs/reports/2026-11-24-overlay-single-view.md#L26` | 叠加层是**同一文档 `v-show` 切换**——所以 `busy` 跨面板开合持续有效（2.3 第三行的机制） |

### 3.3 为什么这套设计会长成这样（不是随手写的）

旧实现（M1，2026-11-23 前）就是「先销毁 → 重建 → 在新引擎上恢复导航栈」，失败只能在新引擎重开地址，
「保留原引擎」是假的（`docs/reports/2026-11-22-m1-shell-increment.md#L231` 的 P2 修正）。
`c174ca2` 把它改成两阶段，为的是拿到**失败原子性**：`engine-switch-failed` 时旧视图/引擎/代际全不变，
旧页还能 `executeJavaScript`（`app/tests/smoke/engine-switch.test.cjs#L197`–`#L232` 就是断言这个）。

所以「等加载」不是多余动作，它是「失败什么都不变」的价格。**但 ADR-0004 只裁决了「要不要保留运行态」，
没裁决「切换过程要不要可见」**——这就是缺口所在。

### 3.4 老项目对照（`BaoFlashBrowser` 1.1.2 / Electron 11 / Chromium 87）

```ts
// src/main/modules/tabs.ts#L734
setRuffleMode(tabId, enabled, source) {
  const currentUrl = tab.browserView?.webContents.getURL() || tab.lastTargetUrl
  if (tab.browserView) { const old = tab.browserView; tab.browserView = null; this._disposeView(old) }
  tab.isRuffle = enabled
  tab.ruffleSource = enabled ? source : undefined
  tab.crashed = false
  if (needsBrowserView(currentUrl)) {
    const wc = this._createView(tab)     // 立刻挂上并 setBounds 到原矩形（#L523）
    if (wc) void wc.loadURL(currentUrl)  // fire-and-forget：不 await、不判结果
  }
}
```

| 维度 | 老项目 | 新项目 |
| --- | --- | --- |
| 何时返回 | 同步完成销毁+建视图，`loadURL` 不 await → 毫秒级 | 等 `did-finish-load`，= 页面加载时间 |
| 视觉反馈 | 视图当场换、页面立刻转圈；渲染层先乐观翻转 `ruffleMode`（`src/renderer/App.tsx#L231`） | 4 s / 15 s 内零变化 |
| 导航历史 | 不恢复（只重开 `getURL() \|\| lastTargetUrl`；Electron 11 无 `navigationHistory` API） | `restore()` 尽力恢复，失败走 `degraded` + notice |
| 失败 | 无分支、无回滚，界面早已声称已切换 | `engine-switch-failed`，旧状态完全保留 |
| 视图开关 | `plugins: !isRuffle`、`contextIsolation: !isRuffle`、**`backgroundThrottling: false`**（`tabs.ts#L505`–`#L517`） | 页面视图未设该项（`browser-window.ts#L969`），默认节流 |

**老项目并不更快**：页面一样要重新加载。它的差别是把「切换动作」和「页面加载」解了绑——动作瞬间完成、
加载是可见的后续事件。它的代价（丢历史、失败不可回滚）正是 `c174ca2` 要修的东西。

---

## 4. 方案（三档，均未实施）

### A. 只修反馈，不动切换语义（推荐先做）

| 编号 | 改什么 | 位置 |
| --- | --- | --- |
| A1 | 面板**点了就关**：`choose()` 不再 `await submit` 后再关，改为点击即 `closePanel()`，结果交给 toast | `ShellOverlay.vue#L57` |
| A2 | 快照带「切换中」：`BrowserTab` 加可选 `pendingEngine`，`state()` 取 `tab.engineSwitch?.engine`，并在 `createEngineAttempt()` / `cancelEngineSwitch()` / `commitEngineAttempt()` 各 `publish()` 一次（现在 create 一次都不发） | `shared/browser.ts#L168`、`browser-window.ts#L2185` / `#L2169` / `#L2349` |
| A3 | 外壳引擎按钮显示切换中（`engine-switching` + `aria-busy` + title「正在切换到 Ruffle…」），内部页/无站点时仍禁用 | `App.vue#L961`–`#L969`、`#L115`–`#L124` |
| A4 | 失败/取消沿用现有文案（`engine-switch-failed` / `engine-switch-cancelled`，`shared/browser.ts#L153`–`#L155`），不再出现「点了没反应也没解释」 | 无需新文案 |

影响面：只有渲染投影与面板状态；`switchEngine` 的语义、`did-finish-load` 判据、15 s 上限全部不动，
`engine-switch` 的 8 条冒烟不受影响。
新增验收：点击后 100 ms 内快照出现 `pendingEngine`，且 4 s 慢页在等待期间按钮为 `aria-busy`。
风险：`pendingEngine` 是投影新字段（只增，revision 单调递增）；自动化能力面不涉及。

### B. A + 把等待缩到「主帧完成」

- 成功判据从 `did-finish-load`（顶层的 load 事件，会等所有子帧）改为**主帧导航完成**
  （`did-frame-finish-load` 的 `isMainFrame` 分支，或 `did-navigate` 主帧提交 + 短宽限）。
  【待核】Electron 39 上 `did-frame-finish-load` 的确切签名与 `restore()` 组合行为。
- 实测依据：4399 游戏页 `dom-ready` 570 ms vs `finish` 3 139 ms，这一刀能省掉约 2.5 s 的广告 iframe 等待。
- 失败/降级语义不变（仍是候选未提交就丢弃）。
- 验收：`engine-switch` 8 条全过 + 新增 1 条「第三方 iframe 永不返回时仍在 ≤2 s 内提交」。
- 风险：提交时页面脚本/SWF 可能尚未就绪 → 用户看到的是可见的加载过程（与老项目一致），不是空白。

### C. 对齐老项目：先换视图再加载

- 直接用现成的 `swapView()` + `load()`（`browser-window.ts#L2068`、`#L1745`，站点规则换引擎已经走这条路）。
- 代价：失败语义退回「在新引擎重开地址并提示」，`engine-switch-failed` / `engine-switch-cancelled`
  的 8 条用例要重写；历史恢复要么放弃、要么改为提交后尽力恢复。
- 与 `c174ca2` 的裁决冲突，需要 ADR 层重新裁决（ADR-0004 §3b 只说了「不受 save→ack 约束」，没说失败语义）。

---

## 5. 建议

1. **先做 A**：零语义风险，把「点了没反应」变成「点了就有回执」，也让「连点被吞」有解释
   （按钮 disabled + 进度）。
2. **B 单独裁决**：判定时机是纯性能参数，与失败语义无关，但会改变 `degraded`/`restore` 的触发面。
3. **C 不建议在 M2 内动**：它推翻的是 `c174ca2` 刚立的语义，收益（体感）在 A+B 之后基本被覆盖。
4. **落地后的文档回填**：`kickoff/m2-beta.md` §1 现在只记「两阶段引擎切换：已交付」，
   实施 A（或 A+B）后需在那里补一句「切换过程有可见进度」，并同步本节的三档裁决结果。

---

## 6. 未验证 / 待核

| 项 | 说明 |
| --- | --- |
| `backgroundThrottling` | 老项目给每个视图设 `false`（`tabs.ts#L515`），新项目页面视图没设（`browser-window.ts#L969`）。候选视图提交前未挂载，属隐藏渲染进程，被节流是否拖慢候选自身加载**未测**——这是唯一可能影响「加载本身快慢」的差异 |
| `document.visibilityState` | 候选视图未挂载 ⇒ 页面看到 `hidden`；对靠可见性推迟工作的站点脚本/广告有何影响**未测** |
| 15 s 上限 | 现在「永不 fire onload」的站点 = 白等 15 s 后失败。是否改成更短上限、或超时后走 `degraded` 提交，**待裁决** |
| `did-frame-finish-load` | Electron 39 签名与 `navigationHistory.restore()` 组合后的时序**待核** |

---

## 附录 A 复现方法（探针不入库）

两个探针脚本只放在临时目录（`%TEMP%\bao-probe\`），不进仓库：

```powershell
# 切换耗时 + 主进程阶段打点（simple / slowimg / hangiframe / flash / navigateCompare / real4399 / realgame）
node probe.cjs slowimg

# 真实点击链路：工具栏按钮 + 面板档位（single / inspect / double / reopen）
node probe-ui.cjs inspect
```

共同做法：Playwright `_electron.launch` 起真实运行时 + 独立 `--user-data-dir`；
主进程只装只读监听，不改产品代码：

```js
// 候选视图的阶段打点（probe.cjs）
app.on('web-contents-created', (_event, contents) => {
  const record = { id: contents.id, created: Date.now(), events: [], url: '' }
  contents.on('did-start-navigation', (_e, url, _p, isMainFrame) => isMainFrame && (record.url = url))
  contents.on('dom-ready', () => record.events.push(['dom-ready', Date.now()]))
  contents.on('did-finish-load', () => record.events.push(['did-finish-load', Date.now()]))
  contents.on('did-fail-load', (_e, code) => record.events.push([`did-fail-load ${code}`, Date.now()]))
})

// 面板档位真点（probe-ui.cjs）：找到叠加层视图 → sendInputEvent 到档位中心
view.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
view.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
```

指标口径：

- **切换耗时** = 外壳里 `window.baoBrowser.run({type:'set-engine'})` 的往返（与面板点击同一条 IPC 路径）；
- **阶段打点** = 候选 WebContents 的 `created / did-start-navigation / dom-ready / did-finish-load`；
- **界面变化** = 每 100 ms 采一次「面板视图 `getVisible()` + 外壳 `.engine-button` 的 title/class +
  面板档位的 `aria-pressed` / `aria-disabled` / `aria-busy`」；
- **连点效应** = 统计 `web-contents-created` 里新增的页面 WebContents 数量（每次 `switchEngine()`
  恰好建 1 个候选）。

---

## 7. 实施记录（2026-11-27，D + A 已落地）

> 本节由实施轮追加。上面 §1–§6 保留原样，只在两处被推翻：§4 B 的**判据**（见 7.4）
> 与「方案只有三档」这个前提（§4 漏了 D）。

### 7.1 采用的不是 A/B/C 中的任何一档

三档把「可见」与「失败原子性」当成互斥的。**两者其实解耦得开**：候选视图在
`createEngineAttempt()` 里早就存在并在加载，缺的只是「挂进窗口」这个动作。所以：

> **D（新增）：候选视图建好就挂上去，盖在旧视图上面；提交/失败只决定「最终留谁」。**

拿到 C 的体感，却一步不动 `c174ca2` 的语义——旧视图在提交前不销毁，失败仍零残留。

配套的 A（回执）也做了：

| 编号 | 改动 | 位置 |
| --- | --- | --- |
| D1 | 候选在 `createEngineAttempt()` 内挂载（仅活动标签）、矩形走新的 `pageBounds()`，`layout()` 同步候选矩形 | `browser-window.ts` `createEngineAttempt` / `syncAttemptMount` / `pageBounds` |
| D2 | 取消/失败/关闭/移交统一走 `detachAttemptView()`：摘掉候选、输入目标还给已提交视图、焦点只在候选拿着时才还回去 | 同上 |
| D3 | 切标签时候选跟着摘/挂（`select()` → `syncAttemptMount()`），提交后只留已提交视图 | `browser-window.ts` `select` |
| A1 | 面板点档位即关，结果交给快照与失败提示；不再 `await` 一次可能要 15 s 的 IPC | `ShellOverlay.vue` `choose()` |
| A2 | 快照新增 `pendingEngine`；`createEngineAttempt` / `cancelEngineSwitch` 各 `publish()` 一次；候选存续期 `loading` 恒为真 | `shared/browser.ts`、`browser-window.ts` `describe()` |
| A3 | 工具栏引擎按钮：`engine-switching` 呼吸（`prefers-reduced-motion` 下静止）+ `aria-busy` + title「正在切换到 X…」；面板档位 `aria-busy` 与「正在切换…」 | `App.vue`、`ShellOverlay.vue` |

### 7.2 实测（同一台机，临时探针不入库，慢资源页 `no-store`）

场景：页面含一张 4 s 才返回的图片；真实点击工具栏 → 面板 → Ruffle 档位，25 ms 采样。

| 时刻 | 旧行为（§2.2） | 现在 |
| --- | --- | --- |
| 快照出现 `pendingEngine` | 从不 | **4 ms** |
| 面板关闭 | 4 213 ms（与提交同时） | **4 ms** |
| 窗口里出现第二个页面视图（看得见的新页） | 4 133 ms | **56 ms** |
| 工具栏 `aria-busy=true` | 从不 | **56 ms** |
| 提交（`engine` 变为 ruffle） | ~4.2 s | 4 143 ms（**判据未动**，见 7.4） |

等待中途抓的窗口截图：候选页已经把「慢图页」标题画出来、图片位置空着、工具栏与页面之间无错位、
无旧页穿透；标签栏在转圈，引擎按钮呈呼吸淡化。即用户看到的是**一次正常导航**，而不是 4 s 空白。

顺带一个观测：不加 `no-store` 时同样的慢图页在候选里 137 ms 就完成——候选重新加载会命中缓存。
所以真实站点上「等 4 s」的场合并没报告里那么普遍，但**挂载与提交解耦**这件事与缓存无关。

### 7.3 用例

`engine-switch` 从 8 条增到 11 条，新增：

1. `准备期间候选已挂载且旧视图仍存活：取消后只剩旧视图并可用`——同时挂两个视图、`pendingEngine`/`loading` 可见、取消后回到一个且旧页仍能执行脚本。
2. `准备期间切换标签：候选跟着活动标签摘挂，不挡别人也不被取消`——切走时窗口里只剩当前标签视图，切回后候选重新挂上，最终提交成功。
3. `点档位即关面板：切换失败时旧引擎保留，失败提示仍然到达`——守住「面板关了之后 `report-failure` 仍能到」这个易碎点（见 7.5）。

跑过的：`engine-switch` 11/11、`engine` 3/3、`engine-rules` 1/1、`theme` 2/2、
`session-restore` 8/8（首轮曾偶发 1 条超时，单跑复现不了）、`unit`、`data` 全绿。

### 7.4 推翻 §4 B 的判据

`did-frame-finish-load(isMainFrame=true)` **不会**省掉那 2.5 s：主帧的 `load` 事件按规范要等
子帧 `load` 完成，主帧的「帧加载完成」同样晚到。报告自己的数据正是反证（`dom-ready` 570 ms
vs `finish` 3 139 ms）。要切开这段，判据应当是**顶层 `dom-ready`**（可选加几百毫秒宽限等首屏），
或 `did-frame-navigate(isMainFrame)`。

本轮**没有**动判据：D 已经解决了「点了没反应」，B′ 是纯性能项，需要单独裁决与实测。
若要做，两个待核点：① 新建视图的初始 `about:blank` 会不会先派发 `dom-ready` 让 waiter 提前结算
（现有 `candidateAddressReady()` 只查 URL，兜不住）；② `restore()` 与 `dom-ready` 的先后。

### 7.5 遗留

- **没有「取消切换」入口**：候选挂载后点当前引擎档位只是关面板，不发取消命令。主进程已有
  `cancelEngineSwitch()`，要暴露成命令得走能力层与用例，本轮未做。
- **失败只靠 toast**：面板已关，失败信息不落 `tab.notice`。若 toast 被错过，用户看到的是
  「还是旧引擎」。是否补一条常驻 notice 待裁决。
- `report-failure` 的发送者角色校验在面板关闭后靠 `shell-overlays.ts` 的 `role = flyout?.kind ?? 'quick'`
  兜底才通过。现在有用例守着，但这是巧合而不是契约——收严那一天要同步改面板的失败上报路径。
