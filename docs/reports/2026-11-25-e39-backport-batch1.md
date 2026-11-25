# 内核增量：E39 回拣批次 1（#51200 + #50688）

2026-11-25 · 对应 [E39 回拣实施计划](../kernel/2026-11-25-e39-backport-plan.md)。
范围：**只做内核侧两条修复**，应用代码 0 行改动；同时把"未复现/症状不符"的两条补丁挡在批次外。

## 1. 批次内容

| 补丁 | 上游 | 提交 | 改动 | 为什么落 |
| --- | --- | --- | --- | --- |
| [`0003-51200-hidden-view-drag-regions.patch`](../kernel/0003-51200-hidden-view-drag-regions.patch) | #51200 `c74de25` | `a5693f61ab` | `WebContentsView::NonClientHitTest()` 加可见性守卫（+7 行） | 隐藏的 WCV（飞窗）仍把拖动区贡献给父窗口，实测可复现 |
| [`0004-50688-wrappable-deferred-destruction.patch`](../kernel/0004-50688-wrappable-deferred-destruction.patch) | #50688 `3f8238b` | `08dac9259e` | `Wrappable` 的 `SecondWeakCallback` 改为 posted task（整条上游补丁） | 退出时 `Invoke in DisallowJavascriptExecutionScope` 崩溃，实测可复现 |

E39 适配点：#51200 上游用 `view()->GetVisible()`，E39 的 `WebContentsView` 自身就是 `views::View`，改用 `GetVisible()`。

## 2. 改前/改后

| 场景 | 改前 `5BB2274F` | 改后 `7925BA9E` |
| --- | --- | --- |
| 隐藏 WCV 的拖动区 `WM_NCHITTEST` | `HTCAPTION(2)`（缺陷） | **`HTCLIENT(1)`** |
| 可见 WCV 的拖动区 | `HTCAPTION(2)` | `HTCAPTION(2)`（无回归） |
| 泄漏 20 个 `WebContentsView` 后退出 | 退出码 `-2147483645`，`Fatal error … Invoke in DisallowJavascriptExecutionScope` | **退出码 `0`** |
| 无子视图 / 销毁视图后的命中测试 | `HTCLIENT(1)` | `HTCLIENT(1)` |

## 3. 被挡在批次外的两条

| 补丁 | 判定 |
| --- | --- |
| #51900 `render-process-gone` 时序 | **撤回**：5 种触发（含应用真实的"崩后重建新视图"）均不崩；E39 的 `RendererStartupHelper::InitializeProcess()` 用 `emplace`，没有上游所说的 CHECK 路径——属 v42/43 渲染启动数据重构引入的回归 |
| #51562 约束后缩水 | **不采用**：真实症状只在 `frame:true + setMaximumSize`；产品路径（frameless + `minWidth/minHeight`）是 1181→1182 且不缩水；补丁依赖 E39 不存在的 `GetRestoredFrameBorderInsets()`，实测编译失败 |

判定过程见 [batch1-recheck.md](../evidence/probes/2026-11-25-upstream-electron-probe/batch1-recheck.md)。

## 4. 构建与账目

| 项 | 值 |
| --- | --- |
| 内核树分支 | `bao/e39-batch1`：`a5693f61ab` → `08dac9259e` |
| 构建 | 增量 `ninja -C out\Rel electron`；#50688 那批 105 步 326 s，收口后 2 步完成 |
| 产物 | `out\Rel\electron.exe` SHA-256 `7925BA9E67E84E85552AADAEFC4565C7685BB9A9BC02A43ADA44E1E342802597` |
| 装配 | `assemble-dist.ps1` → `npm run runtime:prepare -- D:\electron-build-142\dist` |
| 运行时备份 | 旧内核整体移到 `.runtime/win-x64-before-e39-batch1`（`5BB2274F…`）；临时验证目录 `win-x64-patched-51200` 已删除 |
| 新 tag | `bao-v142-265-ppapi-sandbox+win-ppapi-process-sandbox+e39-batch1` |
| manifest | `electron.exe` 哈希 + `kernel.tag` / `patch` / **`patches`（新增数组）** / `electronCommits`（新增）/ `fallbackTag` |

## 5. 验证

| 命令 / 动作 | 结果 |
| --- | --- |
| `npm run runtime:check` | ✅ 内核匹配（新 tag）、PPAPI 插件匹配 |
| 拖动探针（对**已装配的**运行时） | ✅ `hidden` = `HTCLIENT`，`visible` = `HTCAPTION` |
| 退出崩溃探针 | ✅ 退出码 `0` |
| `node scripts/test.cjs smoke --serial`（对已装配运行时） | ✅ **56 用例 / 50 通过 / 0 失败 / 6 跳过**，180.5 s |
| 原生 Flash 路径 | ✅ 本次**实际执行并通过**：`本地 PPAPI 样本…注册插件并保留 JS 桥`、`键盘事件进入 PPAPI 插件进程`。原因：manifest 里的 exe 哈希与内核 tag 匹配后，`appNativeFlashSkip()` 不再跳过（此前用镜像 exe 时哈希不符，这两条被跳过） |
| 跳过项（6 条） | 全是前台专用：F11 全屏、pointerLock 权限、Ruffle 画布焦点、DevTools、最大化视图调整、双击标题栏最大化 |
| `npm run smoke:foreground` | ⬜ 仍未跑；上面 6 条需要真实窗口与焦点 |

## 6. 未做 / 下一步

| 项 | 说明 |
| --- | --- |
| 前台 Flash 验证 | 需要真实窗口与焦点，跑 `npm run smoke:foreground` |
| 批次 2 | #53031（detach 后设 bounds）、#55955（换宿主 relay）——tearoff 路径，先写探针 |
| 几何组 | #51252 / #50706 / #51503 / #51562 共享同一套 E39 缺失的 inset 基础设施，先做归属调查再决定 |
| API 类 | `clone()` / `setBackgroundBlur` / `focusOnNavigation` 各自独立立项，必须"内核 + 应用 + 用例"一起提交 |

## 7. 回退

```powershell
# 内核树
git -C D:\electron-build-142\cr\src\electron checkout 4f2650f6a0
# 运行时（不重建的快速路径）
Move-Item .runtime\win-x64 .runtime\win-x64-e39-batch1-tmp
Move-Item .runtime\win-x64-before-e39-batch1 .runtime\win-x64
# manifest 把 electron.exe 哈希与 kernel.tag 改回 fallbackTag 的值
```
