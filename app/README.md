# BaoFlashBrowser Next 应用

M1 在此目录下使用单应用包。开工范围和验收要求见[新版架构 §6](../docs/discussions/2026-11-22-bfb-next-architecture.md#6-交付顺序和验收)及[架构审计 · 当前开工判定](../docs/discussions/2026-11-22-bfb-next-architecture-audit.md#当前开工判定)。

| 目录 | 职责 |
| --- | --- |
| `src/main/` | Electron 主进程，负责窗口、标签及 WebContentsView 生命周期、导航、会话权限、PPAPI 注册和 IPC 校验。 |
| `src/main/browser-window.ts` | 每个窗口的标签、选中关系、绑定代际与命令处理；崩溃后重建 WebContents。 |
| `src/main/sessions.ts` | 外壳与页面两条会话边界，权限检查与权限请求一律拒绝。 |
| `src/main/plugins.ts` | 自编译内核的 PPAPI 插件注册（`--allow-command-line-plugins` + `--register-pepper-plugins`）。 |
| `src/preload/` | 受信任外壳的预加载入口，向 Vue 外壳暴露经批准的异步命令和状态接口。 |
| `src/renderer/` | Vue 3 + Pinia 外壳，负责地址栏、标签交互和窗口状态展示；瞬态交互留在组件内。 |
| `src/shared/` | 跨进程共享的 IPC 类型、稳定错误码和数据结构，保持独立于 Electron 与 Vue。 |
| `tests/smoke/` | 使用实际自编译运行时和独立测试 profile 验证外壳、标签、PPAPI 与窗口隔离。 |
| `tests/smoke/fixtures/` | 可重复使用的本地 HTML 与自编 AS3 样本，来源与哈希见该目录 README。 |

阶段验收记录归档到 [docs/kickoff](../docs/kickoff/README.md)。

## 本地启动

使用 Node.js 22.12+ 或 24.x。在本目录执行以下 PowerShell 命令，按本机路径调整自编译产物目录。

> **换机器 / 新成员**：本项目用自编译内核，运行时不在仓库里。先看
> [`docs/kickoff/dev-environment.md`](../docs/kickoff/dev-environment.md)（快路径：把 `.runtime/win-x64`
> 从旧机器拷过来，约 30 分钟），并用 `npm run runtime:check` 校验来路。

```powershell
npm ci
npm run runtime:prepare -- 'D:\electron-build-142\dist'   # 或从旧机器拷贝 .runtime/win-x64
npm run runtime:check
$env:ELECTRON_EXEC_PATH = (Resolve-Path '.runtime/win-x64/electron.exe').Path
npm run dev
```

`npm ci` 安装锁定的依赖，并从同版本的 Electron 包获取默认启动器。准备命令在 `.runtime/win-x64` 组装独立开发副本，使用自编译 EXE 和运行时文件，保留原目录的探针应用。每个新 PowerShell 会话需重新设置 `ELECTRON_EXEC_PATH`。

环境里若存在 `ELECTRON_RUN_AS_NODE=1`（本机曾用于其它探针），Electron 会以 Node 模式启动、主进程拿不到 `app`。冒烟脚本会自行清除该变量；手工 `npm run dev` 前请先 `Remove-Item Env:\ELECTRON_RUN_AS_NODE`。

| 命令 | 用途 |
| --- | --- |
| `npm run typecheck` | 检查 TypeScript 和 Vue 类型。 |
| `npm run build` | 检查类型并编译主进程、预加载和渲染层。 |
| `npm start` | 使用自编译 Electron 启动已编译的应用（`electron.vite.config.ts` 会把 `ELECTRON_EXEC_PATH` 指到 `.runtime/win-x64`；没有运行时才回落到官方 `node_modules/electron`，此时 Flash 不可用）。 |
| `node scripts/test.cjs smoke`（推荐） | 不经过 npm 的命令壳；主窗口、拖出窗口和网页弹窗从创建起就不显示、不获取原生焦点。`npm run smoke` / `npm run smoke:bg` 保留为终端里的便捷入口。 |
| `node scripts/test.cjs smoke --jobs=N` / `--serial` | 按文件并行（默认 4 个并发，`--serial` 回到单进程串行）。每个文件一个 node 进程、动态领队，输出只在失败时整段打印；`.cache/test-durations.json` 记录各文件耗时用于「长文件优先」调度。**加并发不会更快**：实测 4 并发 79–88 s、8 并发 84 s——瓶颈是每个用例都要冷启动一个 Electron 应用，不是 CPU。 |
| `npm run smoke:file -- --only=a,b` | **只跑指定用例**（改完一个模块的日常验证，通常 8–25 s）。名字可写 `quick-settings`、`tests/smoke/quick-settings.test.cjs` 任一种；前台专用用例要加 `--foreground`（否则会按隐藏模式跳过）。 |
| `npm run smoke:changed` | **按 `git diff` 自动选用例**。映射表在 `scripts/test-map.cjs`（手写的近似依赖：改 `shell-overlays.ts` → 叠加层与快捷设置；改 `activity-lease.ts` → 休眠与拖出）。碰到 `browser-window.ts`、`package.json`、`preload/index.ts` 这类全局文件、或 `src/` 里没有规则的新模块，会自动退回全量。改动只在文档/记忆时不跑用例。 |
| 构建缓存 | `test.cjs` 会先算 `src/scripts/tests/package.json/配置文件` 的指纹，没变就跳过 typecheck + build（约省 6–7 s）；`BAO_FORCE_BUILD=1` 强制重建，`BAO_SKIP_TYPECHECK=1` 只构建不检查类型。 |
| `npm run smoke:foreground` | 显式前台验收：**会弹出真实窗口并抢焦点**，覆盖最大化/全屏、指针锁、DevTools、Ruffle 画布焦点、叠加层预热（`overlay.prewarm` 开关，含"关掉即释放/再开即升温"）与原生 Flash。期望 **70 用例全过、0 跳过**；期间不要切走焦点。 |
| `node scripts/test.cjs unit` | 单元层（vitest，纯 Node，不启动 Electron）：设置校验与回落、引擎与站点规则、站点边界（公共后缀）、日晷日夜换算、`bao://` 地址解析。45 个用例约 1 s；`npm run test:unit`。 |
| `node scripts/test.cjs data` | 无窗口跑存储合同用例：设置落库与跨重启、非法值拒绝、`engine-rules.json` 一次性迁移与幂等、坏值回落、硬杀后数据完整、写失败不应用。终端可用 `npm run test:data`。 |
| `npm run runtime:check` | 校验 `.runtime/win-x64` 的内核与插件 SHA-256（按 `scripts/runtime-manifest.json`），失败时给出拷贝/重建两条恢复路径。 |
| `npm run runtime:export` / `:byop` | 导出运行时 zip（`internal` 含插件、`byop` 不含 Adobe 二进制）+ 包内 `RUNTIME-MANIFEST.json`，供其它机器搭建环境。 |
| `npm run runtime:import -- <zip>` | 校验**关键件**（内核 exe 与仓库清单里属于运行时的文件）与**包完整性**（包内每个文件都必须被包内清单声明且哈希一致）后安装；`--target=<dir>` 只给往返测试用。 |
| `npm run runtime:roundtrip` | 双 profile 往返门禁：`internal` / `byop` 各 export → import → 校验关键件 → 清理（装到 `.runtime/roundtrip-*`，不碰正在用的运行时）。`pack:win` 默认会跑它；没有自编译运行时的机器上自动跳过。 |
| `node scripts/test.cjs packaged` | 无窗口验证最近一次打包的自编译内核与 Ruffle。终端可用 `npm run smoke:packaged`。如果提示旧产物不支持隐藏模式，先重新打包。 |
| `npm run smoke:packaged -- --foreground` | 前台验证成品的原生 PPAPI。内部包验证插件和 JS 桥，公开包验证 BYOP 投放。 |
| `npm run pack:win` | 在固定的 `dist/win-preview/win-unpacked` 生成 Win x64 验证包（每次覆盖，并清理历史随机目录），产物自带 PPAPI 插件；结束时校验产物确实来自自编译内核。 |

## 当前增量范围

已实测（`bao-v142-265-ppapi-sandbox`，Electron 39.8.10 / Chromium 142.0.7444.265）：

- 无边框两行外壳、Windows 原生窗口控件、Fluent 2 token 与深浅色跟随；默认应用菜单已移除。
- **主题**：设置项 `theme.mode`（跟随系统 / 浅色 / 深色）1:1 映射 `nativeTheme.themeSource`；外壳 token、叠加层、系统窗口按钮配色、起始页与站点看到的 `prefers-color-scheme` 由同一个解析值派生。
- **设置页**：`bao://settings` 作为内部页在标签里打开（`Ctrl+,` 或地址栏输入），已存在则复用；**当前标签是新标签页时就地覆盖它**（标签 id/位置不变，后退可回新标签页）。左侧是**真分区导航**，按 Edge 的切法与图标排列：`外观`（主题）/ `引擎`（默认引擎、Flash 插件、站点引擎规则：列出 `站点 → 引擎`，可单条「忘记」或全部清除，0 条时显示空状态）/ `隐私、搜索和服务`（默认搜索引擎、浏览数据清理）/ `启动` / `性能`（飞窗预热、后台标签休眠）/ `语言` / `关于`——只列我们真有内容的项（Edge 的个人资料、密码和自动填充、默认浏览器、下载、辅助功能、重置设置、扩展都没有数据源或能力，一律不列；下载按安全策略整体拒绝，见 `main/sessions.ts` 的 `denyDownloads`）。切换分区只换 `:hidden`、不重载文档，并把内容区滚回顶部。内部页跑在 `persist:bao-next-internal`、与页面同一套沙箱，只拿到 `baoSettings`（read/write/subscribe），拿不到外壳桥。在设置页里输入 http(s) 会新开普通标签，设置页原地不动。配色只有**一个强调色**（紫 `--accent`）：列表行选中态用 Fluent 中性选中面，品牌色只出现在 radio/开关/链接/焦点环上（早期混用 Fluent 蓝 `colorBrandStroke1` 与紫色，地址栏焦点环是蓝的、选中行是紫的，看起来不跟主题）。
- **新标签页**：`bao://newtab` 是真实内部页（与设置页同会话、不同 origin），`Ctrl+T` / 「+」/ 双击标签栏 / 关闭最后一个标签都新建一个 NTP（不复用）；打开时焦点在地址栏。页面本体是 realbox（回车在本标签导航）+ 设置入口 + 原生 Flash 状态，快捷方式/最近访问等依赖历史与书签的板块尚未接入。**首帧由主进程注入**：`bao://` 在返回 HTML 前把 `data-theme`、整套 Fluent 变量与 `NtpSnapshot` 写进 `<head>`（`shared/internal-bootstrap.ts`），所以第一帧就是真页面、配色与数据都对——不再有 HTML 里手抄的骨架与 `--critical-*` 副本（那套副本会漂、且"骨架→真页面"两套 DOM 交接时必然跳一下）。代价是首帧只有底色、内容在 Vue 挂载后出现（暖启动实测：首绘 92 ms、首内容 144 ms）。NTP → 网页是同一个标签换视图（内部会话永不承载 http(s)）；网页的**最早一条历史后退会回到 NTP**（重建 NTP 视图，页面状态不保留），再前进会重新加载该网页。
- **飞窗预热**：设置 → 性能 → 飞窗预热，是一个开关（**默认开**）。开=窗口创建即准备好飞窗文档，第一次点开就是热的（共享进程下**每窗口约 5–9 MB、不多一个渲染进程**）；关=不提前创建、用到才建，关掉的瞬间还会释放已经建好的那份。预热后打开 3 / 9 ms；完全不预热的键盘冷开 3 / 27 ms（端到端 144 ms）。原三档里的「自动（悬停预热 + 空闲 5 分钟回收）」已于 2026-11-26 删除：它省的就是这几 MB，却要养悬停意图/闸门/回收计时器。实测见 `docs/discussions/2026-11-25-overlay-shared-process-demo.md` §5.1 与 §7.5。
- **齿轮快捷设置**：工具栏齿轮打开飞窗（主题 / 默认引擎 / 收藏夹入口 / 全部设置），与设置页共用同一份 store，任一侧修改两边立刻同步。视觉取 Chromium 数值（圆角 12、**收紧的**真投影 `0 1px 2px 16% / 0 2px 6px 10%`、无外描边），无关闭按钮（点外部 / Esc 关闭）。底部两行（收藏夹 / 全部设置）是直接动作、不是子菜单，所以**不画 `>`**（2026-11-26 反馈：那个箭头让人以为还要再展开一层）。飞窗**永远在窗口内**：贴着触发按钮下沿、右边缘对齐，超出内容区时面板内部滚动。飞窗的分层方式（2026-11-26 改）：卡片**没有外描边**，用真投影；投影画在视图内部，所以视图 = 卡片 + 一圈透明边距（左右 `OVERLAY_GUTTER_X`=6、底部 `OVERLAY_GUTTER_BOTTOM`=10；底部更大，因为投影整体向下偏移——Chromium `ShadowValue::GetInsets()` 就是 `左右 = blur/2`、`下 = blur/2 + 偏移`，elevation 12 的气泡是 24/24/36）。锚点贴着窗口右缘时（齿轮是最后一个按钮）视图会被往左推几个像素，卡片宽度不变。透明边距落在视图命中区里会吃掉鼠标，因此主进程把边距里的 `mouseDown`/`mouseMove` **转发给当前页面**（`shell-overlays.ts` 的 `forwardGutterMouse`，`quick-settings` 用例里有专门一条：边距里的点击必须到达页面并收起飞窗）——这是 Electron 的硬约束：`View.setBorderRadius` 的官方注释也写着 cutout 仍然捕获点击，子视图没有原生投影，换独立透明窗口则会抢激活、破坏「一个视图一个渲染进程」。
- **Chrome 尺寸对齐（2026-11-26 第三轮）**：三行 chrome 的固定高度与控件尺寸全部照抄 Chromium 142 的布局常量（**非触摸**档，`chrome/browser/ui/layout_constants.cc`）：标签栏 **41**（`TAB_STRIP_HEIGHT` = `TAB_HEIGHT(34) + TABSTRIP_TOOLBAR_OVERLAP(1)` + `TAB_STRIP_PADDING(6)`）、工具栏 **46**（`max(location_bar, back) + TOOLBAR_INTERIOR_MARGIN.vertical()(6×2)`，`toolbar_view.cc:765`）、收藏夹横条 **34**（`BOOKMARK_BAR_BUTTON_HEIGHT(28) + 6`）；标签**标准宽 256**（`kTabWidth(232) + 2×12` 底角，`tab_style.cc:31`，原来 180 比正常浏览器窄一截）、顶部圆角 10 / 底部 12、标题左内距 8 / 右 4；工具栏按钮 **34×34**（`TOOLBAR_BUTTON_HEIGHT`，原来 32 看着比 Chrome 小一号）、地址栏高 **34**（`LOCATION_BAR_HEIGHT`）、工具栏左右内距 **5**（`TOOLBAR_INTERIOR_MARGIN` 水平 5）、元素间距 **4**（`TOOLBAR_ELEMENT_PADDING`）。页面视图的 y 因此从 84 变成 **87**（带横条 121），`shared/browser.ts` 的三个常量是唯一来源。
- **站点图标（favicon）**：标签栏画出站点自己的图标（Chromium 的 `FaviconTabHelper` 语义）。链路是「渲染进程 `page-favicon-updated` 上报候选 URL → 主进程按**图标 URL** 去重抓取（走页面会话 `pageSession.fetch`，5 s 超时、64 KB 上限、**按魔数认类型**）→ 内联成 `data:` URL → 投影里的 `BrowserTab.favicon` → 外壳 `<img>`」。五个真实约束：① 候选**先按页面地址解析**（大量站点写 `//host/icon.ico` 或 `/static/icon.png`，直接当绝对地址会整个丢掉——bilibili 就是这样）；② **不信 `Content-Type`**（老站点把 `.ico` 发成 `text/plain` / `octet-stream` / `text/html`），按魔数认 PNG/JPEG/GIF/ICO/BMP/WEBP/SVG，认不出的一律丢弃；③ 缓存键是图标 URL 而不是 origin（同站点不同页面可以用不同图标）；④ **新文档提交时先清图标**（`did-navigate`），否则同站点"没图标"的页面会挂着上一个页面的图标；⑤ 抓取失败也缓存（`undefined`），否则每个页面都发一次注定失败的请求。**加载中转圈**（Chromium 的 `TabIcon`：转圈与图标互斥）数值照抄 `ui/gfx/paint_throbber.cc`：弧 270°、伸长期 667 ms / 一轮 1333 ms、整圈 1568 ms、2dp 描边、`cubic-bezier(.4,0,.2,1)`；`prefers-reduced-motion` 下退化成静止的 3/4 弧。注意外壳文档的 CSP 必须放行 `img-src 'self' data:`（`renderer/index.html`）：`default-src 'self'` 会把它拦成一张破图，而 `src` 有值这条假象只有断言 `naturalWidth` 才抓得住。收藏夹横条/面板里的条目按同一张表查（书签从没被打开过时按 `<origin>/favicon.ico` 兜底抓一次）。
- **收藏夹（第二轮）：横条**：工具栏下面那第三行，高度 **34**（Chromium 的 `BOOKMARK_BAR_HEIGHT` = `BOOKMARK_BAR_BUTTON_HEIGHT(28) + 6` 居中留白，见 `shared/browser.ts`）。**显示规则只有一处**：`shared/bookmarks.ts` 的 `showsBookmarkBar(mode, internal)`，主进程按它算页面视图的 y 坐标（`41 + 46 + 34`），外壳按它决定画不画——两处各写一遍就是"条画出来了、页面压在下面一截"（2026-11-26 实测过：设置写进库了、界面也变了，就是视图没让位，根因是设置变更只走 `broadcastSettings()` 没走 `layout()`）。三档取 Edge 的「显示收藏夹栏」语义（`ntp`（默认，排第一行）/ `always` / `never`），不是 Chromium 那两个布尔 pref：拆成两个布尔会让"从不显示"和"仅新标签页"在设置页里没有名字。**横条的显示判定只有一处**（`main/browser-window.ts` 的 `bookmarkBarShown()`），规则本体仍是 `shared/bookmarks.ts` 的 `showsBookmarkBar()`，外壳只消费投影里的 `bookmarkBarShown` 布尔——因为它还带**时序**：从新标签页进网页要换 WebContents，`internal` 在导航**开始**就清了，而新页面还是白的，横条若此刻就收，观感是"横条先消失、页面才跳"。Chromium 在导航**提交**时才 `UpdateBookmarkBarState`（`bookmark_bar_controller.cc:218` 的 `DidFinishNavigation`），我们用 `Tab.barHold` 对齐：`leaveNewTab()` 置位，新视图的 `did-navigate` / `did-fail-load` / `did-stop-loading` / `destroyed` 谁先到谁放开，放开时 `layout()` + `publish()` 让横条与新页面同一帧变（`never` 档优先于按住）。两个入口：横条**右键**是原生菜单（`bookmark-bar-menu` 命令 → `Menu.popup`，「显示收藏夹栏」三档 + 「打开收藏夹」；菜单回调跑在主进程里没有命令结果可返回，写失败必须自己 `overlays.notifyFailure()` 送回外壳，否则就是"点了没反应"）、以及**设置页 → 外观 → 收藏夹栏**（**下拉框**，当前档排第一行——竖排单选把三档铺成三行，占半屏却没有信息量）。收藏夹**面板**里的两个永久根同样是可展开可关闭的行（箭头 + 缩进，默认全收起），不是"分组标题 + 分隔线"。内容 = 「收藏夹栏」根下的**一层**：网址项点一下在当前标签打开（`open-bookmark` 按 id 取地址），文件夹项打开**收藏夹面板**并锚在那颗按钮下（里层在面板里展开——横条下方的文件夹菜单需要一只独立弹出层，本版不做）。放不下的项按 Chromium 的 `first_hidden_node_idx_` 收口：排一次、量一次、把超出的用 `visibility: hidden` 藏掉（**必须保留布局**，用 `display: none` 会让第二次测量把已藏的项当成宽度 0），右侧出现 `»` 直接打开收藏夹面板（不自己画菜单，那样"其余项"就叫不准）。空态按 Edge 留一行提示条 + 「立即管理收藏夹」，不是 Chrome 的"整条消失"。**横条出现时工具栏不再画自己的下边框**（只有整条 chrome 最下面一道线，Edge 实测如此）。文件夹按钮靠左时右对齐会被夹到窗口最左边，所以 `flyoutBounds()` 在右边放不下时改成**左对齐**（卡片左缘贴住按钮左缘）。
- **收藏夹（第一轮）**：两件事分开，按 Chromium 142 的源码对齐（`chrome/browser/ui/browser_commands.cc` 的 `BookmarkCurrentTab`、`chrome/browser/ui/views/bookmarks/bookmark_bubble_view.cc`）。**地址栏星标**（`StarView` 的位置）是页面级的：点一下**先落库**（名称=页面标题、位置=收藏夹栏），再弹出「编辑收藏夹」气泡（名称 / **文件夹下拉** / 更多 / 完成 / 删除，初始焦点在名称框并全选）；已收藏时星标实心，再点就是编辑同一条（幂等，不会攒出重复条目）。改名在**停顿 400 ms / 失焦 / 点完成**时落库——Chromium 是"关闭气泡时统一 ApplyEdits"，我们的气泡是独立文档、关闭那一刻 `quick` 角色的命令权限已经失效，所以改成更保守的"即时保存"，用户不会因为点了下页面外面就丢掉刚改的名字。**按钮的主次与 Chromium 相反**（2026-11-26 产品决定）：点星标时收藏已经写进去了，最常见的意图是"点错了撤销"，所以**删除在最右、用危险色**，「完成」退成次要按钮。**文件夹是下拉**，列出库里**所有**文件夹（两级以上缩进，不只两个永久根）；选中即移动。气泡里的「更多」打开**完整编辑器**：名称 / URL / 文件夹树 / **新建文件夹** / 保存 / 取消（取消不写库）；编辑器与气泡、收藏夹树、设置页读的是**同一份投影**，新建的文件夹立刻出现在树里。内部页不显示星标（Chromium 对 `chrome://` 页同样不显示；地址栏是弹性的，隐藏不会改工具栏宽度）。**工具栏「收藏夹」按钮**是另一件事（Edge 那颗）：打开收藏夹树（按 `position` 排序，条目可点击导航当前标签、可逐条删除，列表封顶滚动）；齿轮飞窗里的「收藏夹」入口指向同一页。四者共用**同一个飞窗视图与文档**，靠 `view` 换页（`shared/overlay.ts` 的 `QuickView`：`settings` / `bookmarks` / `bookmark-edit` / `bookmark-editor`），换页不重新挂载、不重新预热，只重新锚定到对应按钮（宽度统一 320；编辑器 400）。数据在业务库 `bookmarks` 表（v3 迁移，两个永久根 `bar`/`other` 直接落在表里），随每次状态广播投影给外壳与浮层，星标/气泡/树/编辑器都从这一份投影算。四个飞窗（快捷设置 / 引擎面板 / 收藏夹 / 编辑气泡）共用 `renderer/overlay-panel.css` 的**同一组数值**（卡片圆角 12 + inset 1px 描边、内距 6、标题 11px 灰、菜单行 36 / 圆角 7、输入框 32、动作按钮 28）——各写一份的结果就是漂移，2026-11-26 已经出现过一次（新做的两页内距 8px、标题 12px 粗体、输入 28、档位 24，和既有两页不是一套）。本轮边界（横条已在第二轮补上）：没有 `bao://favorites` 管理页（拖动排序、重命名/删除文件夹、导入 Chrome 书签）、没有 favicon 管道（条目用页面图标占位）——数据层（树、环检测、排序位、`titleFor`、`clearBookmarks`）已经就位并有单测。
- **启动只有一个标签页**；多标签由「新建标签页」按钮、双击标签栏或 `Ctrl+T` 创建。
- 标签栏交互：点击/键盘切换、中键关闭、关闭按钮按需显示、拖动排序、拖出窗口（tearoff）、右键菜单（重新加载/复制/固定/静音/关闭/撤销关闭）、`Ctrl+W` 关闭、`Ctrl+Shift+T` 撤销关闭。
- 撤销关闭用 E39 导航栈（`getAllEntries()/restore()`）恢复，保留前进/后退历史；无可撤销项时返回稳定错误码 `nothing-to-undo`。
- 标签级快捷键与 F11 / Esc 全屏都在主进程 `before-input-event` 处理，因此页面（含 Flash）获得焦点时仍然生效。
- **输入回环**：ASCII 与非 ASCII 字符进页面、IME 组合（`compositionstart/update/end` + 提交文本）、普通字母不被标签快捷键吃掉、地址栏与页面焦点互不串台、F11 全屏后视图跟随内容区、Esc 退出；自编 `keyprobe.swf` 证明键盘事件真的进了 **PPAPI 插件进程**。
- **双引擎**：每标签一个引擎（原生 PPAPI / Ruffle）。站点规则决定初始引擎，手动切换会新建 WebContents 并恢复导航栈——**页面运行态（含 Flash 内存态、`SharedObject` 待写缓冲）不保留，也不会保留**：一个视图不可能同时承载原生插件与 Ruffle 运行时，所以"切换但不动页面"不成立。它是用户看着点下去的显式动作，按 [ADR-0004](../../docs/adr/0004-liveness-over-memory-reclaim.md) §3b 不受"存盘握手"约束（那条只约束**用户不在场**的自动休眠）；切换后可「记住此站点」写入规则。Ruffle 使用 `vendor/ruffle` 的固定版本资源（0.8.0），由页面 preload 注入主世界并 polyfill `<embed>`。工具栏上引擎是**一个 32×32 按钮**（与齿轮同尺寸，图标=当前引擎：红闪电=原生 Flash、紫星=Ruffle、橙=被站点规则覆盖），点开就是引擎飞窗（引擎选择 + 「记住当前引擎」+ 来源说明）；内部页（`bao://newtab`、`bao://settings`）上按钮**置灰禁用**而不是隐藏——隐藏会让工具栏宽度随标签来回变。
- **引擎网络 broker**：Ruffle 的 SWF/数据请求需要按站点 `crossdomain.xml` 放行跨源读。实现上**不碰页面 `window.fetch`**：注入前重写 wasm-bindgen 的 `__wbg_fetch_*` import，把 Ruffle 自己的 fetch 指向闭包内的私有传输（临时全局立即删除），因此普通网页脚本拿不到特权入口、页面 fetch 语义保持不变。主进程按目标站策略判定，来源取浏览器认证文档的完整 origin；重定向逐跳重新授权；Cookie 交给 `useSessionCookies`；`Referer` 用带随机令牌的私有标记还原（页面无法伪造）。
- **Ruffle 子帧支持**：Ruffle 视图开启 `nodeIntegrationInSubFrames`，preload 进每个子帧，跨源 iframe 里的客户端 SWF 也能被接管（淘米摩尔庄园的客户端挂在 iframe 里）。
- 页面会话关闭 Node、开启 context isolation 与 sandbox；**权限白名单**只放行 `fullscreen` / `pointerLock` 且要求 http(s) 来源，其余一律拒绝；**受控弹窗**只允许同站点 http(s) 弹窗（以新标签承载，引擎继承 opener），跨站与非 http(s) 拒绝；外壳 IPC 校验发送者、帧与文档来源，失败返回稳定错误码。
- 本地 PPAPI 样本：`navigator.plugins` 含 `Shockwave Flash`、独立 `Pepper Plugin` 进程、SWF 装载完成（`PercentLoaded = 100`）与 `SetVariable/GetVariable` 变量桥往返。
- 窗口销毁与重建：旧窗口的 WebContents 全部释放、旧事件不污染新窗口、标签业务 ID 跨窗口唯一；渲染进程崩溃后重建 WebContents 恢复页面。

## 已知约束与待验证项

- **内核要求**：原生 PPAPI 需要 `bao-v142-265-ppapi-sandbox`（提交 `9de35f61aea60`）或更新。此前为了让插件实例化曾关闭页面视图的渲染进程沙箱；根因是渲染进程里的插件路径复核，已由[内核补丁](../docs/kernel/README.md)修复，外壳与页面视图现在都保持 `sandbox: true`。
- **Ruffle 的能力边界**：`ExternalInterface` 只覆盖部分 API，PPAPI 样本里的 `PercentLoaded`/`SetVariable` 往返在 Ruffle 引擎下不保证可用；验收断言只看运行时注入与 polyfill 接管。
- **站点规则与设置存储**：统一在 `userData/db/browser.sqlite3`（SQLite + WAL，`node:sqlite`），主进程单写者。M1 的 `userData/engine-rules.json` 在首次启动时一次性导入（事务内），成功后归档为 `engine-rules.json.migrated-1`（保留不删）。库打不开时以默认设置运行并拒绝写入，不会回头写 JSON 造成两套数据。
- **`node:sqlite` 是实验性 API**（Node 稳定性 1.1）：绑定层由 `app/src/main/db/sqlite.ts` 隔离（拒绝 `Date`/`NaN` 静默写 NULL、显式 busy timeout、SAVEPOINT 事务、错误码归一）；启动时有 `quick_check` 自检，换内核时必须重跑 `npm run test:data`。
- **标签合同尚未覆盖**：会话恢复、未加载占位、分组与搜索（固定/复制/静音/右键菜单已实现）。`detachTab/adoptTab` 与 `undo-close` 是这些交互的同一入口。
- **跨窗口移交的未验证面**：失焦、全屏退出、音频继续播放、Flash 内存态在真实站点下的表现；已实测的是同一 WebContents 复用带来的页面运行时状态与导航历史保留。
- **Ruffle 的键盘焦点**：Ruffle 0.8 需要用户**先点一次播放器**（它靠 `pointerdown` 把焦点交给内部容器），之后键盘事件才进 SWF；自动化要用 CDP 派发指针事件，`sendInputEvent({type:'mousedown'})` 不够。`ruffle-input.test.cjs` 已覆盖。
- **快捷键**：`Ctrl+T/W/Tab/Shift+T`、`Ctrl+Shift+I`（页面视图 DevTools）与 `Ctrl+,`（设置页）。标签分组、标签搜索、未加载占位仍未实现。
- **引擎相关未验证**：引擎切换失败回退（`restore()` 抛错）没有构造用例；真实站点（4399 等）在两种引擎下的对照未复测；UA、插件版本通告、`mms.cfg`、SWFObject 等站点兼容项按审计 §C7 另行验证。
- **输入相关未验证**：Ruffle 引擎下 `ruffle-embed` 画布的键盘焦点与游戏内输入未测（PPAPI 引擎下的插件内部输入已由 `plugin-input.test.cjs` 覆盖，样本见 `tests/smoke/fixtures/README.md`）。
- **自动化窗口模式**：测试入口默认使用 `BAO_SMOKE_HIDDEN=1`（不调用 `show()`）。成品冒烟还会传入自动化命令行开关；普通启动成品不受测试环境变量影响。需要真实窗口或焦点的用例会明确标记跳过，可用 `npm run smoke:foreground` 验收。
- **观测量（2026-11-26，含同日修正）**：主进程每 100 ms 向**外壳渲染线程**发一次心跳——回执必须在渲染线程上发出，所以 RTT 基本等于被阻塞的时长（空闲 ~2 ms；浮层里跑 400 ms 忙循环时 ~400 ms）。**但启动期不适用**：外壳是新渲染进程，首帧之前 ping 只能排队，第一次往返必然被抬到 100–350 ms，而 Chromium 启动 tracing 显示这段时间**没有**超过 54 ms 的单个任务（解析尾部 54 ms、首次 style/layout 34 ms）——它是"进程还没起来 + 首帧还没画"，不是卡顿。所以 preload 在首帧后（两次 rAF）发 `bao:heartbeat:ready`，此前只记 `boot`（`console.info` 一行冷启动），此后才按 `stallMs` 记卡顿；RTT 里含主进程自身的一段（`mainLag` 一并统计，告警文案会写清是哪一侧）。`BAO_HEARTBEAT_TRACE` / `BAO_OVERLAY_TRACE` 指定文件时，把**每一跳**的 `sample`、冷启动 `boot`、运行期 `stall` 与浮层长任务（带 `sourceURL`）落盘。成品只在 `BAO_HEARTBEAT=1` 时启用，开发态默认开；`heartbeat.test.cjs` 三条用例覆盖空闲、被阻塞、以及浮层长任务的**跨窗口归因**（LoAF 的 `windowAttribution` 按帧树分档，浮层是另一个顶层窗口，外壳侧 observer 拿不到），单测覆盖冷启动样本不进卡顿统计。
- **窗口出现时机（2026-11-26 实测改）**：普通窗口在 `ready-to-show`（渲染层画出首帧）之后才 `show`，不再在 `loadURL` 解析后立刻显示。此前 show 落在首帧前 200–300 ms，用户先看到一个空窗口、这段时间里点齿轮开飞窗也只能排在启动任务后面（体感"一起动就卡一下"）。兜底 1500 ms，避免隐藏窗口的首帧被节流时窗口永不出现。**例外是接管窗口**（拖出标签 / 跨窗移交通道）：那类窗口要跟手，仍然立刻 `show`。
- **两套跑法（2026-11-25 定）**：日常用隐藏并行（快、不抢焦点、覆盖后台路径）；**每次换内核后必须跑一次前台** `npm run smoke:foreground --serial`（**85 通过 / 0 跳过**）作为闸门。不把用例整体改成前台——那会丢掉后台状态覆盖并只能串行。
- **flaky 排查**：`waitFor()` 超时会自动 dump 现场（进程分布、外壳页状态、标签栏文案），失败的报错里带 `[超时现场]`；
  「等标签出现」一律用 `waitForTabLabel()`（DOM 轮询）而不是 Playwright 的可见性等待。
  第一轮治理记录见 [`docs/reports/2026-11-25-smoke-flake.md`](../docs/reports/2026-11-25-smoke-flake.md)。
- **前台模式此前从未真正生效（2026-11-25 修复）**：`scripts/test.cjs` 里 `--foreground` 删掉的 `BAO_SMOKE_HIDDEN` 会被后面的 `else` 重新设回，导致 7 条前台用例长期被跳过。修复后实跑 **58/58 通过**（后续新增用例，现为 **85/85**：+2 休眠门禁、+6 两阶段引擎切换、+2 会话恢复、+2 引擎切换、+1 拖出回滚），记录见 [`docs/reports/2026-11-25-foreground-smoke.md`](../docs/reports/2026-11-25-foreground-smoke.md)。
- **原生 Flash 验收**：匹配运行时清单中已验证沙箱的内核时，应用后台冒烟会验证 PPAPI 装载、JS 桥和插件输入。自定义或旧内核以及成品的原生 Flash 验收可用显式前台模式。
- **自动化宿主**：如果编辑器或自动化工具启动 `npm` 本身就会弹出终端，可从该工具直接启动 `node scripts/test.cjs smoke`，工作目录设为 `app`，并由该工具把入口进程设为不显示控制台。入口脚本只控制它启动的子进程。
- **下载默认拒绝**：页面与外壳会话的 `will-download` 一律 `preventDefault()`。M1 没有下载能力与落盘策略，没有明确策略前不静默写文件；下载的身份、分区、暂停/恢复按 §4 在 M2 立项。
- 后台出帧（#52844/#54311/#54090）与真实站点复测按架构 §2 与外壳开发并行推进，当前未开始。
- 独立复建内核与发布依赖校验仍未完成，验证包只用于受控范围。
### 打包产物的三条约定（2026-11-23 修正）

1. **开发不需要 `dist/`**：`dev` / `start` / `smoke` 都用 `.runtime/win-x64/electron.exe` + `out/`，`dist/` 只有 `pack:win` 与 `smoke:packaged` 用得到，随时可以整个删掉重打。
2. **必须带自编译内核**：未设置 `ELECTRON_EXEC_PATH` 时 electron-builder 会**静默下载官方 Electron**（产物 ~210MB，自编译运行时 ~232MB），官方内核没有 PPAPI 补丁，`smoke:packaged` 会报 `flash:timeout bridge-unavailable`。`pack-win.cjs` 现在兜底设置该变量，并在结束时断言产物大小与运行时接近，不符就失败。
3. **必须带 PPAPI 插件**：插件随内核 dist 目录进入 `win-unpacked/`（与 exe 同目录，`plugins.ts` 的第二候选路径），**不再复制到 `resources/`**——之前 extraResources 会让包里出现两份 30MB DLL。打包脚本会断言「包内有且只有一份插件」且哈希与来源一致。
4. **来源门禁**：`scripts/runtime-manifest.json` 记录内核 EXE、插件与 Ruffle 运行时的期望 SHA-256，`pack:win` 逐项校验，不匹配即失败。换内核/插件必须同步更新清单，并在提交信息里写明来源与 tag；临时放行用 `BAO_ALLOW_UNVERIFIED_RUNTIME=1`（会告警）。
5. **成品验证不允许默认跳过**：`smoke:packaged` 找不到产物会**失败**（`BAO_SKIP_PACKAGED=1` 才显式跳过）；`BAO_PACKAGED_ROOT` 可指向 CI 本次构建的产物目录。
6. **许可**：`NOTICE.md` 与 `licenses/`（Chromium 第三方许可 14.4 MB + Electron 许可）随包。Chromium 那份取自**官方 Electron 39.8.10 发行包**（同版本近似，见 `licenses/README.md`），最终应由内核构建生成。Flash 插件再分发授权未确认。
7. **签名与产物清单**：提供 `WIN_CSC_LINK` / `CSC_LINK`（+ `CSC_KEY_PASSWORD`）时打包会走 electron-builder 签名；无论是否签名，`pack:win` 都会在产物根写 `manifest.json`（组件哈希、许可文件、PE 签名块状态、内核 tag、发布门禁清单）。签名链校验仍需发布时用 signtool 另行验证。

### Flash 插件：BYOP（用户自备，并自动发现本机已有的那份）

本项目**不随公开发布包分发 Adobe Flash Player**（其再分发受 Adobe 许可限制）。插件按下面的
顺序解析，**前面的存在就不会用后面的**——需要指定版本时用设置页「导入」，导入的插件优先于
自动发现：

1. `BAO_FLASH_PLUGIN` 环境变量；
2. 设置页「导入」复制到 `<userData>\flash\pepflashplayer64.dll`；
3. `<BaoFlashBrowser Next.exe 所在目录>\flash\pepflashplayer64.dll`；
4. `<BaoFlashBrowser Next.exe 所在目录>\pepflashplayer64.dll`；
5. 应用 `resources\`；
6. **自动发现**：在本机常见位置找一份已经存在的插件——`C:\Windows\System32\Macromed\Flash`
   里 flash.cn 安装的 `pepflashplayer64_34_*.dll`、Chrome/Chromium 的 `PepperFlash`、
   360/QQ/搜狗等双核浏览器。找到的那份**不复制、不移动**，只记住路径，
   并且要先过 PE/Pepper 校验（64 位 + `PPP_GetInterface` 导出）才会被加载。

   **`Downloads` / `Desktop` 不在默认扫描范围内**（2026-11-26 审计：这是信任边界）。这两个
   目录任何进程都能写，自动加载其中的 DLL 等于「谁能往下载目录丢文件，谁就在插件进程里执行
   代码」——Pepper 沙箱限制的是插件**能力**，不是它的**来源可信度**。放在那里的插件请走设置页
   「导入」（有用户选择、来源记录与哈希校验）。排障时可 `BAO_FLASH_SCAN_USER_DIRS=1`
   临时把用户目录纳入扫描，不作为默认行为。

放好后重启应用即可启用原生引擎；自动发现按版本从新到旧挑一份，结果缓存在
`<userData>\flash\discovery.json`（下次启动只 `stat` 一次，不重扫）。插件换了或删了都要重启
才生效，设置页会写明是「重启后生效」还是「插件已移除」；「打开所在文件夹」可以直接定位当前
用的那份 DLL。`BAO_FLASH_DISCOVERY=off` 可彻底关掉自动发现。没检测到时所有标签自动回落到
Ruffle，引擎面板里的「Flash」档会置灰并在悬停时给出投放路径。我们只负责加载本机已有的文件，
**不提供来源与下载方式**。

两个打包 profile：

| 命令 | 产物 | 用途 |
| --- | --- | --- |
| `npm run pack:win` | internal：带插件 | 内部验证；**默认拒绝签名**（`BAO_ALLOW_SIGN_INTERNAL=1` 才放行），不得对外分发 |
| `npm run pack:win:public` | public：**不带** Adobe 二进制 | 可签名、可分发；用户按上面的 BYOP 方式自备插件 |
