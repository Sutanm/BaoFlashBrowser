# E39 回拣实施计划（批次、移植卡与账目）

2026-11-25 · 上游原文见 [`upstream/`](upstream/README.md)，分级依据见[回拣审计](../discussions/2026-11-25-electron-patch-backport-audit.md)。

## 0. 先看结论

| 事实 | 影响 |
| --- | --- |
| 18 条里 **3 条可直接 `git apply`**（#50688 / #51900 / #51562），其余 15 条需手工移植 | 可直接应用的都是"原样存在"的；手工移植的体量 2–130 行，单条 20–40 分钟。**注意**：早期的"18/18 全冲突"是补丁文件被写成 CRLF 造成的假象，已修正 |
| 14 条只动 `shell/` | 增量 `ninja -C out\Rel electron`，**不重编 Chromium**，分钟级 |
| 2 条要动 `patches/chromium/*`（#54311 / #54090） | 要重打 Chromium 补丁集 → 小时级；**项目已在架构 §2 评过**，见 §7 |
| 没有任何脚本读 `kernel.patch` / `kernel.commit` | manifest 可以安全地加字段，不破坏打包门禁 |
| 应用侧代码改动 | **批次 1 为 0 行**；只有 API 类（clone / setBackgroundBlur）才要改 Vue/主进程 |

## 1. E39 与上游的逐块比对（决定真实难度）

**方法**：把每条上游补丁里每个 hunk 的「修复前代码块」（上下文 + 被删行）拿到 E39 源码里精确查找。找到 = E39 确实带着同一个缺陷、且可以照抄替换；找不到 = 目标代码在 E39 还不存在（多半是后续重构新增的），该 hunk 无效；只有锚点 = 缺陷在但写法漂移，要人工定位。

**口径更正（同日 10:00）**：早先"18 条全部无法 `git apply`"有误——我在 Windows 上用 PowerShell 重定向导出补丁，把行尾写成了 CRLF，导致 `git apply` 上下文匹配失败。归一化为 LF 后重判：**可直接应用 3 条**（#50688、#51900、#51562；前两条整条可应用，第三条只有 spec 冲突，`--exclude=spec/*` 可应用），其余 15 条仍冲突。这条教训也写进归档规则：**补丁文件必须是 LF**。

**结果**（`shell/` 下 71 个 hunk）：**32 个「原样存在」、22 个「有锚点但漂移」、17 个「找不到」**。

| 补丁 | 原样 | 漂移 | 缺失 | 判定 |
| --- | --- | --- | --- | --- |
| #50688 wrappable 延迟析构 | 5 | 0 | 0 | **最好移植**，整条照搬 |
| #51900 render-process-gone 顺序 | 2 | 0 | 0 | 整条照搬 |
| #51562 约束后不缩 | 1 | 0 | 0 | 整条照搬 |
| #53924 死渲染进程中的导航 | 8 | 3 | 2 | 主逻辑可照搬，头部 include 与新注释要人工对 |
| #49959 `clone()` | 0 | 2 | 1 | 新 API，需按 E39 的 `WebContents` 结构重写 |
| #51200 隐藏视图拖动区 | 0 | 1 | 0 | 目标函数在 E39 该文件 L84，2 行改动直接加 |
| #51076 `setBackgroundBlur` | 3 | 0 | 0 | 照搬（新 API，要补 d.ts 与前端） |
| #51287 全屏 inset | 0 | 1 | 0 | 需按 E39 的 `GetClientAreaInsets` 语义改写 |
| #51252 setResizable 稳定 bounds | 0 | 0 | 2 | E39 没有对应实现，**要么放弃要么整段补** |
| #51732 居中尺寸 | 2 | 1 | 1 | 部分可抄 |
| #51503 resize band | 1 | 4 | 2 | 以人工改写为主 |
| #50706 外部 resize 命中区 | 3 | 3 | 4 | 布局函数 `LogicalToWidgetBounds` 在 E39 不存在 → **成本最高** |
| #53031 detach 后设 bounds | 2 | 1 | 1 | 中等 |
| #55955 relay 重定向 | 2 | 3 | 0 | 中等，tearoff 强相关 |
| #52844 空白 WCV | 0 | 2 | 0 | 依赖 Chromium patch 侧语义，需连读 |
| #54311 / #54090 | 0 | 2 | 2 | **要动 `patches/chromium/*`**，另案 |

> **修正上一轮的排期**：我说"Windows 几何 7 条一批、都很小"是错的。按实际比对，**生命周期组（#50688/#51900/#53924/#51562）比几何组容易得多**；几何组里 #51252 在 E39 没有对应实现、#50706 依赖不存在的布局函数，属于"要么放弃要么重做"。#51200 虽然 0 个原样 hunk，但目标函数只有 2 行改动，仍是最划算的一条。

## 2. 运行时验证状态（不许含糊）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| #51200 的缺陷在 E39 存在 | ✅ **已实测复现** | 隐藏视图的拖动区返回 `HTCAPTION(2)` |
| 打上 #51200 后缺陷消失、可见时拖动不受影响 | ✅ **已实测验证** | `HTCLIENT(1)`；可见时仍 `HTCAPTION(2)`；补丁 [0003](0003-51200-hidden-view-drag-regions.patch) |
| #50688 退出时崩溃 | ✅ **已实测复现** | 退出码 `-2147483645` + `Invoke in DisallowJavascriptExecutionScope` |
| 打上 #50688 后正常退出 | ✅ **已实测验证** | 退出码 `0`；补丁 [0004](0004-50688-wrappable-deferred-destruction.patch) |
| #51900 render-process-gone 时序 | ❌ **撤回** | 5 种触发（含应用真实的"崩后重建新视图"）均不崩；E39 的 `RendererStartupHelper::InitializeProcess` 用 `emplace`，没有上游所说的 CHECK 路径——该崩溃属 v42/43 渲染启动数据重构引入的回归 |
| #51562 约束后缩水 | ❌ **不采用** | 真实症状只在 `frame:true + setMaximumSize`（401×301 → 386×264）；产品路径（frameless + `minWidth`）是 1181→1182 且不缩水；补丁依赖 E39 不存在的 `GetRestoredFrameBorderInsets()`，实测编译失败 |
| #53031 视图不在 Widget 里时 setBounds 不传给页面 | ✅ **已实测复现并修复** | 从未 attach 时 0×0；叠加层顺序下附着前也是 0×0。补丁 [0006](0006-53031-detached-view-bounds.patch)，改后分别为 400×300 / 360×240；已知缺口：removeChildView 后再 setBounds 仍 stale |
| #55955 换宿主时 relay 不重定向 | ❌ **不采用** | 缺陷真实（CreateForWebContents 已存在即跳过），但 E39 的消费者只有 webview / OSR / 下载对话框；getOwnerBrowserWindow() 走 native_lifecycle，观测不到 |
| 几何组（#51252/#50706/#51503/#51562/#51287） | ✅ **主因已用 0008 修掉** | 150% DPI 实测：有边框 inset 15×64、无边框 1×1、**全屏 inset 0×0**（#51287 症状不存在）；#51562 的约束换算只对有边框有效，不在产品路径。**#50706/#51503 是真差异**：E39 边缘可抓区约 3 物理像素，E44 为 5–7 像素且有窗口外命中带。详见 [geometry-inset-audit.md](../evidence/probes/2026-11-25-upstream-electron-probe/geometry-inset-audit.md) |
| #49959 `clone()` | ⚠️ **内核已装配，但产品不可用（应用接入已撤销）** | 内核侧实测通过（同进程、历史复制、接管 + reload 正常渲染，补丁 [0007](0007-49959-webcontents-clone.patch)）；但克隆体**拿不到 preload**（官方 E44 同样如此）→ Ruffle 不可用，且 PPAPI 同进程第二个实例无法实例化 → 本品没有适用标签类型。应用已回退，用例改为守住回退路径 |
| 其余 5 条 | ❌ 未验证 | 只有静态比对，没有运行时复现 |

复查过程与三个假设的逐条判定见 [batch1-recheck.md](../evidence/probes/2026-11-25-upstream-electron-probe/batch1-recheck.md)。

### #51200 的改前/改后对照（真实运行时，`WM_NCHITTEST`）

| 状态 | 改前 `5BB2274F` | 改后 `544E94FB` | 结论 |
| --- | --- | --- | --- |
| 无子视图 | `HTCLIENT(1)` | `HTCLIENT(1)` | 基线不变 |
| 子视图**隐藏** | **`HTCAPTION(2)`** | **`HTCLIENT(1)`** | 缺陷消失 |
| 子视图可见 | `HTCAPTION(2)` | `HTCAPTION(2)` | 无回归（可见就该能拖） |
| 再次隐藏 | **`HTCAPTION(2)`** | **`HTCLIENT(1)`** | 缺陷消失 |
| 销毁子视图 | `HTCLIENT(1)` | `HTCLIENT(1)` | 不变 |

复现方法：`frame:false` 窗口自身无拖动区，唯一拖动区来自子 `WebContentsView` 里的全屏 `-webkit-app-region:drag`；
对窗口发 `WM_NCHITTEST`，`HTCAPTION(2)` = 该点被当成标题栏。详见
[e39-drag-region-result.md](../evidence/probes/2026-11-25-upstream-electron-probe/e39-drag-region-result.md)。

**这条闭环同时确立了两件方法学结论**，后续 17 条按此执行：①"静态比对命中"只是必要条件，必须配一个改前/改后能给出不同数值的探针；
②E39 的类结构与 E44 不同（本例 `WebContentsView` 自身即 `views::View`），照抄上游会产生编译不过或语义错位的"假移植"。


## 3. 批次划分

> 批次顺序按 §1 的实测结果调整：**先做能整条照搬的生命周期组，再啃几何组**。

### 批次 1a · 生命周期与视图附着（4 条，整条可照搬）

落点：`shell/browser/api/electron_api_web_contents.{cc,h}`、`shell/common/gin_helper/wrappable*.{cc,h}`。

| # | PR / 提交 | 内容 | 为什么是我们 |
| --- | --- | --- | --- |
| 0010 ❌ | #51900 `571d6e9` | `render-process-gone` 改在进程死亡通知之后发出 | 我们在该事件里立刻 `rebuild()+load()`，同步导航会崩浏览器进程 |
| 0011 ⏸ | #53924 `57578d5` | 死渲染进程 teardown 期间发起的导航改为排队 | 同上（#51900 的后续，成对使用） |
| 0012 ✅ | #50688 `3f8238b` | `Wrappable` 的 `SecondWeakCallback` 延迟到 posted task 再析构 | 退出时崩溃；我们频繁建销视图（飞窗回收/标签休眠） |
| 0013 ❌ | #51562 `dea8837` | 应用约束后无边框窗口缩小 | **暂不应用**：E39 实测症状相反（变大 1–2 px，初始 401×301），inset 记账与 E44 不同，见 §2 |

### 批次 1b · Windows 窗口与视图几何（按难度重排）

| # | PR / 提交 | 原样命中 | 说明 |
| --- | --- | --- | --- |
| 0014 ✅ | #51200 `c74de25` | 0/1（函数在 L84） | **已完成并验证**，见 §2；E39 适配：`WebContentsView` 自身即 `views::View`，守卫写 `GetVisible()` 而非 `view()->GetVisible()` |
| 0015 ⏸ | #55955 `46980d7` | 2/5 | **暂不采用**：relay 缺陷真实存在，但 E39 的消费者只有 webview guest / OSR / 下载对话框，`getOwnerBrowserWindow()` 不读 relay → 观测不到差异 |
| 0016 ✅ | #53031 `96f3996` | 2/4 | **已落并装配**（0006）：从未 attach 时页面视口 0×0 → 正确尺寸；removeChildView 后再 setBounds 的缺口保留（产品不依赖该顺序） |
| 0017 | #51732 `d4d8a18` | 2/4 | `win.center()` 尺寸错位 —— 与 inset 同族，暂缓 |
| 0018 ❌ | #51287 `ccaab43` | 0/1 | **不采用**：实测全屏 `size = content = 屏幕`、inset `0×0`，E39 没有该缺陷 |
| 0019 🔜 | #51503 `efe652c` | 1/7 | 与 #50706 同族，依赖其边界重构 → 暂缓；缩放带主因已由 0008 覆盖 |
| 0020 ⏸ | #50706 `4203d76` | 3/10 | **暂缓**：依赖 `GetRestoredFrameBorderInsets`/`LogicalToWidgetBounds`/`has_thick_frame` 一整套边界重构；其"外部命中带"价值已被 0008 的缩放修正部分覆盖 |
| 0021 ✅ | 自研（非上游） | — | **DPI 感知的缩放带**：`kResizeInsideBoundsSize` 按设备缩放比换算，可抓区 3→8 物理像素。补丁 [0008](0008-frameless-resize-band-dpi.patch) |
| — | #51252 `38cfc66` | 0/2 | 不单独做：实测只是 ±1 px 漂移，`setResizable` 语义差异不影响无边框产品 |

### 批次 2 · 需要先有复现

| 项 | 提交 | 前置条件 |
| --- | --- | --- |
| 拖动区归属（只剩最前面的 WCV 参与） | #54936 `02b018c` | 先复现：飞窗盖住工具栏拖动区时点不动 |
| 后台渲染三件套 | #52844 `50dd963` / #54311 `2f22028` / #54090 `c348583` | 见 §7：**项目已有结论**，不要重复立项 |
| 空 WCV 与 `backgroundThrottling` | #52844 | 叠加层 `shell-overlays.ts:250` 是唯一 `backgroundThrottling:false` 的地方，需专门补一条"窗口隐藏时预热叠加层 → 显示后不空白"的用例 |

### 批次 3 · 新 API（要改应用代码）

| 项 | 提交 | 应用侧改动 |
| --- | --- | --- |
| `webContents.clone()` ❌ | #49959 `76a03e1` | **接入后撤销**：Ruffle 拿不到 preload（上游同）、PPAPI 无法同进程二次实例化 → 本品无适用场景。内核补丁保留待用；用例 `tab-duplicate-ruffle.test.cjs` 守住回退路径 |
| `view.setBackgroundBlur()` | #51076 `a1d6918` | 飞窗/面板视觉；无回归风险 |
| `setBounds` 动画 | 未定位（早于 2026-03） | 会与 `quick-settings.test.cjs:91-96/230` 的同步 bounds 断言冲突，采用前必须改测试 |

## 4. 单条移植流程

```powershell
$tree = 'D:\electron-build-142\cr\src\electron'
# 1) 读上游意图（原文在 docs/kernel/upstream/）
# 2) 在 E39 上手工改；也可先试探：
git -C $tree apply --reject D:\java_workspace\BaoFlashBrowserNext\docs\kernel\upstream\upstream-51200-hidden-view-drag-regions.patch
# 3) 增量编译（只重编 shell + 链接）
cd D:\electron-build-142\cr\src
$env:DEPOT_TOOLS_WIN_TOOLCHAIN='0'; $env:vs2022_install='C:\BuildTools'; $env:SCCACHE_SERVER_PORT='47999'
.\third_party\ninja\ninja.exe -C out\Rel electron
# 4) 导出我们自己的移植版补丁
git -C $tree diff > D:\java_workspace\BaoFlashBrowserNext\docs\kernel\0003-51200-hidden-view-drag.patch
# 5) 组装 dist 并刷新运行时
pwsh -NoProfile -File D:\electron-build-142\flashprobe\assemble-dist.ps1
cd D:\java_workspace\BaoFlashBrowserNext\app
npm run runtime:prepare -- 'D:\electron-build-142\dist'
npm run runtime:check
```

**每批一个构建标识**：批次 1a → `bao-v142-265-ppapi-sandbox+win-ppapi-process-sandbox+e39-lifecycle-1`；批次 1b → `…+e39-views-1`。补丁文件与 tag 一一对应，便于单条回退。

**移植示例：0014（#51200）**，上游是 2 行增量，插在 `WebContentsView::NonClientHitTest()` 开头：

```cpp
int WebContentsView::NonClientHitTest(const gfx::Point& point) {
  if (!view() || !view()->GetVisible())   // ← 新增
    return HTNOWHERE;                     // ← 新增
  if (api_web_contents_) { ... }
```

E39 里同名函数在 `shell/browser/api/electron_api_web_contents_view.cc` L84 附近；E39 没有 `view()` 访问器时按实际成员名（`view_`）调整。

**交付判据**：每条补丁除了编译通过，还要能回答"改前/改后同一探针的差异"。已经具备探针的是 #51200（见 §2）；其余条目在移植前先写 3–10 行的复现脚本，跑不出差异就不要合入——避免"看起来是修复，实际改的是别的东西"。

## 5. manifest 同步清单（`app/scripts/runtime-manifest.json`）

**必改**

| 字段 | 值 |
| --- | --- |
| `files[".runtime/win-x64/electron.exe"]` | 新构建的 SHA-256（大写） |

**建议改（纯记录，无消费者）**

| 字段 | 说明 |
| --- | --- |
| `kernel.tag` | 新构建标识；`runtime-check.cjs:33` 与 `pack-win.cjs:80` 会打印它 |
| `kernel.commit` | 内核树新提交 SHA |
| `kernel.patch` | 保持"最新一条"的语义，便于旧脚本阅读 |
| `kernel.patches` | **新增数组**，按顺序登记 `docs/kernel/0001…000N`；没有任何脚本读取它，纯增量 |
| `kernel.fallbackTag` | 设为上一个已验证 tag（当前是 `bao-v142-265-ppapi-sandbox+win-ppapi-process-sandbox`） |

**不动**：`files` 里的 `pepflashplayer64.dll` 与 `vendor/ruffle/*` 三项（本次不换插件与 Ruffle）。

**副作用**：`electron.exe` 哈希一变，其他机器早先 `runtime:export` 出的 zip 会被 `runtime:import` 拒绝（比对 `manifest.files`）——这是预期行为，需要重新导出。

参考片段：

```json
"kernel": {
  "tag": "bao-v142-265-ppapi-sandbox+win-ppapi-process-sandbox+e39-views-1",
  "commit": "<新的内核提交 sha>",
  "patch": "docs/kernel/0003-51200-hidden-view-drag.patch",
  "patches": [
    "docs/kernel/0001-ppapi-renderer-plugin-path-check.patch",
    "docs/kernel/0002-win-ppapi-process-sandbox.patch",
    "docs/kernel/0003-51200-hidden-view-drag.patch"
  ],
  "windowsPpapiProcessSandbox": true,
  "fallbackTag": "bao-v142-265-ppapi-sandbox+win-ppapi-process-sandbox",
  "记录": "docs/kernel/README.md"
}
```

## 6. 验收矩阵

| 范围 | 命令 / 动作 | 通过标准 |
| --- | --- | --- |
| 类型与单元 | `npm run typecheck`、`node scripts/test.cjs unit` | 无错、62/62 |
| 应用冒烟 | `node scripts/test.cjs smoke` | 30 通过 + 6 跳过、0 失败 |
| 前台专项 | `npm run smoke:foreground` | 最大化/全屏、指针锁、DevTools、Flash 均过 |
| 批次 1a 手工 | F11 进出全屏、拖边缘缩放、最小尺寸窗口、弹窗居中、隐藏飞窗后点工具栏拖动区 | 无白边、无误拖、bounds 稳定 |
| 批次 1b 手工 | 崩溃恢复、tearoff 拖到副屏、关窗口退出 | 无浏览器进程崩溃、无 UAF 日志 |
| 批次 3 手工 | 复制标签（历史保留、进程数不加）、飞窗毛玻璃 | 行为符合预期 |

## 7. 已有结论，别重复立项

架构 §2 已把 **#52844 / #54311 / #54090** 作为"后台渲染补丁"评估过：本地 HTML 6 轮 24 用例、5 轮全过，结论"暂缓 #52844，待实际 Flash 标签复测"。本次审计补两条事实：

1. 这三条不是纯 shell 修复：#54311 / #54090 改的是 `patches/chromium/allow_disabling_blink_scheduler_throttling_per_renderview.patch` 与 `disable_hidden.patch`，**要重打 Chromium 补丁集**——这是它们成本高于批次 1 的真正原因。
2. 当时的用例覆盖的是**页面视图**；`backgroundThrottling: false` 在我们代码里只有**叠加层**一处（`shell-overlays.ts:250`），且它创建时就隐藏。所以正确动作不是"重新立项挑 #52844"，而是**补一条叠加层用例**：窗口隐藏 → 预热叠加层 → 显示窗口 → 打开齿轮，断言叠加层不空白。用例不过再谈挑补丁。

## 8. 顺序与工作量

| 步骤 | 内容 | 估计 |
| --- | --- | --- |
| 0 ✅ | **#51200 改前/改后验证已完成**：+7 行 → 增量构建 352 s → 复跑命中值 → 冒烟 24 文件 / 47 通过 | 实测约 15 min |
| 1 | 批次 1a 四条移植 + 一次构建（整条可照搬，风险最低） | 1.5–2 h + 构建 |
| 2 | `smoke` + 前台专项回归 | 1 h |
| 3 | 批次 1b 前四条（#51200/#55955/#53031/#51732，先写探针再移植） | 3–4 h + 构建 |
| 4 | 涉 tearoff/crash 的手工回归 | 1 h |
| 5 | 更新 manifest、导出 runtime zip、写增量记录 | 30 min |
| 6 | 批次 3（clone / blur）另立项 | 与"复制标签/拖出窗口"语义一起定 |

## 9. 风险

- 全部为内核侧改动，**批次 1 应用代码 0 行改动**；回归失败点只可能在渲染/窗口层，定位范围小。
- 每条补丁独立成文件，`git revert` 单条即回退；`fallbackTag` 保留上一个已验证内核。
- #55955 触及"WebContents 换宿主"，与 tearoff 强相关，**没有跑过 `tearoff.test.cjs` 不得进批次 1b 的验收**。
- E39 与 E44 的 shell 代码漂移会让个别补丁"看起来能抄但抄不动"（例如 `view()` 访问器、`FrameView` 基类差异）。遇到这种情况按"收益不抵"放弃该条，不要为一个 20 行的修复重写结构。


## 10. 当前内核树与产物状态（2026-11-25 12:45）

| 对象 | 状态 |
| --- | --- |
| 内核树分支 | `bao/e39-batch4`：`a5693f61ab` #51200 → `08dac9259e` #50688 → `5faf91f967` #53031 → `c244a99d9c` #49959（无消费者）→ `353fb66eb0` 0008 缩放带 |
| `out\Rel\electron.exe` / `app\.runtime\win-x64` | `0A7C92A9…0D7B1DE3F`，tag `…+e39-batch4` |
| 备份 | `win-x64-before-e39-batch4`（batch3 exe）、`…batch3`（batch2 exe）、`…batch2`（batch1 全量）、`…batch1`（5BB2274F 全量） |
| 冒烟 | **57 用例 / 51 通过 / 0 失败 / 6 跳过**，173.6 s |
| 记录 | [batch1](../reports/2026-11-25-e39-backport-batch1.md) · [batch2](../reports/2026-11-25-e39-backport-batch2.md) · [batch3](../reports/2026-11-25-e39-backport-batch3.md) · [batch4](../reports/2026-11-25-e39-backport-batch4.md) |

**验证覆盖（2026-11-25 新增）**：

| 用例 | 作用 | 运行条件 |
| --- | --- | --- |
| `tab-duplicate-ruffle.test.cjs` | 复制 Ruffle 标签走回退路径的合同：独立进程 + 两个实例都出画布 | 常规冒烟 |
| `overlay-prewarm-hidden.test.cjs` | 预热叠加层 → 显示 → 不是空白（#52844 的闸门） | **仅前台**：`npm run smoke:foreground`（隐藏模式下预热被禁用，自动跳过） |

当前全量冒烟（隐藏模式）：**58 用例 / 51 通过 / 0 失败 / 7 跳过**。

前台验收（`npm run smoke:foreground --serial`）：**58 用例 / 58 通过 / 0 跳过**。
注意：该开关此前是坏的（`--foreground` 被脚本自己撤销），2026-11-25 才第一次真正跑起来，
记录见 [2026-11-25-foreground-smoke.md](../reports/2026-11-25-foreground-smoke.md)。

**剩余候选**：见 [patch-candidates.md](patch-candidates.md)（未采用补丁登记册，含"何时再看"的触发条件）。当前没有"值得做"的内核补丁；高优先项转为**验证覆盖**（叠加层空白用例、前台 Flash 验收、flake 治理）。
