# 批次 2 复查：#53031 已落，#55955 暂不落

2026-11-25 · 内核分支 `bao/e39-batch2`（基于 `bao/e39-batch1`）。
探针：[probe-detached.js](probe-detached.js)（`#53031`）。

## 一、#53031（视图不在 Widget 里时 setBounds 不传给页面）

### 改前/改后（真实运行时，`innerWidth/innerHeight`）

改前 = batch1 已装配内核 `7925BA9E`；改后 = `1C1DE6B1`（+20 行移植）。

| 场景 | 改前 | 改后 | 结论 |
| --- | --- | --- | --- |
| **A** 从未 attach → `setBounds(400×300)` → load | **`[0,0]`** | **`[400,300]`** | ✅ 修复 |
| **B** attach 后 load → `setBounds(400×300 → 500×400)` | `[400,300] → [500,400]` | 相同 | 无回归 |
| **C** attach → load → `removeChildView` → `setBounds(520×420)` | `[500,400]`（stale） | **`[500,400]`（仍 stale）** | ❌ **未修复** |
| **D** 叠加层真实顺序：`setBounds(360×240)` 早于 `addChildView` | 附着前 `[0,0]` → 附着后 `[360,240]` | 附着前 **`[360,240]`** | ✅ 修复 |

### C 为什么没修好

上游把修复挂在 `InspectableWebContentsView::Layout()` 里；E39 上视图从窗口移除后，`setBounds` **不再触发一次 Layout**（没有 widget 就没有布局 pass），所以兜底逻辑进不去。试过把判据放宽成 `(!GetWidget() || !parent())`，实测 C 仍 stale（编译通过、行为不变），已退回与上游一致的 `!GetWidget()`。

**对产品无影响**：tearoff 的顺序是 `detach → 立刻 attach 到新窗口 → 再 layout()`，中间不对已脱附的视图调 `setBounds`。

### 为什么 A/D 有价值

A 与 D 是**同一条产品路径**：`shell-overlays.ts` 的 `sync()` 先 `setBounds`、后 `raise()`（`addChildView`）。修复前那一刻页面视口是 `0×0`，叠加层一旦在这时测量自身高度（它确实会 `resize-quick` 上报 scrollHeight），拿到的就是错误基准；修复后视口从一开始就正确。

## 二、#55955（换宿主时 relay 不重定向）：缺陷真实，但观测不到

### 缺陷确实存在

E39 的 `content::WebContentsUserData::CreateForWebContents` 语义是 **已存在就静默跳过**：

```cpp
if (!FromWebContents(contents)) { contents->SetUserData(...); }
```

而 `WebContents::SetOwnerWindow()` 只调 `NativeWindowRelay::CreateForWebContents(...)`。所以 WebContents 换窗口（tearoff）后，relay 仍指向旧窗口。

### 但 E39 里没有能观测到它的消费者

| 消费者 | 位置 | 是否在我们的路径上 |
| --- | --- | --- |
| `GetSizeForNewRenderView` | `electron_api_web_contents.cc:3755` | 仅 OSR，否 |
| webview guest 初始化 | 同上 `:981` | 不用 webview，否 |
| `web_contents_preferences` 的 embedder relay | `web_contents_preferences.cc:444` | 仅 webview，否 |
| 下载对话框父窗口 | `electron_download_manager_delegate.cc:234` | 下载默认拒绝，否 |
| `getOwnerBrowserWindow()` | `electron_api_web_contents.cc:3814` | **走 `native_lifecycle_->owner_window_`，不读 relay** |

结论：**公开 API 与我们的产品路径都观测不到差异**，按纪律不落（与 #51900 同类处置）。等真的用上 webview / OSR / 下载 / 独立 DevTools 时再评估。

## 三、回归

| 项 | 结果 |
| --- | --- |
| 探针 A–D | 见上表；A/D 修复、B 无回归、C 已知缺口 |
| 整套冒烟（串行，已装配运行时） | **56 用例 / 50 通过 / 0 失败 / 6 跳过**，179.8 s |
| 测试目录冒烟（`win-x64-batch2-test`，哈希与清单不符 → Flash 用例跳过） | 47 通过 / 0 失败 / 9 跳过 |

**一个已存在的偶发**：`engine-rules.test.cjs` 在整套串行里出现过一次 32 s 超时（"panel 叠加层未显示预期控件：记住当前引擎"），同一构建单跑 **3/3 通过**、整套再跑也通过。与本次补丁无关，属既有 flake，已在增量记录里登记。
