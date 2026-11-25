# 上游 Electron 修复回拣审计（E39 / Chromium 142）

2026-11-25 · 对象：官方 Electron 43 / 44 相对我们基线 **39.8.10（Chromium 142.0.7444.265）** 的差异。
目的：在不升级 Chromium 的前提下，判断哪些上游 Electron 修复/API 值得回拣进自编译内核。

- 基线状态：`39.8.10` 是 **39 线最后一个版本**，39.x 已于 2026-05 结束支持（[v39.8.10](https://releases.electronjs.org/release/v39.8.10)）。**不存在"升级小版本白捡"的路径**，想要就得回拣。
- 级别说明：**A = 直接回拣**（纯修复、应用侧零改动）/ **B = 回拣 + 应用侧配合** / **C = 先测再定** / **D = 不回拣**。
- 难度是【推断】：本机无法直连 GitHub 取 diff，判断依据为 PR 标题/描述、落点文件域与发布版本。

## 0. 修订（同日，取得上游真实提交后）

本文 A/B/C 表里的部分编号是**回拣分支号**（只存在于 40/41/42 分支，主线上没有）。已用镜像仓 `gitee.com/mirrors/electron` 核对主线提交，结果：

| 本文原编号 | 主线补丁 | 提交 | 说明 |
| --- | --- | --- | --- |
| #51918 | **#51900** | `571d6e9` | `render-process-gone` 改为进程死亡通知之后发出 |
| #51954 | **#51562** | `dea8837` | 应用约束后无边框窗口缩小 |
| #51920 | **#51732** | `d4d8a18` | `win.center()` 让无边框窗口尺寸错位 |
| #52863 | **#52844** | `50dd963` | `setBackgroundThrottling(false)` 后窗口显示时 WCV 空白 |
| #48812 | **#51076**（仅 setBackgroundBlur 部分） | `a1d6918` | `setBounds` 动画的提交早于镜像可检索范围，待查 |
| #55819 | **#54936** | `02b018c` | 只让最前面的 WCV 参与拖动区命中测试 |
| #49425 `focusOnNavigation` | 未定位 | — | 早于镜像 `--shallow-since` 范围，需完整历史 |
| #52021 `MoveBehindTaskBarIfNeeded` | 未定位 | — | 关键词未命中，可能在 Chromium 侧 |

按文件域扫描时新增了 6 条本文初版没列、但相关性很高的修复：`#53031`（给已 detach 的 WCV 设 bounds）、`#55955`（WebContents 换宿主时重定向 NativeWindowRelay，**正是 tearoff 路径**）、`#53924`（死渲染进程 teardown 期间发起导航）、`#50706`（外部 resize 命中区）、`#51503`（resize band 缩放）、`#50688` 的同伴 `#3f8238b`。

另外**已归档实测结论**：18 条上游原文全部位于 [`docs/kernel/upstream/`](../kernel/upstream/README.md)，**没有一条能直接 `git apply` 到 `v39.8.10`**（`--check` 与 `--check -C1` 均失败），因此执行侧一律按"手工移植"排期，见 [E39 回拣实施计划](../kernel/2026-11-25-e39-backport-plan.md)。

**与既有结论的交叉**：`#52844` / `#54311` / `#54090` 就是架构 §2 的"后台渲染补丁"三件套，项目已跑过 6 轮 24 用例并决定暂缓。本文原 A 组把 `#52863` 当"新发现"是错的——正确动作是**补一条叠加层用例**（`backgroundThrottling: false` 只在 `shell-overlays.ts:250` 一处），用例不过再谈挑补丁。

**两件后续已补做的事**（2026-11-25 同日）：

1. **逐块比对了 E39 与上游**：把 18 条补丁的每个 hunk「修复前代码块」拿到 E39 源码里精确查找，`shell/` 下 71 个 hunk 结果为 **32 原样存在 / 22 有锚点但漂移 / 17 找不到**。原先"Windows 几何 7 条都容易"的排期被推翻——生命周期组反而最容易，`#51252`/`#50706` 在 E39 缺对应实现。表见[实施计划 §1](../kernel/2026-11-25-e39-backport-plan.md#1-e39-与上游的逐块比对决定真实难度)。
2. **在当前运行时复现了 `#51200` 的缺陷**：`frame:false` 窗口 + 隐藏的 WCV（唯一拖动区）→ `WM_NCHITTEST` 返回 `HTCAPTION(2)`；无视图或视图可见时分别为 `HTCLIENT(1)`/`HTCAPTION(2)`。即缺陷存在且成因就是"可见性未参与判定"。**但修复后效果未验证**（未构建打过补丁的内核）。记录见 [e39-drag-region-result.md](../evidence/probes/2026-11-25-upstream-electron-probe/e39-drag-region-result.md)。

## 1. 实测（官方 Electron 44.11.6 / Chromium 152，探针见 `docs/evidence/probes/2026-11-25-upstream-electron-probe/`）

| 结论 | 数据 |
| --- | --- |
| 每个 `WebContentsView` 仍独占一个渲染进程，**同站也不合并** | 4 视图 → 4 进程（`probe://a.local` 开两个视图得到两个不同 pid） |
| 空页面渲染进程成本 | **69–72 MB** workingSet（2000 段文本页 89 MB） |
| 没有常驻的 spare renderer | 建视图未加载时 `rendererCount = 0` |
| **`webContents.clone()` 复用源渲染进程** | clone 后 `rendererCount` 仍为 1、总分 291 → **291 MB（+0）**、pid 相同、导航历史 2 条完整复制 |
| clone 跨站后分家 | 克隆体导航到别的站点 → 新进程（82 MB），源留在原进程；关源不影响克隆体 |
| `Page.setWebLifecycleState('frozen')` 可用 | 冻结成功；**冻结后 `executeJavaScript` 3 秒不返回**（确认会挂死） |
| 44 具备、39 不具备的 API | `webContents.clone()`、`view.setBackgroundBlur()`、`view.setBounds(bounds, { animate })`、`webPreferences.focusOnNavigation`（39.8.10 的 `electron.d.ts` 里均 MISS） |

> **修正上一轮结论**：之前我说 `clone()` 只复制状态、不共享进程——**实测推翻**。至少在 clone 的初始文档与源同站时，它跑在源的渲染进程里，增量内存为 0。
> **方案已否定（2026-11-25）**：clone 复用源渲染进程这一点与本项目两条硬约束正面冲突——① Flash（PPAPI）按单实例运行，克隆体与源同进程 = 双 Flash 实例互踩；② Ruffle 靠按页面会话注入（`bindRuffleProtocol`），共享进程破坏注入的会话归属与时序假设。「零进程成本」对 Flash 浏览器是语义破坏，不是优化项。不再作为 duplicateTab / tearoff 的实现路径。

## 2. 清单

### A —— 直接回拣（纯修复，应用侧 0 行改动）

| # | PR | 内容 | 为何相关 |
| --- | --- | --- | --- |
| 1 | [#51200](https://github.com/electron/electron/pull/51200)（回拣 [#51245](https://github.com/electron/electron/pull/51245)/#51246/#51221） | 隐藏的 `WebContentsView` 里 `app-region: drag` 仍会拖动父窗口（Windows）。修法是"视图不可见时命中测试直接返回 `HTNOWHERE`" | 我们的飞窗就是**隐藏的 WCV**，且外壳顶部是拖动区 |
| 2 | [#51287](https://github.com/electron/electron/pull/51287) | 无边框窗口全屏时出现白边（Windows） | F11 全屏 + frameless 是主路径 |
| 3 | [#51252](https://github.com/electron/electron/pull/51252) | `setResizable` 后无边框窗口尺寸变化（Windows） | 同上 |
| 4 | [#51920](https://github.com/electron/electron/pull/51920) | `win.center()` 导致无边框窗口缩小（Windows） | 弹窗居中定位在用 |
| 5 | [#52021](https://github.com/electron/electron/pull/52021) | `MoveBehindTaskBarIfNeeded()` 的 Windows 边界情况 | 拖出标签落在工作区边缘时 |
| 6 | [#51918](https://github.com/electron/electron/pull/51918) | 在 `render-process-gone` 里同步 `reload`/导航导致**浏览器进程崩溃**（事件改为 teardown 之后再发） | 我们崩溃后正是 `rebuild() + load()` |
| 7 | [#50688](https://github.com/electron/electron/pull/50688) | 退出时 WebContents 被 GC 触发 `DisallowJavascriptExecutionScope` 崩溃 | 频繁创建/销毁视图（飞窗回收、标签休眠） |
| 8 | [#52863](https://github.com/electron/electron/pull/52863) | 窗口隐藏期间调用 `setBackgroundThrottling(false)`，窗口显示后 **WCV 保持空白** | **直接命中我们的叠加层**：`shell-overlays.ts` 创建时就 `backgroundThrottling: false` 且视图先隐藏 |

### B —— 回拣 + 应用侧配合

| # | PR | 内容 | 应用侧改动 |
| --- | --- | --- | --- |
| 9 | [#49425](https://github.com/electron/electron/pull/49425)（#49512/#49511） | `webPreferences.focusOnNavigation`，关掉导航自动抢焦点 | `createPageView`/`createInternalView` 加参数；`focusContents()` 的手工闸门可简化。**焦点合同是手写的，回归面涉及 `input.test`/`quick-settings.test`** |
| 10 | [#48812](https://github.com/electron/electron/pull/48812) | `view.setBounds(bounds, { animate })` + `view.setBackgroundBlur` | 三处调用点；**`quick-settings.test.cjs:91-96/230` 同步断言 bounds，动画化必须改测试** |
| 11 | [#49959](https://github.com/electron/electron/pull/49959) | `webContents.clone()` | `duplicateTab()`（换 clone 后复制标签**不新增进程**、且保留前进/后退）、`undo-close` 的 `getAllEntries()/restore()` 可退役、tearoff 预览 |

### C —— 先测再定

| # | PR | 内容 | 待测点 |
| --- | --- | --- | --- |
| 12 | [#51964](https://github.com/electron/electron/pull/51964) | 挂 `webContents.debugger` 时 DevTools Network 面板丢请求 | M3 的 CDP 消费者会同时用 debugger；先确认我们的自动化路径是否受影响 |
| 13 | [#55819](https://github.com/electron/electron/pull/55819) | 只让**最前面**的 WCV 参与拖动区命中测试（当前是任一层命中即算标题栏） | 先复现：飞窗盖住工具栏拖动区时能否点击。该 PR 为 2026-11-17 新提交，**是否合入/进了哪条线未确认** |
| 14 | [#53764](https://github.com/electron/electron/pull/53764) | 睡眠唤醒后误报 `unresponsive`、隐藏时误报 `responsive` | 我们还没做 unresponsive UI，暂不急采用 |

### D —— 不回拣

| 项 | 理由 |
| --- | --- |
| macOS 专属（#50712/#50715/#50713 多视图 visibility 等） | 只支持 Windows |
| Linux 专属（#51999 顶部 1px、圆角默认值等） | 同上 |
| OSR / Notification / printing / WebAuthn / safeStorage | 与产品无关 |
| [#51792](https://github.com/electron/electron/pull/51792) 启动性能（V8 字节码缓存 + 启动快照 + 渲染启动数据前置） | 多提交、跨构建管线，回拣成本远超收益 |
| Chromium 层修复（如 `file://`/自定义 scheme 的 V8 code cache） | 要动 `cr/src`，从分钟级变小时级；收益要在实测证实后才谈 |

## 3. 影响面

| 层 | 改动 | 成本 |
| --- | --- | --- |
| 内核树 `D:\electron-build-142\cr\src\electron` | 每条 PR 一个 `git cherry-pick <sha>`，导出为 `docs/kernel/000N-*.patch` | **增量构建**（只重编 shell 若干 TU + 链接），分钟级；不是 200 min 全量 |
| 内核树 `cr/src`（Chromium 子树） | A/B 组都不需要；只有 D 组里 Chromium 层修复需要 | 小时级，暂不碰 |
| 账目 | 新 patch 文件 + 构建标识（如 `bao-v142-265-ppapi-sandbox+e39-fixes-1`）+ `out/Rel/electron.exe` SHA-256 + `scripts/runtime-manifest.json` | 每次重建 30 min（组装 + `runtime:prepare` + `runtime:check`） |
| 应用代码 | A 组：**0 行**；B 组：见上表（#49425 中、#48812 中、#49959 中） | — |
| 测试 | A 组跑一遍 `node scripts/test.cjs smoke` 即可；B 组要补/改用例（焦点、bounds、复制标签） | A 组 < 1 h，B 组 0.5–1 d |

**冲突概率**：A 组 8 条里 7 条落在 `shell/browser/ui/views/win_*` 与 `shell/browser/native_window_views.cc`，1 条落在 `shell/browser/api/electron_api_web_contents.cc`，互不重叠，适合作为**一批**挑。E39 与 E43 的 shell 代码有漂移，cherry-pick 冲突属正常，冲突大就放弃该条。

## 4. 建议顺序

1. **先做开关实验（0 风险，1 天）**：`--process-per-site`、`--renderer-process-limit=N` 各跑一组标签内存对照。它们决定"内存问题要不要动内核"，优先级高于任何回拣。
2. **批次 1（A 组 8 条，1 天 + 1 次重建）**：全部纯修复，应用侧零改动，回退粒度是单条 patch。
3. **批次 2（#49425 focusOnNavigation）**：要动焦点合同，单独一批，单独回归。
4. **单独立项**：#55819（先复现）、#51964（随 M3 CDP）。~~#49959 clone~~（已否定，见第 2 节修正：与 Flash 单实例、Ruffle 注入冲突）。

## 5. 回退

与 0001/0002 相同的做法：单条 `git revert` / 回到构建 tag；应用侧无耦合，A 组回退不需要改任何 TypeScript。
