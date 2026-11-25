# 已引入补丁的影响面（截至 2026-11-25 batch4）

一句话：**内核侧 5 条补丁（4 条上游回拣 + 1 条自研），共 121 行；应用源码 0 行改动。**
影响集中在四处：窗口命中测试、叠加层生命周期、进程退出路径、主进程 API 面。

## 1. 逐条影响面

| 补丁 | 上游 | 改动 | 落在哪 | 用户/团队可感的变化 | 回归风险面 | 覆盖用例 |
| --- | --- | --- | --- | --- | --- | --- |
| [0003](0003-51200-hidden-view-drag-regions.patch) | #51200 | +7/−1，1 文件 | `WebContentsView::NonClientHitTest` | 隐藏的 WCV（飞窗）不再把 `app-region: drag` 区贡献给父窗口命中测试 → **飞窗收起后那块区域点击不再拖窗口** | 窗口拖动/命中测试 | `quick-settings`、`titlebar`，探针 `drag-region-e39-repro.js` |
| [0004](0004-50688-wrappable-deferred-destruction.patch) | #50688 | +34/−3，2 文件 | `gin_helper::Wrappable` / `WrappableBase` | **退出时不再因「WebContents 在 JS 侧被 GC 时析构」而崩溃**（`Invoke in DisallowJavascriptExecutionScope`） | 所有 gin 包装对象的析构时机（全进程级） | 每次冒烟的退出路径；探针 `batch1-scenarios-probe.js` 的 `wrappable-gc` |
| [0006](0006-53031-detached-view-bounds.patch) | #53031 | +20/−3，2 文件 | `InspectableWebContentsView::Layout` | 视图**不在窗口里**时设 bounds 也会把尺寸传给页面 → **叠加层首次 `setBounds`（早于 `addChildView`）不再得到 0×0 视口** | 视图尺寸传播；叠加层首帧 | `quick-settings`、`overlay-prewarm-hidden`，探针 `probe-detached.js` |
| [0007](0007-49959-webcontents-clone.patch) | #49959 | +44/−1，3 文件 | `electron_api_web_contents.{cc,h}` + 文档 | **零行为变化**（新增 `clone()`，产品未使用） | 主进程 API 面 +1 个方法 | 无（未接入；clone 语义见 batch3 记录） |
| [0008](0008-frameless-resize-band-dpi.patch) | 自研 | +16/−2，1 文件 | `FramelessView::ResizingBorderHitTest` | **无边框窗口边缘可抓区 3–4 → 8 物理像素**（150% DPI）；100% DPI 下不变 | 窗口边缘命中测试（含页面四边 8 px） | `startup`/`titlebar`/`tabs` 等点击类用例；探针 `probe-resize-band.js` |

合计：`+121/−10`，涉及 8 个内核文件（含 1 个文档）。

## 2. 应用侧改动（全部非源码）

| 文件 | 性质 | 说明 |
| --- | --- | --- |
| `app/scripts/runtime-manifest.json` | 账目 | exe 哈希、`kernel.tag`（`…+e39-batch4`）、`patches` 数组、`electronCommits`、`fallbackTag` |
| `app/scripts/test.cjs` | **测试基建 bug 修复** | `--foreground` 被 `else` 分支撤销，导致 7 条前台用例从未执行；修复后实跑 58/58 |
| `app/tests/smoke/tab-duplicate-ruffle.test.cjs` | 新增用例 | 复制 Ruffle 标签必须走回退路径：副本独立进程 + 两实例都出画布 |
| `app/tests/smoke/overlay-prewarm-hidden.test.cjs` | 新增用例 | 预热叠加层 → 显示 → 不是空白（#52844 的闸门；仅前台运行） |
| `app/README.md` | 文档 | 前台验收的真实期望（58/58）与"别切走焦点"提醒 |

**`app/src/` 下没有任何我们造成的改动**（`activity-lease.ts` 的 diff 来自另一个会话，与本轮无关）。

## 3. 运行时与产物

| 项 | 值 |
| --- | --- |
| 内核 tag | `bao-v142-265-ppapi-sandbox+win-ppapi-process-sandbox+e39-batch4` |
| `electron.exe` | `0A7C92A9388D3A4F61E54FDBE273868BB5C66BFE4CBEE14CBADF1950D7B1DE3F`（232,040,960 B） |
| 内核分支 | `bao/e39-batch4`：`a5693f61ab` → `08dac9259e` → `5faf91f967` → `c244a99d9c` → `353fb66eb0` |
| Chromium 树 | 未改（`af379570b1d17`，PPAPI 沙箱补丁 0002 之上） |
| 回退链 | `win-x64-before-e39-batch4`（batch3）→ `…batch3`（batch2）→ `…batch2`（batch1 全量）→ `…batch1`（5BB2274F 全量） |

## 4. 风险排序（从高到低）

1. **0008（缩放带）**：唯一改了"窗口边缘命中"的补丁。副作用是**页面四边各 8 px 变成缩放带**——点那里会拉窗口而不是点页面。与 Chrome/Edge 一致，但若将来页面边缘要放可点控件需注意。**建议在多显示器 / 100% 与 200% DPI 下各手测一次**（本机只有 150%）。
2. **0004（Wrappable 析构）**：影响面最广（所有 gin 包装对象），但方向是"把同步 delete 改成 posted task"，属降风险改动；已由退出路径与 58 条冒烟覆盖。
3. **0006（detached bounds）**：只在"视图不在 widget 里"时触发，触发面窄；副作用是给脱离窗口的 WebContents 主动 `Resize`。
4. **0003（隐藏视图命中）**：只影响隐藏 WCV 的拖动区，语义明确。
5. **0007（clone）**：零影响（无调用方），仅主进程多一个方法。

## 4.5 0008 缩放带的 DPI 验证（2026-11-25 实测三档）

同一套探针（`WM_NCHITTEST` 逐像素取样）在真实显示缩放下跑新旧内核：

| 显示缩放 | 旧内核（无 0008，`5BB2274F`） | 新内核（含 0008，`0A7C92A9`） | 5 DIP 应有带宽 |
| --- | --- | --- | --- |
| 100% | 4 px | **4 px** | 5 px（取整/边界差 1） |
| 150% | 4 px | **7 px** | 7.5 px |
| 200% | 4 px | **9 px** | 10 px |

四个方向（左/右/上/下）在每个缩放比下读数一致；100% 与 200% 各复测一次，结果稳定。

**结论**：

1. **旧内核的带宽恒为 4 px，不随 DPI 变化** —— 这就是缺陷本身（常量按 DIP 定义、命中点按设备像素到达）。
2. **新内核按 5 DIP 正确换算**：4 / 7 / 9 px 分别对应 100% / 150% / 200%。
3. **100% 下新旧完全一致（都是 4 px）**，证明改动在无缩放时是恒等变换，不存在回归面。

> 中途试过用 `--force-device-scale-factor` 模拟：**无效**。它只改渲染侧 `devicePixelRatio`，
> 不改窗口的 DPI 感知，窗口几何直接对不上（强制 100% 时 400×300 的窗口变成 267×200，
> 强制 200% 时变成 533×400）。那批读数已作废。真实的 DPI 验证只能改系统缩放。

## 5. 未覆盖 / 未验证

| 项 | 状态 |
| --- | --- |
| 100% / 200% DPI 的缩放带 | ✅ 已实测（见 §4.5）：100% 4 px（与旧内核一致）、150% 7 px、200% 9 px |
| 多显示器（不同 DPI 拖动窗口） | ❌ 未测 |
| 前台模式的 Flash 全量路径 | ⚠️ 前台 58/58 通过，但未在真实站点（如 4399）复测 |
| 已有 flake | ⚠️ 隐藏模式下 `engine-rules` / `input` 偶发超时，与补丁无关但会干扰判读 |
| 长稳（挂机 + Flash + 休眠） | ❌ 未做 |

## 6. 回退粒度

- **单条补丁**：内核树 `git revert <sha>` → `ninja -C out\Rel electron` → 重新装配。
- **整体**：把 `.runtime/win-x64/electron.exe` 换回 `win-x64-before-e39-batch4\electron.exe`（batch3 内核）并同步 manifest 的哈希与 tag，一步回到上一批。
- **完全回到 M1 状态**：`win-x64-before-e39-batch1`（`5BB2274F…`，未含任何本轮回拣）。

## 7. 修正节（2026-11-25 22:40 追加）

本文记录的测试基建事实不变；受影响的只是"用例数"这类会随迭代变化的数字：

| 项 | 当时 | 现在 |
| --- | --- | --- |
| 前台验收 | 58/58 通过 | **70/70 通过，0 跳过** |
| 隐藏并行 | 27 文件 / ≈60 s | **28 文件 / 84.6 s / 0 失败** |

另有一条与本轮无关、但值得知道的观测约束：**渲染进程崩溃后 Playwright 的 Page 句柄永久失效**
（`Target crashed`、不再发 `window` 事件、`app.close()` 会挂住）。崩溃类用例的断言改由主进程写诊断文件，
测试只读文件并在 `finally` 里限时关闭 + `taskkill` 兜底，见 `app/tests/smoke/shell-crash-heal.test.cjs`。
