# 内核补丁候选登记册（未采用 / 待定）

2026-11-25 起维护。**已采用**的补丁见 [`README.md`](README.md) 的"上游回拣"表；本册只登记**看过但因故没落**的那些，以及**还没调研**的候选。

## 0. 怎么用

1. **先查本册**：遇到窗口/视图/生命周期类问题，先按关键词在下表里找，别重新调研。
2. **每条都写了"何时再看"**：只有满足那个条件才值得重新评估；否则按已否决处理。
3. **登记格式**（新增候选时照抄）：

```
### #<PR> <一句话>
- 上游：PR / 提交 / 改动文件与行数 / 归档路径
- 改什么：
- 判定：⛔ 已否决 | ⏸ 待前置条件 | 🔜 随里程碑
- 依据：<证据文件>（实测数据 / 代码查证 / 官方对照）
- 何时再看：<具体触发条件>
```

4. **状态含义**：⛔ 有实证结论，不要再试；⏸ 缺前置条件，条件满足可直接捡起；🔜 有明确归属的里程碑。

## 1. 目录

| 状态 | 补丁 | PR | 提交 | 一句话 | 何时再看 |
| --- | --- | --- | --- | --- | --- |
| ⛔ | render-process-gone 时序 | #51900 | `571d6e9` | 事件改到进程死亡通知之后发 | 真出现"崩溃重建时浏览器进程崩" |
| ⏸ | 死渲染进程期间的导航排队 | #53924 | `57578d5` | #51900 的配套 | 同上 |
| ⛔ | 全屏 inset / 白边 | #51287 | `ccaab43` | 全屏窗口残留非客户区 | 除非换 DPI/多屏后复现白边 |
| ⛔ | setResizable 稳定 bounds | #51252 | `38cfc66` | 切可调态后尺寸漂移 | 除非产品用有边框窗口 |
| ⛔ | 约束后缩水 | #51562 | `dea8837` | min/max 约束漏 frame inset | 除非用 `setMaximumSize` + 有边框 |
| ⏸ | win.center() 尺寸 | #51732 | `d4d8a18` | 无边框窗口居中后尺寸错 | 有人反馈"弹窗居中后变小" |
| ⏸ | 外部缩放命中带 | #50706 | `4203d76` | 客户端区缩进，命中带放到窗口外 | 有人反馈"贴边抓不住" |
| ⏸ | 缩放带定位/缩放 | #51503 | `efe652c` | #50706 的打磨 | 随 #50706 |
| ⏸ | 拖动区只归最前视图 | #54936 | `02b018c` | 叠放视图的拖动区互抢 | 复现"飞窗盖住拖动区点不动" |
| ⏸ | 后台渲染三件套 | #52844 / #54311 / #54090 | `50dd963` / `2f22028` / `c348583` | 隐藏页/WCV 的节流与停帧 | 叠加层空白用例挂掉时 |
| ⏸ | DevTools 丢请求 | #51964 | `8f5bef3` | 挂 debugger 时 Network 面板丢请求 | M3 自动化立项时 |
| ⏸ | `view.setBackgroundBlur` | #51076 | `a1d6918` | 视图毛玻璃背景 | 要做 Acrylic 视觉时 |
| ⏸ | `focusOnNavigation` | #49425 | 待定位 | 导航后不抢焦点 | 出现焦点被抢的 bug |
| ⏸ | `setBounds` 动画 | #48812 | 待定位 | 视图尺寸动画 | 飞窗要做展开/收起动效 |
| ⛔ | `webContents.clone()` | #49959 | `76a03e1` | 复制 WebContents 并复用渲染进程 | 上游让 preload 跟随 clone，或 Ruffle 改免 preload 注入 |
| ⛔ | 换宿主时 relay 重定向 | #55955 | `46980d7` | WebContents 换窗口后 relay 指向新窗口 | 用上 webview / OSR / 下载 |
| 🔜 | 未响应判定（睡眠/隐藏） | #53764 | 待定位 | 唤醒后误报 unresponsive | 做 unresponsive UI 时 |

> 归档的上游原文在 [`upstream/`](upstream/README.md)（18 条，全部为 LF 行尾，可直接 `git apply --check` 试）。

## 2. 逐条卡片（按"最可能再被问起"排序）

### #51900 `render-process-gone` 时序 —— ⛔ 已否决

- 上游：`571d6e9`（2026-06-08），`shell/browser/api/electron_api_web_contents.{cc,h}`，+33/−2。原文 [upstream-51900](upstream/upstream-51900-render-process-gone-ordering.patch)。
- 改什么：把 `render-process-gone` 的发出从"进程死亡通知循环内"改成 `PostTask` 异步。
- 判定依据：5 种触发（同步 `reload` / `loadURL` / 连崩 8 次 / WCV 内崩 / 崩后同步新建视图）在 E39 上**全部存活**；E39 的 `RendererStartupHelper::InitializeProcess()` 用 `emplace`，**没有上游所说的 CHECK 路径**；该 CHECK 属 v42/43 渲染启动数据重构引入的回归。
- 证据：[batch1-recheck.md](../evidence/probes/2026-11-25-upstream-electron-probe/batch1-recheck.md)。
- 何时再看：真实出现"渲染进程崩溃后重建时，浏览器进程直接死掉"。

### #50706 + #51503 外部缩放命中带 —— ⏸ 待前置条件

- 上游：`4203d76`（+79/−35，6 文件）、`efe652c`（+27/−9，5 文件）。原文 [upstream-50706](upstream/upstream-50706-external-resize-hit-targets.patch)。
- 改什么：`GetClientAreaInsets` 让无边框窗口的客户端区向内缩进，从而把左右/下边的缩放命中带放到窗口**外**；配套改 `GetNormalBounds` / `LogicalToWidgetBounds` / `WidgetToLogicalBounds`。
- 判定依据：**缺基础设施**——`GetRestoredFrameBorderInsets`、`LogicalToWidgetBounds`、`WidgetToLogicalBounds`、`has_thick_frame` 在 E39 全都没有（`Select-String` 命中 0）；同族 #50809/#51252 才是它们的来源。多次 `git apply` 试验：7 文件可应用 4 个，其余是命中带计算主体。
- 已覆盖的部分：**"抓不住"的主因是缩放丢失**，已用自研补丁 [0008](0008-frameless-resize-band-dpi.patch) 修掉（150% DPI 下可抓区 3–4 → 8 物理像素）。
- 证据：[geometry-inset-audit.md](../evidence/probes/2026-11-25-upstream-electron-probe/geometry-inset-audit.md)。
- 何时再看：有人反馈"光标在窗口边缘外一点也要能拉"；或将来做多屏/高 DPI 专项时，连同 #50809/#51252 一起整批上。

### #52844 / #54311 / #54090 后台渲染三件套 —— ⏸ 待前置条件

- 上游：`50dd963`（空白 WCV）、`2f22028`（隐藏页复渲染）、`c348583`（隐藏窗口导航后停帧）。**#54311/#54090 要改 `patches/chromium/*`，必须重打 Chromium 补丁集。**
- 判定依据：架构 §2 已评估——本地 HTML 6 轮 24 用例、5 轮全过，结论"暂缓 #52844，待实际 Flash 标签复测"。当时覆盖的是**页面视图**，没覆盖**叠加层**。
- **已建的闸门**：`app/tests/smoke/overlay-prewarm-hidden.test.cjs` —— 预热叠加层 → 显示 → 断言 `.quick` 有尺寸且文案是快捷设置。
  它在**隐藏模式下自动跳过**（预热在自动化模式被 `canPrewarm()` 主动禁用，避免干扰"页面视图计数"断言），
  所以实际运行命令是 `npm run smoke:foreground`。2026-11-25 实测：前台通过，当前**没有**空白缺陷。
- 何时再看：上面那条用例在**前台**跑挂时，先按 #52844 定位，再决定是否值得重打 Chromium patch 集。

### #54936 拖动区只归最前视图 —— ⏸ 待复现

- 上游：`02b018c`（+114/−8），`electron_api_web_contents_view.cc` + `draggable_region_provider.h` + `native_window.cc`。
- 改什么：窗口的拖动区命中测试只问**最前面**那个 WCV，避免叠放的视图互相抢。
- 判定依据：静态比对 2/6 命中、`apply` 冲突；**没有复现用例**（需要"飞窗盖住工具栏拖动区时点不动"的现象）。
- 何时再看：用户反馈"飞窗打开后，它盖住的那块工具栏拖不动窗口/点不动"。

### #51964 DevTools 丢请求 —— ⏸ 随 M3

- 上游：`8f5bef3`（2026-06-12），`fix: devTools network events dropped on RenderFrameHost swap`。
- 影响面：只有"自己挂 `webContents.debugger` 的同时用 DevTools"才丢请求（普通用户无感）。
- 何时再看：M3 的 CDP 自动化与 DevTools 共存时。

### #51076 `view.setBackgroundBlur` —— ⏸ 低优先（视觉）

- 上游：`a1d6918`（2026-05-01），新增 API（3 文件可直接 apply）。
- 价值：飞窗/面板的毛玻璃底。纯视觉，当前圆角+1px 描边已对齐 Chromium 菜单观感。
- 何时再看：要上 Acrylic/Mica 风格时。

### #49425 `focusOnNavigation` —— ⏸ 待 bug

- 上游：`#49425`（40/41/42 有回拣），本仓未归档（早于镜像 `--shallow-since` 范围）。
- 价值：关闭"导航后自动把焦点交给 WebContents"。
- 现状：我们的焦点是手写的（`focusContents()` + NTP 主动聚焦地址栏 + "后台窗口不抢前台"闸门），没观察到需要它的场景。
- 何时再看：出现"导航后焦点莫名跳到页面/表单"的 bug。

### #49959 `webContents.clone()` —— ⛔ 已否决（内核保留）

- 上游：`76a03e1`（2026-04-22）。我们已移植：[0007](0007-49959-webcontents-clone.patch)（44 行），**已装进内核但无消费者**。
- 判定依据（两条硬约束）：
  1. 克隆体**拿不到页面 preload** → Ruffle 不注入（官方 E44 实测同样 `preload=missing`，属上游行为）；
  2. 克隆体与源**共享渲染进程** → 同进程第二个 PPAPI 实例无法实例化（`<embed>` 退化成普通元素）。
- 本产品每个页面标签必属其一，故 clone **没有适用场景**；应用侧接入已撤销。
- 证据：[batch3-clone.md](../evidence/probes/2026-11-25-upstream-electron-probe/batch3-clone.md)。
- 何时再看：上游让 preload 跟随 clone；或我们把 Ruffle 注入改成不依赖 preload（例如主进程 `executeJavaScript` 注入主世界）。

### #55955 换宿主时 relay 重定向 —— ⛔ 已否决

- 上游：`46980d7`（2026-11-20）。缺陷真实（`WebContentsUserData::CreateForWebContents` 已存在即静默跳过），但 E39 的消费者只有 webview guest、OSR 尺寸、下载对话框父窗口；`getOwnerBrowserWindow()` 走 `native_lifecycle`，公开 API 观测不到。
- 何时再看：真的用上 webview / OSR / 下载 / 独立 DevTools 窗口。

### #51287 / #51252 / #51562 有边框窗口几何 —— ⛔

- 判定依据（150% DPI 实测）：**全屏 `size = content = 屏幕`、inset `0×0`**（#51287 无缺陷）；有边框窗口 inset `15×64`、无边框仅 `1×1`（#51562 的约束换算只影响有边框，产品不用）；`setResizable` 只是 ±1 px 漂移（#51252）。
- 证据：[geometry-inset-audit.md](../evidence/probes/2026-11-25-upstream-electron-probe/geometry-inset-audit.md)。
- 何时再看：产品要做有边框窗口，或引入 `setMaximumSize` 场景。

## 3. 未归档但见过的候选（需要时再去取）

这些只在 release notes 里见过，**没有下载、没有判定**；E39 上是否适用未知。取补丁的方式：镜像 `gitee.com/mirrors/electron` 上 `git log --grep="#<PR>"`（本仓 `docs/kernel/upstream/README.md` 记了完整命令）。

| PR | 内容 | 为什么可能有用 |
| --- | --- | --- |
| #48812 | `view.setBounds(..., { animate })` + `setBackgroundBlur`（拆分见 #51076） | 飞窗动效 |
| #54990 | 全屏事件上报新状态（Windows） | 若 F11 状态机出现不同步 |
| #51603 | 副屏创建的窗口尺寸不对（Windows） | 多屏下 tearoff 落点/尺寸异常 |
| #52000 | 校验 taskbar 句柄 | 任务栏重启后窗口贴边异常 |
| #45930 | 连续两次 `setFullscreen(false)` 时菜单栏隐藏异常 | 全屏来回切的后遗症（该提交在镜像里体积异常大，取用需重导） |
| #52472 | sandbox 状态不同的 `window.open` 子窗口另开进程 | 弹窗进程模型专项 |
| #53764 | 睡眠唤醒后误报 `unresponsive` | 做 unresponsive UI 时 |

## 4. 维护约定

- 每条判定都必须能追到**证据文件或实测数字**，不接受"看起来不需要"。
- 判定为 ⛔ 的条目**不要删**：下次有人重新调研同一个补丁时，这份记录能省掉整轮工作。
- 上游归档更新同名覆盖后，在此处补一行"归档已更新（日期）"。
