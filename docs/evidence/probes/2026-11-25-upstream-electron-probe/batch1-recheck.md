# 未复现项复查：#51900 与 #51562

2026-11-25 · 起因：批次 1 里两条补丁"缺陷未复现"。需要分清三种可能——①探针写错、②自构建内核掩盖了问题、③缺陷本来就是 39 之后才引入的。

## 结论

| 补丁 | 三个假设的判定 | 处置 |
| --- | --- | --- |
| #51900 `render-process-gone` 时序 | ①探针错：**否**（5 种触发均不崩）②自构建掩盖：**否**（同一构建能暴露 #50688 的 CHECK）③高版本引入：**是**（E39 缺该路径，且它属于 v42/43 的渲染启动数据工作） | **撤回，不采用** |
| #51562 约束后缩水 | ①探针错：**是**（我最初只切 `setResizable`，真正触发是 min/max 尺寸约束）②自构建：**否**（缺陷真实存在）③高版本引入：**否**（E39 有未修复代码） | **不采用**：缺陷只在 `frame:true + setMaximumSize` 组合出现，产品不用；且补丁依赖 E39 不存在的 API |

## 一、#51900：为什么不是 E39 的问题

### 1. 探针有没有写错

在**未打补丁**的运行时 `5BB2274F` 上试了 5 种触发，全部存活（进程退出码 0、页面正常重载）：

| 变体 | 结果 |
| --- | --- |
| `render-process-gone` 里同步 `reload()` | survived |
| 里同步 `loadURL()` | survived |
| 连崩 8 次 + 每次同步 reload | survived（`cycles=8`） |
| 在 `WebContentsView` 里崩 + 同步 reload | survived，URL 恢复 |
| 崩后**同步新建 WebContentsView 并加载**（应用 `rebuild()` 的真实路径） | survived，新视图加载成功 |

上游回归测试只用了第一种；5 种都不崩，说明不是"触发条件没找对"这个量级的问题。

### 2. 是不是我们的自构建掩盖了它

不成立。同一次会话里，**同一份自构建内核**上 `#50688` 的 V8 `CHECK` 稳定崩出
`Fatal error in , line 0 / Invoke in DisallowJavascriptExecutionScope`（退出码 `-2147483645`）。
说明这套构建能暴露 `CHECK` 级致命错误。虽然我们的 `out/Rel/args.gn` 里 `dcheck_always_on = false`
（`DCHECK` 被编译掉），但上游描述的崩溃是 `CHECK`，不受该选项影响。

### 3. 是不是 39 之后才引入的

代码证据支持这一条：

- 上游补丁的注释原话：*"…trips a CHECK in extensions::RendererStartupHelper"*。
- E39（Chromium 142）的 `extensions/browser/renderer_startup_helper.cc` 里，`InitializeProcess()` 用
  `process_mojo_map_.emplace(process, …)`，`emplace` 幂等，**没有"二次创建即 CHECK"的断言**；
  该文件里的 `CHECK` 全是扩展 service worker / activation token 相关（L105/113/130/146），与本路径无关。
- Electron 的渲染进程启动数据（preload 字节码缓存、startup data 前移到导航之前）是 **v42/v43** 的
  性能工作（`#51792`，v43 release notes 明写 "sandboxed renderer startup data is pushed ahead of navigation
  instead of fetched via blocking IPC"）。`#51900` 提交于 2026-06，正处在那条演进线上。
- 结论：**该崩溃是启动数据重构引入的回归，E39 没有这条代码路径**，所以"打上补丁"在 E39 上既无缺陷可修，
  又把 `render-process-gone` 从同步改成异步（应用依赖该事件做 `rebuild()`），属于无证据的语义变更。

**处置**：撤回（`git reset` 到 `08dac9259e`）。上游原文保留在
[upstream/upstream-51900-render-process-gone-ordering.patch](../../kernel/upstream/upstream-51900-render-process-gone-ordering.patch) 作参考。

## 二、#51562：探针错了，但补丁仍然不该落

### 1. 探针错在哪

第一版只做了 `setResizable(false)` + 重新 `setBounds`。但补丁改的是
`NativeWindowViews::GetContentSizeConstraints()`——**min/max 尺寸约束**的换算，触发条件必须是
`setMinimumSize` / `setMaximumSize` / 构造参数 `minWidth/minHeight`。

### 2. 真实症状（150% DPI 屏）

| 场景 | 结果 |
| --- | --- |
| `frame:true` + `setMaximumSize(400,300)` + 重新应用 bounds | 401×301 → **386×264**（真缩水，−15×−37） |
| `frame:false` + `setMinimumSize(400,300)` + 重应用 | 401×301 → 402×302（+1 px） |
| **主窗口同款构造**（frameless + `minWidth:520 / minHeight:360`，与 `browser-window.ts:392-393` 一致） | 1181×761 → 1182×762；缩到最小 520×360 正常，**不缩水** |

缺陷在 E39 确实存在，但只在 `frame:true` + 最大尺寸约束这条组合上；我们的产品只用 **frameless + 最小尺寸**，
走的是 +1 px 那一档，无害且与补丁无关。

### 3. 移植成本

补丁依赖 `NativeWindowViews::GetRestoredFrameBorderInsets()`，**E39 没有这个方法**（实测编译失败：
`error: use of undeclared identifier 'GetRestoredFrameBorderInsets'`）。它是 #50809/#51252 那一族重构引入的。
要挑这条，得先用 E39 的 `FrameView::GetWindowBoundsForClientBounds` 之类自己造一个等价物，
而那样会改动目前无害的 ±1 px 记账——收益（产品路径本来不触发）不抵风险。

**处置**：不采用，与几何组（#51252 / #50706 / #51503）一起挂起，等真有 `setMaximumSize` 需求时再连同
inset 基础设施一次做对。

## 三、最终批次

| 补丁 | 提交 | 状态 |
| --- | --- | --- |
| #51200 隐藏视图拖动区 | `a5693f61ab` | ✅ 采用（探针：`HTCAPTION` → `HTCLIENT`，可见时不变） |
| #50688 Wrappable 延迟析构 | `08dac9259e` | ✅ 采用（探针：退出码 `-2147483645` → `0`） |
| #51900 render-process-gone 时序 | — | ❌ 撤回（未复现 + E39 无该路径） |
| #51562 约束后缩水 | — | ❌ 不采用（症状不在产品路径 + 依赖缺失 API） |

产物：`out\Rel\electron.exe` SHA-256 `7925BA9E67E84E85552AADAEFC4565C7685BB9A9BC02A43ADA44E1E342802597`。
回归：四个场景（crash-reload / crash-navigate / resizable-bounds / wrappable-gc）+ 应用冒烟
**24 文件 / 0 失败 / 57.1 s** 全部通过。

## 四、方法学补充

这次复查比跑通补丁更有价值，因为定下了两条判据：

1. **"未复现"必须先排除探针错误**：要按补丁**改的函数**去推导触发条件（这次 #51562 改的是约束换算，
   我一开始却只切了可调态），并至少覆盖 3 种变体。
2. **"未复现"不等于"补丁无用"，也不等于"补丁该落"**：要能区分三种成因，判定依据是**代码路径是否存在**
   （E39 无 `GetRestoredFrameBorderInsets`、无该 CHECK 路径），而不是"哪个版本修了它"。
