# BaoFlashBrowser Next 架构设计（讨论稿·大纲）

> **2026-11-24 归档标记——本文全部作为过程存档保留。**
> · 原 §F0′–§F10 Agent 区已经由 [Agent 与自动化架构](../agent-automation-architecture.md) 取代，不再是现行记录。
> · 产品定位以新专项权威文档为准；未被替代的浏览器工程合同仍见 [11-22 提案](2026-11-22-bfb-next-architecture.md)。
> · 文档地图与冲突登记见 [docs/README](../README.md)。

- 状态：**B1 已结案（WebContentsView，2026-11-21）；下一议题 = A 区外壳技术栈**
- 日期：2026-11-21
- 前置结论：技术栈 = Electron 142（Chromium 142 / Electron 39），完全重造，原项目仅供参考，不做机械搬运
- 来源标注：【U】= 用户点名议题；【A】= AI 补充议题（附理由）；各条目内容待讨论后填充

---

## 议程总览与建议顺序

| # | 议题 | 来源 | 建议顺序理由 |
|---|---|---|---|
| B1 | 视图容器选型（WebContentsView / webview / 多窗口） | 【A】补入"标签页" | **建议最先讨论**：它约束外壳的一切交互模式，是原项目 UI 痛点的总根源 |
| A | 外壳与 UI 技术栈（框架/状态管理/样式/工程化） | 【U】议题 1 | 轻，可热身；但依赖 B1 结论落地 |
| B | 标签页架构（状态机/Chrome 对齐/教训清单） | 【U】议题 2 | B1 定完后的主体 |
| C | 模块清单逐个过（自动化/下载/i18n/密码/扩展/Flash 等） | 【U】议题 3 + 【A】补全 | 逐项填充 |
| D | 进程与数据架构（主进程划分/IPC 合同/存储权威源） | 【A】补入 | 横切所有模块，模块议完后收拢 |
| E | 工程结构与共享层（monorepo/测试/打包） | 【A】补入 | 收尾；E1 直接服务 Modern 共享 |

---

## A. 外壳与 UI 技术栈【U】

- A1. 前端框架：**【已定 2026-11-21：Vue 3】**（AI 初选 React 19，被用户依预置翻案条件否决，见下）
- A1.1 联网核实（2026-11-21）：**Vue 3 结论强化**。【事实】Vue 3.6 完成 alien-signals 响应式
  引擎重写（比 3.5 快 1.8×、computed 吞吐 30+×、内存 -65%，零代码改动受益）+ Vapor Mode
  （按组件 opt-in 跳过 VDOM，性能进 Solid/Svelte 5 梯队；不支持 Options API，要求
  Composition API）。【版本状态】截至 2026-10-15：stable = 3.5.44，3.6 = RC（rc.11），
  稳定日未公布（一篇中文博客称"已正式发布"与 Monterail / GitHub 参考文档两处冲突，按两票
  采信仍在 RC）。【建议落点】起跑 Vue 3.5 stable + Composition API only；3.6 stable 落地后
  无破坏升级白拿 alien-signals；热点组件（下载进度行、标签条）逐个 Vapor opt-in。
  Vue 4.0 已立项、官方承诺迁移成本极低。→ A1 选型由"无硬伤备选"升级为"响应式演进正中
  外壳高频订阅场景"。
- A2. 状态管理技术栈（与 B3 标签状态强关联，合并讨论）：**Pinia【联网核实确认 2026-11-21】**
  ——Vue 官方默认（Eduardo 背书）、1.5KB、TS 原生、DevTools 全支持；挑战者不成立
  （Zustand-vue 缺 DevTools；@preact/signals-core 仅适合叶级热点小件）。
  架构结论见下方 A2+B3 合并讨论。
- A3. 组件库与样式方案（Tailwind v4 / antd / 自建设计系统——用户对旧 UI 三大不满：大留白、弱分隔、多二级菜单，设计语言要从这里立规矩）
- A4. 构建与工程化（Vite、TS 配置、目录约定）
- A5. **界面归一化【A，2026-11-21 用户追加】**：原项目弹窗各跑各的、还有原生 Windows
  样式。根因判断 = B1 置顶约束的直接产物（覆盖页面的对话框做不了 DOM 版只能原生）。
  WebContentsView 时代可解，见下"界面归一化提案"。

### A5 界面归一化提案【设计 2026-11-21 深夜，待确认】

**根因判断**：87 弹窗四分五裂（DOM modal / 原生 `dialog.show*` Windows 样式 /
OS Menu / 系统通知）不是没做设计，是**做不了**——B1 置顶约束下，需要盖住页面的
对话框永远进不了 DOM。WebContentsView 时代用工具④（子 WCV 浮层）解开了这个死结。

**归一化矩阵**（判据一句话：**用户语义归 DOM，OS 语义与安全语义留原生**）：

| 层 | 类型 | Next 方案 | 87 现状 |
|---|---|---|---|
| 用户语义（模态） | 确认/输入/展示/进度对话框 | **对话框服务**：全尺寸子 WebContentsView（透明背景+半透明遮罩+中央 Vue 卡片），真覆盖页面、HTML 自由样式、主题与语言联动 | DOM modal（盖不住页面，只敢在外壳区域用）+ 原生 dialog（Windows 样式）混用 |
| OS 语义 | 文件选择/保存、右键菜单、系统通知 | 原生保留（Chrome 同款；文件对话框系统级体验） | 原生（不变） |
| 安全语义 | view-gate 门禁等防伪造 UI | **OS 原生强制**（网页不可伪造性优先，B 区已定） | OS 鉴权（不变） |
| 页面语义 | `alert/confirm/prompt` | Chromium 自绘样式（对齐 Chrome，不干预；拦截可行性留 POC 可选） | 默认 |
| 窗口 chrome | 主窗口 / 站点弹窗（`window.open`） | **全部自绘**：主窗口 `titleBarStyle: hidden` + `titleBarOverlay`；弹窗 `frame: false` + 右上角自绘控制簇（拖动抓手 / 最小化 / 关闭），站点弹窗不再出现 Windows 原生标题栏（2026-11-23 落地，`titlebar.test.cjs` 覆盖留白与双击最大化） | 原生 Windows 帧 |

**对话框服务设计要点**：
1. 全尺寸子 WCV = 遮罩模式天然成立（模态 = 吃掉全部点击正是所需）；非模态 popover
   用小尺寸定位模式。两种模式同一服务、同一组件库。
2. 主题联动：子 WCV 是独立 webContents，`nativeTheme` 自动传播，CSS
   `prefers-color-scheme` 直接生效；语言联动：注册进语言变更广播。
3. i18n 词典驱动（C3 统一词典），文案不再硬编码。
4. 与 B1 四件工具的关系：对话框服务 = 工具④的第一个正式消费者；地址栏下拉、
   右键菜单等按 B1 矩阵各归其位。
5. 效果目标：**用户可见的对话框只有一种视觉语言**——原生 Windows 混搭从 Next 消失
   （除 OS/安全语义层，那些 Chrome 也原生）。

### A3 设计语言【开题 2026-11-21 深夜，待裁决】

**87 线样式现状（源码核对）**：`styles.css` 单文件 1794 行；CSS 变量起步
（--bg-tabstrip/--bg-active-tab 等，含 Chrome 式"开口"标签语义）但 token
未系统化；暗色 = `body.dark` 选择器双写覆盖（每个组件维护两份）；Tailwind
3.4 挂名依赖但基本未用；themeMode 三态经 nativeTheme source 传播（机制对，
落点已随 C5 迁 SQLite settings）。

**已定约束（引用，不重议）**：UX 基准对齐 Chrome/Edge（用户记忆）；分隔
走 1px 边线不走模糊投影（GPU 首栅格教训，87 已执行）；A5 归一化矩阵
（用户语义 DOM / OS+安全原生，待确认）；B4 顶部横条标签 + 操作集全对齐
Chrome；C7-S2 引擎指示器 + C8 DevTools 停靠形态等组件语义归 A 区落位。

**A3-D1【已定 = 对齐 Edge = Fluent 2 设计语言】（2026-11-21 用户定，参数已
联网核实）**

- **事实源**：Microsoft 公开 design tokens（`@fluentui/tokens` 包 +
  fluent2.microsoft.design）——不是"抄 Edge 观感"的逆向，而是直接采用 Edge
  所用设计语言的官方参数表。方法论与 B2 一致：事实源权威、参数可引用。
- **已核实参数基线**（全局层）：spacing 4px 基数 ramp（2/4/6/8/10/12/16/
  20/24/32，含 sNudge/mNudge 中间档）；radius 2/4/6/8/12 + circular；
  shadow 分档 shadow2/4/8/16/28（卡片静息→teaching callout）；字体
  Segoe UI Variable 栈 + fontSize100~900 阶（12/14/16/20/24/28…）；
  三档 token 架构 global→alias→component（官方与 D2 预判同构）。
- **性能教训调和（87 GPU 首栅格 × Fluent 阴影）**：Fluent 官方本身就有
  "卡片静息态用 inset 1px stroke 替代阴影"的实践（shadow-card-stroke）。
  Next 铁律：**首帧可见表面一律 stroke 分层，shadow 仅用于真浮层**
  （菜单/popover/对话框，非首帧）；Acrylic blur（30px/60px backdrop-filter）
  在外壳**禁用**（GPU 首栅格同源代价），Mica 类窗口材质列为 Windows 11
  可选增强【待核 Electron backgroundMaterial 支持与代价】。
- **品牌点缀**：accent 色走 Fluent 16 阶 brand ramp（官方
  createLightTheme/DarkTheme 机制，BFB 自定主色生成 ramp），不再自带散装
  品牌色。中性色/描边/前景全按 Fluent neutral 体系（比 87 自调灰阶
  覆盖度更高，AA 对比度官方已背书）。

**A3 议程分解（五个裁决点）**：

- **A3-D1 设计事实源与基调**——视觉参数（间距/字号/圆角/色板）以什么为准：
  a) 对齐 Chrome 实际参数（Chrome UI 的 views 色板 + WebUI tokens 作事实源，
  照抄参数不照抄代码）；b) 自有语言（Flash 游戏浏览器品牌个性）。【预判：
  a 为主 + 少量品牌色点缀，与"以 Chromium 源码为事实源"方法论一致】
- **A3-D2 token 体系**——a) CSS custom properties 单层 token（语义层：
  --bg-surface/--text-primary，组件禁止裸色值）+ `[data-theme]` 属性切换
  （替代 body.dark 双写，暗色只写一份）；b) 继续 87 式自由生长。【预判 a】
  与 D 区主题服务衔接：token 表是唯一事实源，nativeTheme 变化只切属性。
- **A3-D3 布局骨架**——顶部区形态（Chrome 标准两行：标签条行 + 工具栏行
  vs 紧凑一体化单行）+ 侧边栏（B 区已定常驻挂载三态）+ 内容切割线（B1
  外壳/页面判据已定）。**【已定 = 方案 A Chrome 两行】（2026-11-21 用户
  裁决："没必要抢夺那点空间，实在受不了还有 F11"——一体化单行出局，
  活动标签与工具栏同色开口相连为定型语义，见 artifacts/a3-layout-demo.html）**
- **A3-D4 组件基座**——浏览器壳是高定制 UI，成品组件库不合身：a) headless
  原语（Vue 生态 = Reka UI / shadcn-vue）+ 自有 token 皮肤【预判】；b) 全
  自绘（87 现状路线，成本在前端组件细节）；c) 成品库（直接出局，风格不受控）。
- **A3-D5 密度与可访问性【提案，待裁决】**：

  - **D5-a 密度策略【已定 = 接受推荐，2026-11-22 凌晨】**：
    均不暴露（"对齐 Chrome"的自然推论）；87 线"大留白"是自由生长的副
    产品，token 化后 spacing ramp（4px 基数）自然给出紧凑节奏，不需要
    "compact 模式"这种二级开关。UI 不随页面 zoom 缩放（Chrome 同款）；
    150% DPI 由 OS 缩放 + 自证帧体系承接（C1.4），UI 层零自造缩放。
  - **D5-b 焦点环与键盘导航【已定，2026-11-21 用户条件确认（"能改善就对
    齐"→ 三项改善成立，采纳）】**：87 线焦点环被逐个关闭的三个根因均有
    官方解——①圆角不匹配 = Chromium 87 outline 不跟随 border-radius
    （Chrome 94 原生修复，E39 直接受益）；②显眼 = 改 Fluent 两层描边
    focusStrokeOuter/Inner（低调定位对比度，token 驱动明暗自适应，弃
    浏览器默认粗框）；③鼠标点击弹框 = 全线改 `:focus-visible`（鼠标
    永不显示，键盘 Tab 才出现）。键盘导航由 Reka UI 白送的 WAI-ARIA +
    焦点管理承接（D4），B4 操作集全对齐 Chrome 的 UI 层落地在此。
    **铁律：禁 `outline: none` 无替代移除、禁 `:focus` 显示焦点环。**
  - **D5-c 动效与可访问底线【已定 = 接受推荐，2026-11-22 凌晨】**：
    transition 加媒体查询守卫）；对比度 AA 由 Fluent neutral 体系官方
    背书（D1）；动效时长统一 fast 120ms / normal 180ms 两档（token 化，
    禁散装时长）。

**建议讨论顺序**：D1（基调）→ D2（token）→ D4（基座）是语言层；D3（骨架）
要可交互稿配合；D5 收尾。

**A3-D2【已定 = Fluent 三档 token 架构，CSS custom properties 载体】
（2026-11-21 用户确认）**

- **三档**（官方同构）：global（原始 ramp，组件禁直用）→ alias（语义层
  CSS custom properties，`--color-neutral-bg-1` 等，组件唯一可见层）→
  component（个别覆写，少用）。
- **载体**：`tokens.css` 单文件，light/dark 各一块 alias 声明，
  `[data-theme]` 属性切换——明暗组件只写一份，`body.dark` 双写税消灭；
  nativeTheme 变化只切属性（D 区主题服务广播）。
- **形态待核（D4 后细化）**：手写 tokens.css + stylelint 禁裸色值校验
  【倾向】 vs 脚本从 @fluentui/tokens 生成。

**A3-D4 组件基座【提案，待裁决】（2026-11-21 联网核实）**

- **核实结论**：Reka UI（原 Radix Vue，v2.10+，MIT，2026-11 仍活跃）= Vue
  生态 headless 事实标准——40+ 无样式原语（Dialog/AlertDialog/Popover/
  ContextMenu/DropdownMenu/Tooltip/Tabs/Select/Combobox/ScrollArea/Toast/
  Calendar…），WAI-ARIA + 键盘导航 + 焦点管理内建，Floating UI 定位，
  data-state 样式钩子，Listbox/Tree/Combobox 虚拟化，Portal；shadcn-vue
  即构建于其上。
- **提案 = Reka UI 基座 + shadcn-vue 模式（copy-in 皮肤）+ Fluent alias
  token 皮肤**：组件代码复制进仓库（可改、无上游锁死），样式全部走 D2
  alias token——等价于"Fluent 2 皮肤的 shadcn-vue"。官方 Fluent UI React
  v9 不必也不可迁（React 库）；我们只取其行为语义参考。
- **边界（与 B1/A5 衔接）**：Reka 只管 DOM 层组件（侧边栏/工具栏/书签栏/
  设置页/面板）；**需要覆盖页面的浮层走 A5 对话框服务（子 WCV）**，其
  Vue 组件复用同一套 token 皮肤——两套渲染载体、一套视觉语言。
- **图标**：Fluent UI System Icons（微软公开 SVG 集）生成 Vue 组件
  （或用 unplugin-icons 直载 SVG）——与 React 图标包无关。
**D4 多方比对【2026-11-21 用户要求补充核实】**：三方案横评
（Headless UI Vue 版组件仅 ~10 个，开局出局）：

| 维度 | Reka UI（原 Radix Vue） | Ark UI（Zag.js） | 全自绘 |
|---|---|---|---|
| 维护 | 活跃（v2.10+，2026-11 提交） | 活跃（Chakra 团队，Chakra v3 地基） | 自己扛 |
| 组件目录 | 40+（浏览器壳全覆盖） | 45+（多 Toolbar/GridList/Hotkeys/级联选择） | 全部自己写 |
| 行为模型 | Radix API 模式 | **Zag.js 有限状态机**（行为可预测性最强） | 手写 |
| 引擎重量 | 轻 | **~100KB Zag.js 运行时**（外壳常驻） | 最轻 |
| 生态 | **shadcn-vue 基座**（copy-in 皮肤生态最大） | Park UI/Vuzeno | 无 |
| 安全记录 | 无已知向量 | **2026-08 TagsInput innerHTML XSS**（5.38.2 修复；浏览器外壳对向量敏感） | 自己背 |
| 跨框架 | 仅 Vue | React/Vue/Solid/Svelte（本项目无用：Next 与 Modern 同为 Vue） | — |
| 学习曲线 | Radix 模式（语料多，AI 协作质量高） | 状态机心智（调试需懂 Zag statechart） | — |

**比对结论【维持 Reka UI】**：Ark 的真优势（跨框架、状态机可预测性）对
本项目权重低——单 Vue 栈跨框架无用；100KB 常驻引擎 + XSS 历史 + 状态机
心智负担是实代价；Reka 的 shadcn-vue copy-in 生态与 AI 语料优势（A1 同款
权重）对本项目更重。Ark 的 Toolbar/GridList 若未来需要，单件参考其 Zag
机实现不构成锁定。

**A3-D4【2026-11-21 用户裁决：两案并存，待后续选定】**——Reka UI（推荐
意见，比对结论如上）与 Ark UI（备选，状态机可预测性 + 更全组件目录）
均保留为候选；全自绘与成品库出局结论不变。后续选定触发点：D3 骨架定型
或 A 区组件清单落地时一并裁决。

- **否决项**：c) 成品组件库（风格不受控，与 D1 冲突）出局确认；b) 全自绘
  无必要（无障碍/键盘/焦点管理是 Reka 白送的核心价值，自绘 = 重复造这个）。

### A4 工程化【已收官 2026-11-22，D1~D5 全定】

**87 线现状盘点（源码核对）**：三 tsconfig（main/renderer/preload）分别
typecheck；vitest 双 project（unit/integration）+ coverage；Playwright
（渲染层 E2E）；smoke runner（run-smokes.cjs 分包冒烟）；verify-release
分阶段校验（source → unpacked 两级）；benchmark 门禁体系（vision/OCR
语料生成 + gate 脚本，钓鱼钩检测等）；GitHub Actions（ci.yml + mac 实验
包 workflow）；electron-builder 三平台脚本（BAO_MODULES 模块裁剪构建：
full/minimal/no-automation/no-userscripts）。底子扎实，痛点 = 脚本爆炸
（package.json 60+ 脚本）、模块裁剪靠环境变量拼接、i18n 双体系
（typesafe-i18n 将随 C3 换 vue-i18n）。

**A4 议程分解（五个裁决点）**：

- **A4-D1 仓库形态与 Modern 分支落地方式【已定 = Modern 暂缓】**——
  **2026-11-22 用户裁决：Modern 暂不开设**，待 Next 基地落定后再考虑
  跟进——Modern 追最新内核涉及大量 Electron 破坏性变动，Next 基地自身
  稳定前不做双 flavor 前置建设（为不存在的第二产品付维护税，违反 YAGNI）。
  **载体留档**：届时若开设，倾向同仓 build flavor（a 案：一套源码 +
  flavor 开关，摘 PPAPI 模块 + 换原版 Electron 依赖 + 换命名，CI 两路
  产物）而非 git 分支 fork（cherry-pick 搬运血泪教训）——该子裁决届时
  随 Electron 版本迁移时机一并再确认，现在不锁。仓库现阶段 = 单一
  flash flavor，无 flavor 管道。
- **A4-D2 构建链与类型安全【已定 = electron-vite 统一链】（2026-11-22
  用户指出 esbuild 主进程选型是 E11/Node12 时代约束的遗产，重新核实后
  改推统一链，速度疑虑澄清后定案）**：

  - **核实结论（2026-11-22 联网）**：①**electron-vite v5 + rolldown-vite
    （Vite 7.3+/Vite 8 底座）**已是 Electron 统一构建的事实标准——
    main/preload/renderer 一个配置文件、主进程热重启、preload 热重载、
    Vite 生态全兼容（vue 插件/unplugin-icons/ vitest 同源）、worker/
    child/utilityProcess 经 import 后缀直达（C1.7 沙箱 utilityProcess
    天然对口）、V8 bytecode 源码保护可选；生产实践充足（v5 + rolldown
    7.3 + vue-tsc 真机项目在用）。②**Node 原生 type stripping**
    （22.18+ 默认开，E39=22.20/22.22 满足）可零打包直跑主进程 TS，但
    erasable-only 限制（禁 enum/namespace/参数属性/路径别名）、preload
    仍须 JS 一步转换、无 tree-shake、启动性能未证——novel 但不适配
    BFB 的重依赖主进程。③esbuild 散装双配置（87 模式）= 两份配置、
    两套 dev 命令、60+ 脚本爆炸的直接原因。
  - **提案 = electron-vite 统一链**：一个 `electron.vite.config.ts` 管
    main/preload/renderer 三目标；dev 一条命令全起；插件链与 vitest/
    Reka UI 工具链（unplugin-icons 等）同源；BAO_MODULES 裁剪改由
    config 的 define/条件入口表达（治脚本爆炸）。**IPC 协议层类型化**
    保留——A2 命令/投影协议在 `src/shared/protocol/` 建单一事实源
    （TS 类型 + zod schema 同源），三端 import 同一份，编译期断线
    （ADR-0002 IPC 行"zod 校验保留"升级为协议级）；tsconfig strict
    全开沿用。ADR-0002 构建两行的"esbuild/tsup"候选同步作废。
- **A4-D3 测试体系与探针工程化【已定 = Vitest 全家桶 + @wdio/electron-service
  E2E】（2026-11-22 用户要求"不考虑熟练度/个人能力"纯技术重评，E2E 层
  推荐翻转）**：

  - **四层栈（终版）**：
    - **unit / 组件层 = Vitest + @testing-library/vue + MSW**（mock 网络）。
      WDIO 不做组件测试，此层与 E2E 选型无关、两案零分差。
    - **integration 层 = Vitest + node:sqlite `:memory:` 真件**（C5 SQLite
      迁移单测直接喂真库，不造 SQL 假件，Java mock 式的对应物）。
    - **E2E 层 = @wdio/electron-service（WebdriverIO 官方 Electron
      service）**——Electron 启动/二进制探测 + **Electron API mock 内建**
      （可在真 app 内 mock 任意 main/preload/renderer API）+ 主进程
      `execute` 直达。Playwright `_electron` 降为备选：半官方边角 API、
      无 API mock，仅当探针证明 WDIO 对 BrowserView 多标签建模不行、且
      CDP 驱动测试占比确实高（Playwright 的 `newCDPSession` 人体工学是
      其唯一真实加分项）时启用。
    - **smoke 沿用 + 探针升一等公民**——`tests/probes/` 目录 + probe 清单
      （manifest：名称/验证假设/前置条件/E39 批次归属）+ 统一 runner，
      【待核】挂账项自动映射到探针文件（自证帧/node:sqlite 冒烟/OOPIF/
      wc.debugger×openDevTools/flatten OOPIF/断连自愈/Flash 四项 + 新增
      WDIO×BrowserView 建模一项），跑通才允许对应设计落地（"不纸面
      放行"的工程化形态）。
  - **重评关键修正（纯技术，熟练度权重清零）**："成熟、被验证过、直接
    拿来用"的客观答案即 @wdio/electron-service——它消掉方案二里唯一的
    自建大件（E2E 层启动 + API mock）。
  - **假件工厂定位修正**：WDIO 的 API mock 作用于运行中的真 app，不作用
    于 Vitest 进程——unit/integration 层跑在纯 Node 里，`electron` 模块
    假件（百行级）仍然需要，但降级为"只兜 Vitest 边界"；原先靠假件覆盖
    的 main 模块真行为测试可上移为"真 app + mock API"的 E2E，假件覆盖面
    收窄。
  - **挂账 E39 探针（新增）**：WDIO electron-service 对 BrowserView/多
    标签内容的定位与操作建模——两案共同未知数，纸面不可解决，最终裁决
    的唯一剩余变量。
- **A4-D4 CI 矩阵与大件分发【已定】（2026-11-22 用户接受推荐；Modern
  暂缓后"随 flavor 而不同"作废，单一 flavor）**：

  - **分层矩阵**：PR = typecheck+lint+unit；main = +integration+smoke
    + **CI 可跑探针**；tag = 三平台产物（win/linux 正式，mac 实验位
    维持）+ verify-release 两级校验。**探针按 manifest 标 `ci: true/false`
    双分**——纯逻辑类（node:sqlite 冒烟、flatten OOPIF 等）挂 main 层；
    需真机显示/Flash 素材/真实键鼠的（视觉、Flash 四项、WDIO×BrowserView）
    标 local-only，CI 严禁执行。原则：宁可 CI 少跑，不可假绿。
  - **Flash Electron 大件（~200MB）**：专用 Release 资产 + CI 拉取 +
    sha256 校验 + actions/cache 缓存。自编译 Electron 每次升级发一次
    tag 资产；CI tag 构建下载 → sha256 校验（版本不符直接 fail，不静默
    用旧件）→ 缓存（远低于 10GB 上限）。**CI 只用不编**：Chromium 自编译
    周期天级、依赖本地工具链，进 CI 是伪命题；本地编 + 手动发资产。
    备选（自建镜像/对象存储）仅当 Release 下载速度不可接受时启用。
    （tag 命名与 Release 消费按产品线前缀区分，见 D5 仓库形态修正——
    Next 与 87 旧线同仓独立分支，两条发布线互不污染。）
  - **E2E 首期不进 CI**：runner 有真实桌面会话，Electron+WDIO 理论可跑，
    但等 BrowserView 建模探针真机通过、本地 E2E 稳定后再评估上 main/tag
    层——不为未验证的层付 CI 调试税。
- **A4-D5 发布与更新【已定 = 同仓双线发布 + 签名搁置】（2026-11-22
  用户修正两处：①Next 与旧项目共用同一仓库独立分支，而非新建仓库；
  ②签名搁置）**：

  - **仓库形态修正（影响 D4/D5 两节）**：Next 与 87 旧线共用
    BaoFlashBrowser 仓库，Next 在独立分支演进。CI/发布按**产品线前缀**
    区分：旧线 tag 与 Next 线 tag 各用前缀命名，workflow 按 tag 过滤
    触发，两条发布线的 Release 资产互不消费。
  - **更新机制修订（原 C3 平移的"拒 draft+prerelease"不再一刀切）**：
    拒 draft 不变（未发布，本就不该消费）；"拒 prerelease"改为**按产品线
    channel 过滤**——同仓多产品线下 Next 的 release 大概率挂 prerelease
    标，更新源只消费 Next channel 的 release 列表，产品线内 prerelease
    不再拒。其余不变：只提示不自动装 / 启动查一次 / 不上传本地信息。
  - **发布与校验沿用**：electron-builder（BAO_MODULES 裁剪已随 D2 改
    config 表达）+ verify-release 两级校验（source → unpacked）沿用。
  - **签名搁置**：捆绑 PPAPI 的前提下证书获取存在不确定性，签名先放着
    ——不采购证书，electron-builder 签名配置留空不报错，SmartScreen
    首启拦截接受。Windows 证书选型 / macOS 签名（Keychain 依赖 C4
    挂账）统一挂 E3 届时再议。

### A1 论证：外壳框架选型（2026-11-21）

**外壳的负载特征（选型基准）**：重状态（标签树/下载/自动化事件流/密码）+ 高频 IPC 订阅
（下载进度、自动化事件）+ 复杂布局（标签条/侧边栏/面板）+ 长生命周期不刷新 + 单人 + AI 协作
开发模式。**不是内容型网站**——SSR/RSC 等 React 新特性全部无关，React 在这里只当
"UI 运行时"用。

| 维度 | React 19 | Vue 3 | Svelte 5 / Solid |
|---|---|---|---|
| 高频更新成本 | VDOM diff；React Compiler 自动 memo 缓解 | 细粒度响应式，天然好 | 信号模型最优 |
| 状态管理生态 | Zustand/Jotai 成熟，与 IPC 订阅模式契合极佳 | Pinia 成熟（weblog 已用） | 各家 store 自带，但第三方少 |
| 生态与组件基座 | 最大；Radix/Headless 等 headless 原语丰富（浏览器壳是定制 UI，要的是 headless 而非成品库） | 中；shadcn-vue 可用 | 最小 |
| **AI 协作质量** | **训练语料最多，AI 生成/排错质量最高**（单人 + AI 是实际工作流） | 中上 | 语料少，AI 出错率高 |
| 长期单仓风险 | Meta 背书 + 巨大社区，十年期最稳 | 良好 | 历史 breaking 迁移痛（Svelte 4→5 runes）；Solid 生态单薄 |
| 团队知识 | 原项目 React 经验 | weblog Vue 3 经验 | 无 |
| 与 Modern 共享 | 同栈共享 ✓ | 同栈共享 ✓ | 同栈共享 ✓ |

**结论【已定 2026-11-21：Vue 3】。** 决策过程：AI 初选 React 19（理由见上表），用户依
预置翻案条件第二条否决——**主场项目均为 Vue（weblog 线验证），React 仅本项目实践过且
用户自认完全不懂 React**。此翻案成立并连带推翻 AI 第一权重论据：单人模式下 AI 生成的
React 代码再地道，无法被用户审计与独立排错，语料优势变负资产。框架选型最高优先 =
"你十年不烦"。
Vue 3 的落点：Pinia（weblog 同款）进 A2；外壳热路径架构与框架无关（store 订阅模式不变）。

**历史溯源（补记）**：87 线的 React 是"版本级"选择而非"框架级"——唯一记载
`docs/archive/superpowers/specs/2026-07-28-baoflashbrowser-v2-design.md:622`
（"React 17 而非 18：Node 12 兼容性存疑"），React vs Vue 从未对比过，Vue 没进过赛场；
`docs/adr/0002-next-stack-baseline.md` 将 UI 框架挂"待定"（倾向 React 仅因 87 生态延续），
本次 A1 即对该悬案的正式收口。ADR 0002 已同步回写。

## A2+B3 合并结论【已定 2026-11-21】：命令/投影模式（Command / Projected State）

> 用户工作偏好（2026-11-21 记录）：Next 讨论一律按"最优优先、AI 放大产能"评估，
> 不以单人工程量/复杂度为约束。

**所有权与流向**：
- 唯一真值：主进程 TabStore（tabId 生成权、生命周期、激活态、会话持久化全在主进程）；
  渲染层**零本地标签真值**（根除 09-04 下载记录事故、DevToolbox tabId 撕裂两类教训）。
- 渲染层 Pinia store = 只读投影；组件一律从 store 读，绝不本地写标签字段。
- 上行全是意图命令（createTab/activate/close/reorder...），主进程应用后广播——
  渲染层 UI"收到投影才变"，不做"先改本地再等追认"。

**同步协议（最优版）：快照引导 + 细粒度 patch 流**：

```
附着/再同步:  main ── snapshot(全量, seq=N) ──▶ renderer
稳态:         main ── patch {seq, op, ...} ──▶ renderer
                op ∈ tab.added | tab.updated | tab.removed
                    | tab.reordered | tab.activated
缺口检测:     renderer 发现 seq 不连续 ── resync 请求 ──▶ main 重发快照
```

选型理由（按"最优"标准）：①单字段变更只发该标签 diff，无全量重序列化；②Pinia 收
patch 精确更新对象，无快照方案的对象树替换响应式抖动；③快照仍承担启动附着/缺口重同步/
崩溃恢复；④seq 单调 + 缺口自愈，任何丢包/乱序自动降级快照重发——封死状态漂移生存空间。

**高频流隔离**：下载进度、自动化事件走独立通道 + throttle + 独立 store，不进标签投影。

**待 B2 后议**：Jotai 原子化思路是否搬运 → 等标签页"对齐 Chrome"程度（B2）定了状态
形状后再议（用户裁定：顺序应为 B2 → B3 细节）。

## B. 标签页与多视图架构【U】

- B1. **视图容器选型**【A】：**【已定 2026-11-21】WebContentsView**。三选一收束：
  - `<webview>`：否决。【事实】历史实证
    `docs/archive/superpowers/specs/2026-07-29-browserview-migration-design.md`——Electron 11 下
    webview 与 React UI 共享渲染进程，Flash 加载/卸载竞态触发 BrowserPlugin segfault，
    全窗口白屏；当年迁移 BrowserView 的核心理由即进程隔离。
  - **多窗口（每标签一个 frameless BrowserWindow 叠放）**：否决。工程税六项：同步移动抖动、
    焦点/激活模型跨窗口、视觉拼接露缝（违背 Chrome 质感目标）、生命周期膨胀、崩溃残留、
    生态零参照。
  - **WebContentsView**：当选。BrowserView 正统继任（`win.contentView.addChildView`，
    Electron 官方方向）；进程隔离全额保留（主进程持有、每标签独立渲染进程）；原项目
    BrowserView→WebContentsView 迁移摆动在 Next 不再重演。
  - **设计推论（约束后续 A/B 区）**：
    1. **置顶约束存在但可化解，非"只能侧边栏"**（2026-11-21 补充细化）。外壳 DOM 永远画不过
       WebContentsView（合成模型同 BrowserView），但浮层有四件工具：
       ① 动态腾位（`setBounds()` 缩内容视图，页面会跳）；② 原生 `Menu.popup()`（OS 层，
       右键菜单正解）；③ 弹窗 BrowserWindow（复杂浮层）；④ **浮层本身做成子 WebContentsView**
       （HTML 自由样式 + 真覆盖 + 无跳动）。【修正 2026-11-21】④ 并非 BrowserView 做不到——
       BrowserView 时代一个窗口可挂多个 view（`addBrowserView`）且 `setTopBrowserView` 抢顶，
       单个下拉浮层可行；真实差距是**扁平栈 vs 视图树**：BrowserView 只有窗口级"谁在最上"，
       全部窗口绝对坐标；WebContentsView 支持 `addChildView(view, index)` 层级插入、
       子 view 相对父 view 坐标、View 树内混排原生 View（裁剪/圆角容器）。单浮层场景两者
       皆可，多浮层/嵌套菜单/跟手移动场景视图树优势才拉开。侧边栏只是"常驻面板"的
       永久腾位特例。
    2. **浮层策略矩阵**：地址栏建议下拉 → ④；右键菜单 → ②；常驻面板（收藏/历史/下载/密码）
       → 侧边栏；临时 toast → ① 或页面顶部区域。
    3. 页面级浮层活在页面里（右键菜单、站内弹窗）。
    4. 自动化/DevToolbox 沿用 `webContents` API attach 模式。
    - 交互演示：`artifacts/view-container-demo.html`（拖动窗口 / 历史浮层遮挡 / 标签切换对照）。
  - **为什么不全 WebContentsView 化（外壳 DOM 的存在理由，2026-11-21 追问结案）**：
    全 WCV 化 = 把进程边界切进外壳内部。代价：①每个 WCV 独立渲染进程，外壳 UI 内存
    从 ~0 变 150~400MB【推断，量级估计】；②外壳内部高频联动（拖标签/Ctrl+L/跨区域动画/
    状态共享）全部 IPC 化 + 跨进程状态同步；③布局动画降级为主进程 setBounds 编排；
    ④相邻原生视图拼接缝重现；⑤DevToolbox 已是"一块 UI 进独立 webContents"的成本样本
    （独立 preload/桥/replay 时序）。**外壳 vs 页面是最优切割线**：外壳内部交互密集
    （须同边界内侧），页面必须进程隔离（独立 WCV），外壳↔页面交互天然极少（本就是 IPC）。
    WCV 只负责两类：必须进程隔离的（页面）、必须盖住外壳 DOM 的（浮层）。
- B2. 标签状态机与 Chrome 对齐度【U】：**对比已落档（2026-11-21），待用户裁决对齐项**。
  事实源：87 现状 = `docs/modules/01-browser-shell-tabs.md`（1.1.2 版源码核对）。

### B2 对比表：87 现状 vs Chrome

| 维度 | Chrome（原生设计） | BFB 87 现状 | 差距评估 |
|---|---|---|---|
| 真值模型 | TabStripModel 单一主进程真值（C++），UI 全部投影 | **双层真值**：主 TabEntry（id/view/engine/zoom/mute/crashed）+ 渲染 TabState（url/title/favicon/loading/history/mute/zoom/suspended/audible） | ✅ Next 已在 A2+B3 根除（命令/投影） |
| 生命周期状态 | 三级：active → inactive（**frozen**：Page Freezing 冻结定时器/rAF）→ **discarded**（杀渲染进程，标签条保留 title/favicon，激活时重载） | 两级半：active → inactive（视图保留，HIDDEN_BOUNDS 隐藏）→ suspended（**销毁视图**，TabEntry 留字段） | 87 的 suspend = 直接跳到 discard，且**丢导航历史**（视图销毁 = NavigationController 没了）；Chrome discard 保留 session history，激活可回退 |
| 休眠触发 | Memory Saver：内存压力 + 可配置时长 + 用户豁免清单 | 固定 10 分钟 + 四条件门控（非 active/suspended/loading/audible） | 门控条件（audible 保护）是好结论，保留；缺冻结级与内存水位 |
| 后台节流 | 冻结级：定时器/rAF 暂停 | `backgroundThrottling:false`（为 Flash 游戏挂机全局关闭） | Next 改为**按视图类型**：Flash/自动化视图关，普通视图开（ADR 0002 已有此方向） |
| 会话持久化 | TabRestoreService：最近关闭 + 启动恢复（继续上次会话），未加载标签以占位符存在 | `tab-session.test.ts` 存在；启动恢复语义未在模块文档中明确 | 【待决】对齐程度 |
| 撤销关闭 | TabRestoreService 支持 undo close | 未记载 | 【待决】 |
| 标签操作 | pin、mute、duplicate、close others、拖拽重排、拖出/拖入窗口、tab groups、tab search | Ctrl+Tab/Ctrl+1-8 切换；new-window 由渲染层决定新开/当前导航；**无拖拽重排记载**、无 pin/groups/search 记载 | 【待决】逐项 |
| 崩溃恢复 | 标签级 Sad Tab + Sad Tab 挽救（reload） | crashed 标记 + 渲染层恢复页；外壳进程崩溃 3 次/30s 计数保护 | 87 方案对齐，保留 |
| 引擎语义 | N/A | PPAPI↔Ruffle 销毁重建 + 三重 token 校验 | BFB 特有，保留但重造 |
| 焦点模型 | 原生 Views 焦点链 | 两层焦点（文档焦点显式 focus() + 200ms 补调；PPAPI 插件焦点**已知不可程序化**，链路已回退留档） | PPAPI 焦点限制是内核约束非设计问题；文档焦点链在 WebContentsView 下重造 |

**【待核】**Electron 39 的 `webContents.navigationHistory`（getEntryAt/restore 类 API）能否
支撑"discard 保留导航历史"——若可用，Next 的 suspend 可升级为"保历史 discard"；
若不可用，需自存 history 数组在 TabEntry（重造 TabRestoreService 的最小子集）。

**B2 待裁决项 → 全部落定（2026-11-21，用户拍板）**：
1. **生命周期状态集**：✅ 对齐 Chrome 三级（active / inactive-frozen / discarded-保历史）。
   【待核】Electron 39 `webContents.navigationHistory` 能否恢复导航历史；不能则 TabEntry
   自存 history 数组（TabRestoreService 最小子集）。
2. **启动会话恢复**：✅ 要——"继续上次会话" + 未加载占位符式恢复（TabRestoreService 最小子集重造）。
3. **undo close**（Ctrl+Shift+T）：✅ 要。
4. **标签操作集**：✅ 全要（pin / mute / duplicate / close others / 拖拽重排 / 拖出窗口 /
   groups / search）。分期建议：一期 = pin/mute/duplicate/close others/拖拽重排/拖出窗口
   （标签条核心手感）；二期 = groups/search（独立子系统）。协议字段第一天留位。
5. **后台节流按视图类型**：✅ 可行已定——`webContents.setBackgroundThrottling()` 支持运行时
   切换；Flash/自动化视图创建时关，普通视图开；可做 inactive 动态策略。

**B2 方法论结论（用户自述教训，升级为铁律）**：87 线"对着 Chrome 抄但没看代码，仅按行为
抄了个四不像"——Next 的对齐**以 Chromium 源码为事实源**：本机 142 树
（`/d/electron-build-142/cr/src`）可直接研读 `chrome/browser/ui/tabs/tab_strip_model.cc`、
`chrome/browser/resource_coordinator/lifecycle_unit*`、`components/sessions/`（TabRestoreService）。
每个状态机结论对着源码核，不靠行为观察反推。

- B3. 标签状态管理【A】：所有权已在 A2+B3 合并议题结案（主进程唯一真值 + 渲染层只读投影 + 意图命令）。**细节设计已落档（2026-11-21，待确认）**，四个组件：

### B3 细节设计

**① 主进程 TabEntry 字段清单**（每条可追溯 B2 裁决）：

```ts
TabEntry {
  tabId: string                  // 主进程生成、全局唯一、永不复用
  createdAt: number
  state: 'active' | 'inactive' | 'discarded'   // B2-① 三级
  lastActiveAt: number
  url: string; title: string; favicon: string   // 导航投影
  isLoading: boolean
  canGoBack: boolean; canGoForward: boolean
  navHistory?: NavHistoryEntry[] // discard 保历史自存位（navigationHistory 待核）
  viewType: 'normal' | 'flash' | 'automation'  // B2-⑤ 按视图节流依据
  audioMuted: boolean; zoomLevel: number; crashed: boolean
  pinned: boolean                // B2-④ 一期
  groupId: string | null         // B2-④ 二期 groups 留位
}
```

**② patch 载荷 schema——字段级部分 diff，单通道**：

```ts
{ seq, op: 'tab.added'|'tab.updated'|'tab.removed'|'tab.reordered'|'tab.activated',
  tabId, fields?: Partial<TabEntry> }   // updated 只带变更字段
```

不按字段拆多通道的理由：Pinia 响应式是精确的，精确性在 store 内部解决，不需要协议层
拆通道；单通道 + 字段级 diff = 协议最简、更新最精的交点。

**③ 渲染层 Pinia store 形状**（只读投影落地；**已按 B4-① 修正为多窗口就绪**：
`entries: Map<tabId, TabView>` 全局 + 每窗口 `order`/`activeId`，详见 B4-①）：

```ts
tabsStore:
  entries: Map<tabId, TabView>   // O(1) 定位，patch 直接改对象（全局真值）
  // 每窗口: order: tabId[]（拖拽重排只动数组不动对象）、activeId
  seq: number                    // 缺口检测器
  computed: pinnedTabs / unpinnedTabs / visibleOrder
  actions: 全部是命令发送器（ipc 包装），零本地字段写
```

**④ UI 瞬态边界**：hover、拖拽 ghost 坐标、右键菜单开关等**不进投影协议**（组件本地或
独立 UI store）。判据：**主进程重启后还需存在的 → 投影；纯视觉瞬态 → 本地**。
防止 TabEntry 被 UI 细节污染。

**⑤ 上行命令清单**（与 B2 操作集一一对应）：
`tab.create / activate / close / reorder / pin / mute / duplicate / closeOthers / restore / navigate(url|back|forward|reload|stop)`

### B4 设计【已结案 2026-11-21】

**① 连带发现：B2"拖出窗口"⇒ Next 必然多窗口，B3 结构修正**：

```ts
TabStore { windows: Map<windowId, WindowState>; entries: Map<tabId, TabEntry> }
WindowState { windowId; order: tabId[]; activeId: tabId | null;
              bounds; state: 'normal'|'minimized'|'maximized'|'fullscreen' }
```

标签真值全局唯一（标签属于 app，寄居某窗口）；激活态/顺序移入 WindowState。
patch ops 增 `window.added/removed/boundsChanged/activated` + `tab.movedToWindow`。
**一期即使只做单窗口，结构按此设计**（拖出窗口是 B2 已定的必然需求）。

**② B4-1 标签条形态【已裁决 2026-11-21：A 顶部横条（一期）】**
vs 垂直标签条（可折叠分组、标签多时显示完整 title）。
【2026-11-21 用户纠正 + 联网核实】垂直方案"参照少"劣项**已过时删除**：
Chrome 146（2026-03 stable）已原生垂直标签（左面板/可折叠分组头/favicon 收缩态/
hover 展开/内置搜索按钮），Edge 2021、Firefox 2025-03 更早。**两形态均有一线参照，
纯交互品味题，无技术倾斜**。另：Chrome 垂直面板自述缺口（无 workspace/会话快照/
键盘搜索面板）对我们无约束——我们本就自建会话恢复（B2-②）与搜索（B2-④ 二期）。

**结案语**：选 A 不构成架构死锁——TabStore/投影协议（B3）与形态解耦
（Firefox/Chrome 146 均为"同一份数据、两种视图"），将来加垂直模式 =
渲染层新组件 + 设置项，**主进程与协议零改动**。垂直模式留位为后续视图选项。

**③ B4-2 手感清单【默认通过 2026-11-21：全对齐 Chrome】**：中键关闭 / 双击空白新建 /
滚轮悬停标签条横向滚动 / Ctrl+Tab 循环、Ctrl+1..8、Ctrl+9 / 拖拽重排带插入位动画 /
拖出阈值分离新窗口 / 拖到 pin 区自动 pin / pin 窄化+拖出保持 pin /
audible 图标点击=静音 / discarded 灰显保 title+favicon / crashed 恢复入口 /
右键菜单=Chrome 全集+特有项（休眠此标签、Flash 视图操作）。
明确不对齐：标签关闭滑动收缩动画——一期从简，二期补。
- B5. 原项目标签差错教训清单【A】：**草案已落档（2026-11-21），待用户补一条根因**：

### B5 不重蹈清单（草案）

**负面清单（Next 必须结构性根除，每条标注根除方案）**：

| # | 87 线教训 | 事实源 | Next 根除方案 |
|---|---|---|---|
| 1 | 双层标签真值：渲染层先变、主进程后跟（DevToolbox tabId 探测 effect 被迫依赖双状态源） | memory + 12-devtoolbox §9 | A2+B3 命令/投影：单真值 + seq 缺口检测 |
| 2 | 对 Chrome 只抄行为不看源码，抄成四不像 | 用户自述（B2） | 源码事实源铁律：每个状态机结论对着 142 树源码核 |
| 3 | suspend = 销毁视图，导航历史清零（比 Chrome discard 更狠） | 01-browser-shell-tabs | B2-① 三级生命周期，discard 保历史 |
| 4 | backgroundThrottling 全局 false，普通标签裸奔 | memory | B2-⑤ 按视图类型（setBackgroundThrottling 运行时切换） |
| 5 | webview 共享渲染进程：Flash 竞态 segfault 全窗白屏 | 2026-07-29 迁移设计 | B1 WebContentsView 进程隔离 |
| 6 | 下载记录渲染层 IndexedDB 参与推导实时状态，把进行中改成 interrupted | 09-04 事故 | 主进程唯一权威源（数据流约定延续，C5 扩展到收藏/历史/设置） |
| 7 | 捕获挂 did-stop-loading、detach 后只下一次加载重挂——时机脆弱 | password-capture-diagnosis | Next 生命周期钩子设计避开"一次性挂载"模式 |
| 8 | 观测日志 tabId.slice(0,6)：时间戳型 id 全显示 tab-17 | 12-devtoolbox | tabId 设计规范：观测侧派生稳定短名或用完整 id |
| 9 | UI 瞬态污染真值风险（预防性） | B3-④ | 投影/本地判据铁律 |
| 10 | **标签模型歪 → userscript 平台被迫写中间层**：GM_* 体系照抄油猴，而油猴语义建立在 Chrome 标签模型之上——想直接对齐就必须标签实现与 Chrome 一致，否则每接一项 tab 相关能力都要垫适配中间层（实际写了中间层，平台异常吃力） | 用户自述（2026-11-21，文档此前无记载） | 教训 #2 的下游代价案例：标签模型按 Chrome 源码对齐（B2 铁律）后，userscript 层**直接对齐油猴语义，零中间层** |

**正面清单（87 的好结论，Next 照抄思路）**：
1. audible 门控休眠（正在出声的标签不许休眠）；
2. crashed 标记 + 恢复页入口；
3. 外壳渲染崩溃 3 次/30s 熔断计数；
4. `did-fail-load` 绝不 `stop()`；
5. `isLoading` 以 dom-ready 结束判定（而非 load 全套事件）；
6. 事件三重 token 校验（防过期异步事件写脏状态）；
7. 侧边栏常驻挂载三态 + transition 宽度动画（GPU 首栅格结论一并继承）；
8. userscript 沙箱架构本体（preload 同步快照 + run-at 四档 + 显式主世界 page bridge）——平台最终搭成，此架构是正面资产，Next 换 WebContentsView 后对应面重验。

## C. 模块清单【U 议题 3，A 补全条目】

- C1. 自动化【U 点名】：**提案已落档（2026-11-21，待确认）——三色账目 + 5 决策点**：

### C1 提案：三色账目

**总原则**：Core+V3 是 2026 年刚设计并经钓鱼包实战验证的架构，重造无收益；
但大量实现面与 BrowserView/87 运行时绑定，借 Next 换代升级。

| 色 | 内容 | 处置 |
|---|---|---|
| 🟢 架构合同层直接继承 | Core 分层（geometry/surface/locator/action/workflow-ir/runtime）、双通道（Blockly + JS/TS 沙箱）、`bao.*` 固定合同、沙箱预算、grant/broker 权限、`.baoauto` v3 包格式与校验、CDP 租约互斥、OCR 三语义、运行状态机与落盘日志 | 架构合同平移，实现按 Next 重写 |
| 🟡 绑定层重验重写 | browserview-core-session → WebContentsView 版、FrameGeometry 对新视图体系重验、game-surface-detector 绑定、页面助手双通道、Blockly 编辑器 → Vue 3 | 接口面不变，实现换血 |
| 🔵 升级机会 | D2 OCR / D3 OpenCV / D4 队列 / D5 沙箱 | 决策点 |

**决策点裁决（2026-11-21 深夜）**：
- **D1【已定，推翻 AI 推荐】包格式/IR/bao.* 合同全部重新设计**——用户定位：当年
  "想到哪设计到哪，有太多不足和妥协"，Next 正是清零窗口。旧 .baoauto 包不兼容。
- **D2【已定】仅 64 位**：不发 ia32（32 位用户留在老项目），OCR 双引擎退役，
  OCR 方案在视觉平台重设计中重议。
- D3~D5 并入"视觉平台与沙箱重新设计"议题（用户要求重点讨论）。

### C1.1 视觉平台重新设计【重点议题，调研已完成 2026-11-21 深夜】

**参照体系调研**：
- **大漠插件**（按键精灵生态，成熟度天花板）：RGB/HSV 双模式 + 差色识别、多颜色混合
  （10 种）、多点找色、点阵模糊识别（防杂点）、连体字、**像素点阵字库**（自制字库
  识别像素字体，无需通用 OCR）、前后台键鼠（窗口消息/DX）、窗口随动提示框。
  → 浏览器内天然"后台"（不依赖 OS 句柄），大漠的 gdi/dx 后台模拟在我们这里不存在，
  这是 Web 自动化的天然优势。
- **Airtest**（网易，Apache-2.0）：Template 九宫格定位点 target_pos + threshold +
  record_pos（参考分辨率）、TM_CCOEFF_NORMED、**keypoint_matching（SIFT，旋转/缩放
  鲁棒）**、loop_find（超时循环匹配）、**多设备并行**（set_current/device()）。
- **Electron 39 线相关事实**【待核/候选补丁】：
  - #52844（backport 仅到 42/43/44，**39 线没有**）：hidden 窗口下
    `setBackgroundThrottling(false)` 后 show() 可能 blank——修复用
    `ShowWithVisibility(kHiddenButPainting)`（hidden-but-captured 路径）。
    → Next 若遇到"最小化再还原后挂机画面白屏"，此补丁是第一候选。
  - #54311（同不回 39 线）：false→true 切换后 hidden 页面残留全速渲染。
  - **WebPreferences 文档语义**：窗口内任一 webContents 关节流 → **整个窗口所有
    webContents 出帧交换**。对多标签挂机是双刃：保证挂机标签出帧，但无法按标签
    独立节流节能。

**能力矩阵【提案，待逐项裁决】**：

| 能力 | 87 现状 | 参照来源 | Next 提案 |
|---|---|---|---|
| 模板匹配（缩放档位） | ✅ scales 数组 | — | 保留；缩放敏感问题由关键点匹配补 |
|---|---|---|---|
| 模板匹配（缩放档位） | ✅ scales 数组 | — | 保留；缩放敏感问题由关键点匹配补 |
| **关键点匹配（ORB/SIFT）** | ❌ | Airtest keypoint_matching | **新增**：旋转/缩放鲁棒定位；ORB 优先（轻），opencv.js 4.x 含 features2d |
| 多点找色 | ✅（大漠风格） | 大漠 | 保留；增 HSV 模式 + 差色（光照鲁棒） |
| 多颜色混合 | ❌ | 大漠（10 种） | 新增：一次找多色 |
| 多模板组/findAll | 部分（firstOf） | 大漠多图/Airtest | 新增 findAll 语义（全部命中，不只是首个） |
| OCR（通用文本） | sidecar Paddle/Tesseract | — | **重议**：仅 64 位后统一引擎；wasm 化（tesseract.wasm SIMD，免平台门槛）vs 保留 Paddle sidecar（性能） |
| **点阵字库识别** | ❌（用整块模板替代） | 大漠字库 | **新增候选**：Flash 像素字体自制点阵字库——钓鱼结论"像素字 OCR 不可靠"的正解，免 OCR 引擎 |
| 区域变化检测 | ✅ region-change-detector | — | 保留 |
| 等待语义 wait | ✅ 轮询 | Airtest loop_find | 保留，语义对齐 |
| 九宫格定位点 | 部分（anchor+offset） | Airtest target_pos | 语义对齐即可 |
| 键鼠 | ✅ 可信输入（CDP） | 大漠 | 增 swipe/滚轮/拖拽动作齐套；浏览器内天然后台 |
| **多标签并行挂机** | ❌（一次一个前台标签） | Airtest 多设备 | **核心重设计**，见下 |

**多标签并行挂机——三大架构要素**：
1. **CDP 租约粒度重设计**：87 线全局单租约（与密码捕获互斥的锁）是"一次只能挂一个
   标签"的根因之一。Chromium 支持**不同 webContents 并行 attach**（每个 webContents
   独立 debugger 实例）——Next 租约改按 webContents 粒度，密码捕获互斥只作用于
   同一 webContents。
2. **出帧保障**：B2-⑤ 按视图类型关节流（已定）+ 窗口级联动语义兜底 +
   #52844 kHiddenButPainting 路径【39 线无此修复，候选 fork 补丁】。
   WebContentsView 模型下 inactive 标签仍 attached（只被盖住），visibility 语义
   【待实测】。挂机页生命周期门控：B2 状态机的 frozen/discarded 排除条件增加
   "automation-running"（与 audible 门控同级）。
3. **调度并行化**：串行队列 → **标签亲和队列**（每标签一条 FIFO，互不干涉）+
   全局 Worker 池上限 = CPU 核数；识别时延按标签隔离。

### C1.2 五项新增能力——逐项裁决单（2026-11-21 深夜）

**N1 点阵字库识别【强烈推荐新增】**
- 原理：字符 → 二值点阵条目（0/1 + 偏色容差），识别 = 点阵滑动匹配，命中即输出字符。
- 价值：**钓鱼教训的正解**——"像素字 OCR 不可靠、只能整块字牌模板"的根因是通用 OCR
  不认识像素字体；点阵字库正是为此设计的。且数值场景（读血量/金币/倒计时）逐字符
  识别，不再需要为每个数值做整块模板（87 线钓鱼被迫整块模板的直接原因）。
- 成本：算法本身 ≈ 二值化 + 快速模板匹配（可进现有 Worker 池）；**真正的投入是字库
  制作工具链**（截图 → 框选字符 → 标注 → 入库 UI），可挂在现有取材界面上。
- 定位：locator 新类型（`text-bitmap`），字库存 .baoauto 包 assets。纯像素算法，
  **无引擎依赖**，与 OCR 引擎终选解耦——即使 OCR 全 wasm 化，点阵字库照常工作。

**N2 关键点匹配 ORB【推荐新增，定位为兜底档】**
- 原理：FAST 关键点 + BRIEF 描述子 + RANSAC 仿射估计 → 旋转/缩放/部分遮挡下仍可定位。
- 定位：**不替代模板匹配**——Flash 素材多为固定比例位图，模板是主路径；ORB 作为
  `auto` 路由的升级档（模板置信度不足 → ORB 兜底），类似现有"颜色召回 + 结构复核"
  的路由思想。风险：小模板（<50px）关键点不足，效果差——所以只做兜底不做主路径。
- 成本：opencv.js 4.x features2d 自带 ORB；主要是路由接线 + 仿射后坐标换算。

**N3 HSV 模式 + 差色识别【推荐新增】**
- 原理：HSV 分离色相/明度，H 通道容差对亮度变化鲁棒；差色 = 用两色差值匹配，
  抗整体亮度漂移（大漠语法 `RRGGBB-偏RR偏GG偏BB` / `H.S.V-偏H偏S偏V`）。
- 成本：颜色空间转换 + 找色谓词从 RGB 欧氏距离扩展为三模式（RGB/HSV/差色），
  算法面改造小；找色 DSL 借鉴大漠紧凑格式。

**N4 多颜色混合【推荐新增，实现简单】**
- 原理：一次全图扫描同时匹配多种颜色（谓词数组），返回各色命中集合——省 N-1 次全图扫描。
- 成本：在多点找色的 pass 内扩展谓词数组，实现最简单的一项。

**N5 findAll 语义【推荐新增】**
- 原理：模板/颜色命中返回**全部**超阈值结果（NMS 非极大值抑制去重），不只首个。
- 价值：多目标刚需（钓鱼多鱼体同时追踪、数物件、清点 UI 元素）；87 线只能循环
  firstOf + 排除已命中区域，既慢又脆。
- 成本：matchTemplate 结果全扫描 + NMS，Worker 内标准做法。

**裁决汇总**：五项全部推荐新增；N1（点阵字库）是含金量最高也含工具链投入的一项，
N4/N5 是低垂果实，N2 定位为兜底档不碰主路径，N3 是找色体系的三模式扩展。

### C1.3 尺度/旋转不变子体系【2026-11-21 深夜，用户挑战后修正】

**用户挑战**：上述五项抗缩放旋转能力都不强——成立。87 线 scales 数组 = 离散枚举档
（邻档回退碰运气），N2 被压成兜底档。修正：尺度/旋转不变性独立成子体系，四个层次：

**L1 金字塔连续缩放模板匹配（主路径升级，替代 scales 枚举）**
- 原理：粗到细金字塔扫描——低分辨率层在连续缩放范围粗定位，高分辨率层局部窗口精验。
  把 87 的"取材记录 viewport transform + 参考倍率推导快速档"从离散档升级为
  **连续范围 + 先验收敛**：参考倍率给中心，金字塔给搜索半径，early-exit 控制成本。
- 对 Flash 场景的针对性：素材固定比例，唯一变量是窗口缩放——连续缩放直接覆盖
  "任意窗口尺寸"，不再依赖素材作者预估档位。
- 成本：Worker 内算法升级；取材端记录先验（参考倍率 ± 容差）已有基础。

**L2 SIFT/AKAZE 特征匹配（旋转 + 大场景定位，替代 N2 的 ORB 兜底定位）**
- SIFT 专利已过期（OpenCV 4.4 起入主线），尺度不变性完整（全尺度空间极值检测），
  优于 ORB 的有限金字塔层。AKAZE 备选（更快、也可仿射不变）。
- 适用：大模板/场景级定位（游戏画面一角而非 30px 小图标）、带旋转的元素。
  小图标场景特征点不足——明确其边界，与 L1 互补而非替代。
- Airtest 的 keypoint_matching 即此路线（SIFT contrib）。

**L3 两级定位架构（组合层）**
- 粗定位（L1 低分辨率层 / L2 特征 / 颜色）→ 精定位（原分辨率模板局部窗口验证）。
  大厂标准做法，时延与鲁棒性兼得；标签亲和队列下每标签的定位预算独立。

**L4 学习型检测（远期选项，不进一期）**
- 大漠生态已有 YOLO 环境配置教程——学习型检测天然尺度旋转鲁棒。onnxruntime-web
  可跑在 wasm/webgpu。但引入训练工具链 + 标注 + 模型管理，个人项目负担重。
  定位：视觉体系架构预留 detector 插槽，模型类 locator 一期不做。

**连带修正**：N2 从"ORB 兜底档"改为并入本子体系（L2 用 SIFT/AKAZE，ORB 弃用）；
N1 点阵字库、N3 找色增加"缩放由 L1 先验换算"的说明——点阵/颜色在小分辨率层
同样有效（颜色尤其天然抗缩放），它们不是缩放弱项，缺的是与缩放先验的联动。

### C1.4 缩放的"完美方案"：先验直读（L0）【2026-11-21，回答用户"有没有完美方案"】

**结论：有——但只存在于浏览器自动化场景，按键精灵/大漠永远做不到。**

**原理：把"搜索问题"变成"查询问题"。** 外部抓屏自动化（按键精灵/大漠）面对系统
画面，缩放永远是一个**未知量**，只能靠金字塔/多档位去搜——搜就有漏检、有时延、
有邻档误差。而我们的自动化运行在浏览器**内部**，缩放不是未知量，是**可查询的
自身状态**：

```
当前物理缩放 = webContents.getZoomFactor()          // 页面缩放（Ctrl+滚轮）
             × screen.displayMetrics(devicePixelRatio) // OS DPI（用户 150% 显示）
             × 页面自身实现的缩放（visualViewport.scale / Flash Stage 缩放，取材时记录）
```

**L0 先验直读层（新增，置于金字塔之前）**：
- 取材时记录参考倍率（已有基础：87 线取材记录 viewport transform）；
- 运行时**直读**当前缩放三因子，算出精确匹配倍率 → 模板按该倍率缩放后 1:1 匹配；
- **零搜索、零漏检窗口、时延恒定**——缩放变了不是"再搜一遍"，而是"重读一遍因子"；
- 监听 `zoom-changed` / `resize` / DPI 变化事件自动失效重算先验，不靠轮询。

**诚实边界（"完美"的适用范围）**：
1. 页面/Flash **内部自实现缩放**（游戏 Stage.showAll 之类）不在 Electron API 视野内
   → 这部分仍靠取材记录的 viewport transform 覆盖；记录不到的场景降级 L1 搜索；
2. **旋转在我们的域里基本不存在**——浏览器从不旋转内容，Sprite 动画由帧选择吸收。
   旋转不变性是大漠等外部抓屏的痛点，不是我们的。L2 (SIFT) 因此降为二期备用；
3. 先验链上任一环缺失（隐私模式、异常 display 指标）→ 自动降级 L1，永不悬空。

**修正后的不变性子体系**：L0 先验直读（主路径，浏览器独有）→ L1 金字塔连续搜索
（降级兜底）→ L3 两级组合（L0 失效时粗到细）→ L2 SIFT（二期，未知变换场景备用）
→ L4 学习型检测（远期插槽）。

### C1.4.1 【用户挑战 2】"完美方案"的实证修正：L0 降级为先验 + ε 校准【2026-11-21】

**用户挑战**：OS DPI + 页面缩放的**组合**当年反复尝试无解，最终唯一接近可用的方案是
相对坐标系（且只有游戏/canvas 能用）。挑战成立——L0 的公式链**原理正确、逐因子可查，
但因子合成不等于精确值**。逐坑拆解：

| # | 因子坑 | 后果 |
|---|---|---|
| 1 | `getZoomFactor()` **不含 pinch-zoom**（visualViewport.scale 独立） | 公式漏一项（桌面鼠标场景少见，但存在） |
| 2 | **分数 DPI 取整漂移**：150% 下 1 CSS px = 1.5 物理px，DIP bounds→物理像素、抓帧→点击坐标两个方向的 round-trip 各 ±1px | 匹配边界阈值抖动、点击偏 1px——正是 87 线挫败的微观形态 |
| 3 | **跨屏移动**：DPR 变化事件到达时序滞后，先验短暂失真 | 移窗瞬间匹配失败窗口 |
| 4 | **Flash Stage 内部缩放**（showAll/exactFit）API 不可见 | 漏乘游戏自身缩放因子 |
| 5 | **Electron 抓帧分辨率语义**（capturePage/offscreen paint 的实际像素尺寸与哪个缩放因子挂钩） | 87 线当年无解的主战场之一 |

**修正方案：L0 从"公式直读"降级为"先验 + ε 实证校准"**——**测量，不要计算**：

```
ε = 实测有效缩放 = 抓帧中已知参考物的实际像素跨度 ÷ 该参考物的理论跨度
```

- 会话开始（及 display-metrics-changed / zoom-changed / resize）时执行一次校准探针：
  取页面 DOM 元素的 `getBoundingClientRect()`（理论位置）与抓帧中该元素的实际像素
  位置比对，**一次性吸收 DPR × zoom × pinch × 取整 × 抓帧语义全部因子**；
- 校准得分低于置信阈值（参考物特征不足/比对失败）→ 自动降级 L1 金字塔搜索；
- Flash 纯画面区**无 DOM 参照物** → 参照物改用游戏画面自身 = **用户的相对坐标系方案**，
  从"当年的妥协"升格为正式 locator 类型：anchor（锚点模板）+ 相对偏移，锚与目标
  活在同一缩放空间里，比值天然消元——这是不确定性下的数学最优解，不是权宜之计
  （TargetRef 的 anchor+offset 结构 87 线已有，Next 补齐 scale-invariant 语义）。

**修正后的失败链（永不悬空）**：ε 先验算倍率 → 该倍率下匹配 + 得分验证 →
失败 → 先验邻域局部金字塔（L1，±窄窗）→ 仍失败 → 相对坐标模式（R 型 locator）。

**结论重述**：不存在"完美方案"，存在的是**把搜索空间从任意缩放压缩到先验邻域**的
方案——ε 校准把未知量从 5 个因子合成收敛为 1 个实测标量，相对坐标系把残余不确定性
结构性归零。两者相加，缩放问题从"碰运气"降为"工程常数"。

**文档考古（2026-11-21 回查，回答"当年失败形态是什么"）**：

1. **失败形态实锤 = 坑 #5（抓帧语义）+ 倍率预测链断裂**——
   `docs/archive/automation-v2/opencv-vision-audit.md:565`：Windows 150% DPI 首次
   真机闭环即暴露 `webContents.capturePage(rect)` 返回**物理像素** 84×60，而
   Automation Capture Service 对外是**逻辑帧** 56×40；若存了前者却记逻辑尺寸，
   参考 1.25 倍率下模板被错误放大成 105×75 → **匹配必败，不是点击偏移**。
   修复 = 全链路统一归一化逻辑帧。另一处记载
   `docs/archive/superpowers/specs/2026-08-07-screenshot-design.md:514`：
   "`capturePage` 返回设备像素尺寸，调用方自行缩放"——坑 #5 是**设计已知但靠纪律
   防守**的问题，不是被架构消解的问题。
2. **幸存方案实锤 = ADR-002（你记忆里的"坐标系"）**——
   `docs/archive/automation-v2/adr/0002-geometry-space-identity.md`（Accepted
   2026-08-30）：持久几何一律 `ratio [0,1]` + SpaceRef（ViewportSpace/SurfaceSpace
   两个公共空间），显式否决"全整数像素"方案（理由原文：*无法跨 DPI/zoom/surface
   复用*）。`opencv-vision-audit.md:570` 验证语：*"Surface 相对坐标在后续
   BrowserView resize 后仍成功点击 Canvas"*——R 型 locator 的先例。
3. **倍率搜索的现状账**——`docs/archive/automation-v2/status.md:223`：学习倍率
   单档快试 + miss 回退 ±3% 邻档与 DPI 档；十档诊断搜索 898ms vs 已知单档 283ms。
   即 87 线的"连续缩放"本质仍是**离散档 + 邻档回退**，L0/ε 的目标就是把这个
   搜索过程整体替换为一次实测。

**对 Next 的落点**：
- ε 校准探针的**第一个使命就是消灭坑 #5**：抓帧像素语义（物理/逻辑）在
  Electron 39 上重新实证，作为 POC 清单固定项（87 线靠"统一逻辑帧"纪律防守，
  Next 用 ε 实测值防守——不再依赖任何一方的语义自觉）；
- R 型 locator 不是新发明，是 **ADR-002 的直系继承**（ratio + SpaceRef 语义照搬，
  绑定层随 WebContentsView 重验）；
- ε 校准 = ADR-002 的 runtime 互补面：ratio 解决"几何持久表示"，ε 解决
  "bitmap↔logical 换算系数"——两者合起来才是当年问题的完整解。

### C1.4.2 全新架构的根治方案：自证帧（Self-Describing Frame）【2026-11-21】

**用户问**：全新架构能不能根治、有没有好办法。**答：能——把"纪律防守"换成
"结构不可能"。** 当年 bug 的本质（audit:565）是**像素与它的空间元数据可以被分离**：
测试存了物理像素位图、却记了逻辑尺寸——两个事实分开旅行，组合出错无人拦截。
根治方案两件套：

**① 自证帧：ε 从"会话探针"降为"逐帧属性"**

```
Frame {
  pixels: 不透明位图（永不裸露）
  observedScale: number   // = bitmap.width ÷ 请求 rect 的逻辑宽度，逐帧实测
  generation: number      // viewport/surface generation（ADR-002 语义延续）
  source: captureBackend  // capturePage | CDP screenshot | offscreen paint
}
```

- capture 服务请求 rect 时用**逻辑坐标**，返回位图有**物理尺寸**——两者一除，
  该帧的真实缩放 ε **天然可测，逐帧自证**。不需要会话探针、不需要读任何
  API 语义、不信任任何文档声明：`capturePage` 到底返回什么，**量出来是什么就是什么**；
- **模板缩放比 = ε_运行帧 ÷ ε_取材帧**——DPR、页面 zoom、pinch、抓帧语义、
  取整误差全部在除法中**成对消元**，任何一个因子都不需要被单独知道。
  当年"5 因子合成"的公式链整个作废，缩放搜索变成一次除法；
- 多抓帧后端（capturePage / CDP Page.captureScreenshot / offscreen paint）语义
  各异，但都归一到同一 Frame 合同——后端差异被逐帧实测吸收，抓帧层可替换；
- 异常防御：ε 实测值不在合理区间（如 DPR 明明 1.5 却测得 1.0）→ 帧标记可疑，
  走降级链，绝不静默使用。

**② 类型强制：让 audit:565 那个 bug 无法表示**

- pixels 与空间元数据**不可分离**：Frame 是不透明对象，位图字节不出 Frame，
  所有匹配 API 签名为 `match(frame: Frame, template: Template, ...)` ——
  "拿裸 Uint8Array 配一个记错的数字"在 API 面上不存在；
- branded types 封锁跨空间算术：`LogicalPx` / `PhysicalPx` / `RatioCoord` 是
  三个不同品牌类型，互相之间**没有隐式运算**，转换只经 Frame/Adapter 的命名
  方法——跨空间换算错误从"运行时 bug"升级为"编译不过"；
- 取材产物 = 逻辑帧模板 + ε_取材 + ratio 坐标（ADR-002 表示层），运行时
  消费方拿到的全是带证明的数据，链路上没有一处需要人记得"这次是逻辑还是物理"。

**诚实边界**：帧级标量 ε 解决的是"帧与帧之间的缩放关系"；**帧内布局变化**
（Flash Stage.showAll 自缩放、游戏自适应改版）不改变帧的 ε 却改变内容布局——
这一层仍由 SurfaceSpace / R 型 locator（anchor + 相对偏移）承担，即 ADR-002
的原有职责。自证帧不取代它，是把它前面的整段公式沼泽填平。

**失败链更新**：ε_帧（逐帧实测）→ 倍率=两帧 ε 之比（除法消元）→ 匹配得分
验证 → 失败 → L1 金字塔窄窗搜索 → R 型相对坐标。每一级都有数据，无公式依赖。

### C1.4.3 自证帧 v1 真机验证结果【2026-11-21，实证修正设计】

探针：`tests/electron/self-describing-frame-probe.cjs`（Electron 11 真机，150% DPI，
zoom 1/1.25/1.5 + resize 四场景）。**v1 结果推翻单一 ε 模型，实证出三个硬结论：**

1. **capturePage 输出几何不含 zoom**：位图尺寸 = DIP bounds × DPI，恒 1.5，
   zoom 1.5 时也是 1.5；但**内容密度** = DPI × zoom（目标 130px 在 zoom 1.25 下
   实测 244 物理px = 130×1.875，与公式严格吻合）。⇒ **ε 必须一分为二**：
   - `frameScale`（位图几何 ÷ DIP bounds）→ 输入映射用；
   - `contentScale`（位图几何 ÷ CSS 视口）→ 模板缩放用。
   Frame 合同字段修正：`{ pixels, frameScale, contentScale, generation, source }`。
2. **capturePage(rect) 在 E11 BrowserView 上被忽略**（rect 抓取返回全帧）——
   E11 缺陷实锤，rect 语义 v2 探针用 CSS/DIP 双坐标系候选复验记录。
3. **点击回环全 zoom 命中 0.5px，k=1**：位图命中点 ÷ frameScale = DIP 输入坐标，
   sendInputEvent 直收——H5 首轮即全过。

**除法消元修正后依然成立**：模板缩放比 = 两帧 **contentScale** 之比
（v1 的 20%/33% 缩放误差正是"误用 frameScale 当 contentScale"的量化证明）。
v2 探针按二分模型复验，判定：frameScale==DPI、图案=逻辑×contentScale(≤2px)、
比率≤1%、点击回环成立。

**方法论收获**：这正是"先探后改"的价值——若按 v1 设计直接进 Next 开发，单一 ε
会在 zoom≠1 场景全部翻车，且 20~33% 的缩放误差形态极难排查。真机 10 分钟
把设计从"错"修到"对"。

**v2 复验结果【2026-11-21 PASS，四场景全绿】**：

| 指标 | zoom 1.0 | zoom 1.25 | zoom 1.5 | resize@1.25 | 判定线 |
|---|---|---|---|---|---|
| frameScale | 1.5 | 1.5 | 1.5 | 1.5 | ==DPI ✓ |
| contentScale | 1.5 | 1.875 | 2.2509 | 1.875 | ==DPI×zoom ✓ |
| 图案误差 | 0px | 0.25px | 0.39px | 0.25px | ≤2px ✓ |
| 比率消元 | — | 0.10% | 0.13% | 0.10% | ≤1% ✓ |
| 点击回环 | 0.5px | 0.5px | 0.5px | 0.5px | ≤2px ✓ |

- 分数 DPI 取整漂移实测仅 0.25~0.39px（坑 #2 在 E11 上比担心的轻）；contentScale
  在 zoom 1.5 时 2.2509 vs 公式 2.25（+0.04% 漂移）——除法消元把它压进 0.13%。
- **E11 rect 语义补完**：rect=DIP 坐标在 zoom 1.0 下能正确裁剪，**zoom≠1 时失效**
  （cropped=false）——rect 抓帧在 E11 上"zoom 1 可用、缩放下不可用"，进一步坐实
  Frame 合同必须以全帧抓取为基准、裁剪在帧内完成。
- CDP 三变体中仅 full 可用（clip 两变体被 E11 协议拒绝），ε=1.5 与 capturePage
  全帧一致——多后端归一合同有效。
- **结论：自证帧（frameScale/contentScale 二分 + 除法消元 + k=1 点击回环）在
  Electron 11 真机全链路验证成立。** 探针保留为 Next 的 POC 基线——Electron 39
  树上重跑即完成跨版本对照，几何合同可直接带入 Next 实现。

### C1.5 能力纳入清单【已定 2026-11-21】

| 能力 | 纳入 | 期次 | 理由 |
|---|---|---|---|
| L0 先验 + ε 实证校准 | ✅ | 一期（主路径） | 实测标量吸收全因子（见 C1.4.1 修正） |
| R 相对坐标 locator（anchor + 相对偏移） | ✅ | 一期（一等公民） | 用户实证方案升格，无 DOM 参照区的正式解 |
| L1 金字塔连续缩放 | ✅ | 一期（降级兜底） | 先验缺失时的安全网 |
| L3 两级定位 | ✅ | 一期（组合层） | 与 L0/L1 天然组合 |
| L2 SIFT/AKAZE | ✅ | **二期** | 旋转在浏览器域基本不存在，降为备用 |
| L4 学习型检测 | 🔶 | 插槽 | 架构留 detector 接口，一期不做 |
| N1 点阵字库 | ✅ | 算法一期 / 制作工具链二期 | 钓鱼像素字正解；倍率先验由 L0 直供 |
| N3 HSV + 差色找色 | ✅ | 一期 | 颜色天然抗缩放，与 L0 无耦合 |
| N4 多色混合 | ✅ | 一期 | 低垂果实 |
| N5 findAll + NMS | ✅ | 一期 | 多目标刚需 |
| ~~N2 ORB~~ | ✖ | — | 并入 L2，ORB 弃用 |

### C1.6 OCR 引擎终选【二次修正 2026-11-21 深夜：双候选 E39 同场 benchmark，门禁定夺，无预选默认】

> **修正记录 2**：修正版 1 依据 87 门禁数据推荐"延续 Paddle sidecar"，被用户再次挑战：
> "当年是当年，现在是现在，没准是 C87 没让 OCR 使出真正的力量，还得需要实测。"
> 复核确认 87 对照存在混杂变量（模型 v3 vs v6 small 不同代、线程 4 vs 8 未对齐、
> 管线预/后处理开销混入端到端耗时），且第三方 benchmark（zhongxiao37 2026-07，
> 3000×2250 大图）给出**相反排名**（RapidOCR 1954ms vs PaddleOCR 28185ms）——
> **引擎排名是配置函数，不是常量**。87 门禁否决的有效范围仅限当时配置 + E11
> 环境，不跨版本继承。E39/Node 24 已解除双 ABI 约束，onnxruntime-node 可进
> utilityProcess。**结论：不做纸面预选，双候选在 E39 同场 benchmark，按
> manifest 门槛定夺。**

**职责收窄的前提**（保留）：N1 点阵字库已接管"像素字读数值"主路径；OCR 三语义
服务对象收窄为普通网页文字、非像素风格游戏 UI、截图内自然文本——低频、高准确率诉求。

**双候选与 benchmark 设计**：

| 候选 | 引擎 | 模型 | 部署形态 |
|---|---|---|---|
| **A** | Paddle Inference C++ Sidecar（BAO1 BGRA 协议，87 已建成可复用） | PP-OCRv3 baseline + v5/v6 候选 | 自包含目录（SHA-256 锁定 + verify-release） |
| **B** | onnxruntime-node（最新版，utilityProcess） | **Paddle2ONNX 官方导出**（非 RapidOCR 打包件），管线上限两变体：PaddleOCR 官方后处理语义 / RapidOCR 管线 + 阈值调优 | npm 依赖 + 模型文件随包 |

**对齐原则**（吸取 87 混杂教训）：同模型同代（两候选喂同一组导出模型）、同线程数、
同输入（BGRA 帧）、同语料（56 张合成 + 真实游戏 corpus 扩充）、同判定
（ocr-benchmark-manifest.md 门槛：准确率、低分辨率文本、warm p95、RSS、体积、
取消/崩溃恢复）。识别率行为单独记录置信度分布与"多猜/保守"倾向（87 教训：
Rapid 低阈值多猜出 `a收线` 类噪声，挂机场景多猜错比保守漏更致命——阈值策略
纳入 benchmark 维度）。

**裁决规则**：准确率相同（或 B 在补阈值调优后相同）且延迟差距 ≤15%（沿用 87
BAO1 替换门槛）→ 取部署更简者；否则取快者；识别率行为显著更差者直接出局。
没有报告不宣称任何候选默认胜出。

**POC 清单**（Next 阶段）：①A/B 双候选 E39 同场 benchmark（上述对齐原则）；
②PP-OCRv3/v5/v6 三代模型同场对比（与候选维度正交）；③检测框 → ratio 坐标
输出对接（ADR-002 SpaceRef，两候选同）；④ONNX 路线在 Modern 渲染层场景
（onnxruntime-web + WebGPU）单独评估，与 Next 管线分域。

### C1.7 沙箱重新设计【已确认 2026-11-21 深夜】

**威胁模型先行**：自动化脚本来源 = 用户自写 + **他人分享的 .baoauto 包**（半不可信）。
要防的是：恶意/劣质脚本的宿主逃逸、死循环、内存爆炸、资源滥用；**不是**防火墙级
对抗（脚本不接触网络凭据面）。87 预算体系（maxCalls 10000 / 并发 8 / 单调用 30s /
总运行 30 分钟 / 源码 512KB / 单请求 64KB / 返回值 256KB）作为合同平移，实现重造。

**架构判据**：沙箱内跑的是**编排逻辑**（控制流、等待、条件判断），重活全在沙箱外
（视觉匹配=OpenCV worker、OCR=sidecar、输入注入=webContents）→ 沙箱执行吞吐
不敏感，**边界安全性与可抢占性敏感**（死循环必须能停、内存必须硬上限）。

**四路候选**（2026-11-21 联网核实）：

| 候选 | 隔离边界 | 致命伤 | 判定 |
|---|---|---|---|
| A. isolated-vm | 同进程 V8 isolate | **维护模式 + 2026 年严重逃逸漏洞 GHSA-864f-rcv7-6rh4**（持任意 ivm.Reference 可破 guest/host 边界，≤7.0.0 全部受影响）；README 自述"运行不可信代码不自动安全"、维护者承认某些用户代码会崩进程、Node 20+ 需 --no-node-snapshot、原生模块按 ABI 重建 | **出局**（安全与维护双否决） |
| B. utilityProcess 单层 | OS 进程边界 | Node 全 API 面在进程内——`process` 全局逃逸路径众所周知，仅靠"入口 wrapper 不暴露"是纪律防守（87 教训：纪律防守迟早失守） | 不可单独作为不可信边界 |
| C. QuickJS-wasm（quickjs-emscripten / quickjs-ng）单层 | WASM 线性内存（引擎级，无共享原型链） | 纯解释执行慢（编排逻辑不敏感）；与主进程跨层编排；ES2023 支持（quickjs-ng） | ✅ 内圈 |
| D. SES/Compartment | 冻结 primordials | lockdown() 须进程最早执行，与 Electron/依赖生态冲突 | 出局 |

**推荐 = 双层结构：utilityProcess 外圈（崩溃/强杀边界）+ QuickJS-wasm 内圈（引擎不可信边界）**

```
主进程 broker（grant/预算/审计）
   ↕ MessagePort（结构化克隆，帧等大二进制走 transferable）
utilityProcess（每个工作流会话一个，可强杀/超时自毁）
   └─ QuickJS 运行时（常驻复用，非每请求冷启）
        ├─ bao.* = 显式 host functions（FFI 注册面，能力即边界）
        ├─ interrupt handler → 单调用 30s 从解释器内部自停
        │   （解决 isolated-vm 自认"V8 无法抢占某些脚本"的死循环问题）
        └─ setMemoryLimit → 硬内存上限
```

1. **两层各管一件事**：utilityProcess 管"崩了/卡死就杀"（总运行 30 分钟到期强杀，
   崩溃不伤主进程）；QuickJS 管"不可信代码摸不到宿主"（WASM 边界无 Node 面，
   没有 `process` 可逃逸）。87 的"入口 wrapper 不暴露 require"纪律防守被结构性替代。
2. **边界调用延迟可接受**：bao.* 每次调用 = FFI 出 QuickJS → MessagePort → broker，
   预算 maxCalls 10000 下总开销毫秒级；重数据（帧位图）走 transferable 零拷贝。
3. **预算落点变化**：源码 512KB / 单请求 64KB / 返回值 256KB → QuickJS 侧校验；
   单调用 30s → interrupt handler；总运行 30 分钟 → utilityProcess 强杀；
   并发 8 → broker 管控（外圈）。maxCalls 在 broker 计数。
4. **TS 转译目标放宽**：QuickJS-ng 支持 ES2023，`ts.transpileModule` 目标从
   ES2019 放宽（转译损耗下降），仍零依赖第三方运行时。
5. **与 87 的连续性**：`.baoauto` 包格式与 workflow-runtime 合同不变（C1 已定重设计，
   但沙箱接口面仍是 `bao.*` 语义承接）；grant/broker 模型平移。

**诚实边界 / 待核**：
- 【待核】QuickJS-wasm 纯计算性能对个别脚本形态的影响（大数组解析类）——
  预算体系兜底，POC 用真实钓鱼脚本跑分；嫌慢的热逻辑正解是下沉为 locator
  原生调用，不是换沙箱；
- 【待核】quickjs-emscripten 的 quickjs-ng 变体成熟度 vs 经典 quickjs 变体
  （POC 实测定）；
- handle 泄漏纪律：QuickJS 跨界值是手动管理句柄，桥接层必须 Scope 化统一释放
  （一次性写对，桥接层是唯一需要 V8/FFI 专家注意的地方）。

### C2 下载【设计 2026-11-21 深夜，2 项待裁决】

**外部核实**：DownloadItem API 面从 Chromium 87 到 Electron 39 基本无变化
（canResume/getURLChain/getLastModifiedTime/getETag 均已有）——87 的下载架构
没有"被版本淘汰"的部分，升级点全在集成面。

**三色账目**：

- 🟢 **架构合同层直接继承**（成熟度高，无争议）：
  1. 主进程唯一权威源（09-04 事故、06-downloads §5 不变量 1）——且与 A2+B3
     命令/投影天然同构：下载记录 = 投影协议里"高频流独立通道"的**第一个用户**；
  2. 双引擎（aria2 + Chromium）+ 按记录 engine 字段分派 + Chromium 重试队列强制走
     Chromium；
  3. 代理路由全套规则（真实 session resolveProxy、不支持时不降级 DIRECT、SOCKS/HTTPS
     返 null 回退 Chromium）；
  4. 路径安全全套（sanitize 保留名/availableSavePath 递增/isPathWithinDirectory
     realpath 防逃逸/危险扩展名双校验）；
  5. 落盘策略（终态立即写、进行中 1s 节流、终态裁剪 1000 条、重启归一 interrupted）。
- 🟡 **绑定层重验重写**：will-download 注册集合随 Next 分区模型重验（B4 多窗口连带
  ——分区归属从"persist: 约定"升级为明确设计项，§5 不变量 2 的坑不再靠纪律）；
  aria2 候选链删 ia32（C1-D2 已定仅 64 位，发布校验保留 PE 架构检查简化为 x64）；
  渲染层 Zustand→Pinia 投影 store（DatabaseHydrator 一次性 list + reconcile 语义平移）。
- 🔵 **升级/决策点**：见下。

**决策点**：

- **E1 aria2 保留【推荐保留】**：split=16 多连接与断点续传是 87 的核心增值，
  API 无替代；随包 + PATH 双候选、RPC secret、启动链竞速设计平移。
- **E2 IDM 集成形态【已定 2026-11-21：a 引擎式】**：will-download 拦截 → preventDefault
  → 交 IDM native host，记录 engine=idm 进下载管理，与 aria2/Chromium 三引擎并列；
  实现排期在 native messaging 垫片之后。**引擎抽象红线（用户疑虑"手动接入是否过度
  设计"的裁决）**：引擎集合事实封闭（aria2/Chromium/IDM/迅雷），87 的"判别联合 +
  按记录分派 + 每引擎手写适配器"模式平移即可；抽象边界画在单接口
  （start/pause/resume/cancel/probe）为止，**不做**注册中心/插件 manifest/热加载/
  预建迅雷适配器（YAGNI）；idm 引擎仅在探测到 native host 时启用，无 IDM 用户
  零感知，默认仍 aria2。
  **机制核实（2026-11-21）**：IDM 接管为双通道——①扩展 + Native Messaging
  （Chrome/Edge/Firefox 正式通道，v6.42 起 MV3）；②进程注入 + 网络 API 挂钩
  （"高级浏览器集成"，WinINet/WinHTTP，社区分析称下探 ws2_32 嗅探【待核】，
  浏览器 exe 列表可编辑 → 引擎无关，CEF 即由此被接管）。推论：CEF 式"零配置
  接管"是 IDM 主动注入，非浏览器配合，杀软冲突（火绒）即为通道②副作用；
  Next 走通道①更优形态（自是浏览器，免扩展直连 NM 宿主）；兜底路线 = 命令行
  （idman.exe /d /p）与 COM 接口现成。反向问题：通道②也会在 Next 背后嗅探 →
  E2a 的 IDM 接管开关做三态（关闭/仅手动/自动），保留"本次拒绝 IDM"覆盖，
  防双头接管打架。
- **E3 分区感知恢复【升级为设计项】**：87 已知边界"resumeDownload 重建走
  defaultSession、不保留原分区"——Next 多分区模型下恢复重建必须按记录所属分区
  （分区 id 进 DownloadRecord）。
- **E4 进度推送并入投影协议**：download:progress 走 A2+B3 独立高频通道，
  节流 500ms（与 aria2 轮询对齐），Chromium 进度封顶 99.9 语义保留。
- **E5 扩展下载协调【留位】**：C6 扩展落地后，扩展发起的下载在 will-download
  链里的优先级（扩展接管 vs IDM vs aria2）——留到 C6 讨论时定，本节只保证
  will-download 入口带 webContents/来源标记。

**待裁决**：E1（aria2 保留）、E2（IDM 形态 a/b）；E3/E4 默认通过即定，E5 留位。

> **C2 结案（2026-11-21 深夜）**：E1 = 保留【已定】；E2 = a 引擎式【已定，含引擎抽象
> 红线：判别联合 + 手写适配器平移，不做注册中心/插件体系/预建迅雷，idm 仅探测到
> native host 时启用】；E3/E4 默认通过；E5 留位 C6。

### C3 i18n 与更新检查【已确认 2026-11-21 深夜】

**87 现状**（11-i18n-theme-update.md）：渲染层 typesafe-i18n + 主进程
`uiText('中文','English')` 调用点内联双轨；两套语言状态（IndexedDB + config）
靠同步链维持——雷区 #1"不同步则原生菜单停留旧语言"。

**联网核实（2026-11-21）**：vue-i18n v11 为当前稳定（v9/v10 已 EOL）；2026 主流
决策树对 Vue 3 项目 = vue-i18n Composition API；typesafe-i18n 仍在但定位
"TypeScript 重度团队"，ICU 有限、懒加载手动。

**提案**：

1. **库 = vue-i18n 11**【推荐】：Vue 3 官方标准、Composition/响应式、ICU、
   懒加载原生；typesafe-i18n 的编译期 key 安全用 **message schema（typed .ts）**
   补齐。放弃 typesafe-i18n 理由：Next 是 Vue 主场，框架生态统一优先；
   主场项目（weblog）经验直接复用。
2. **词典统一事实源（核心升级）**：`shared/locales/{zh-CN,en}.json`
   （namespace 切分 main/renderer/assistant），渲染层与主进程**共享同一份词典**；
   主进程 `uiText('中文','English')` 调用点内联模式**废除**，改按 key 查词典。
   构建期门禁：zh-CN/en key 奇偶校验（87 的 assistant-ui-en.json 失败机制推广到
   全部词典）——翻译完整性从纪律变构建失败。
3. **locale 单一真值**：`config.uiLanguage`（主进程）为唯一权威，渲染层语言 =
   投影（A2+B3 模式的直接应用）——雷区 #1"两套状态同步"从纪律变结构。
   `ui:set-language` sender 校验、语言值白名单保留。
4. **助手英文构建期生成链平移**（native-assistant-i18n.mjs 机制不变）。
5. **更新检查设计平移**（只提示不自动装 / 启动查一次 + 并发合并 / 拒绝
   draft+prerelease / 不上传本地信息）——全是雷区沉淀，原样继承。

### C4 密码管理器【D1/D2 已定 2026-11-21 深夜，D4 待定】

**87 现状**（`docs/modules/05-password-vault.md`，1.1.2 源码核对）：

- 密钥链：DEK（AES-256-GCM 加密条目）← wrap key（设备级）← OS keyring；
  PBKDF2 250k + SHA-256；零第三方加密依赖。
- **A 档 = 自研 keyring 后端**：Windows DPAPI（PowerShell 子进程 + .NET
  `ProtectedData`，全套 ANSI/stdin 纯 ASCII 约束）、Linux `secret-tool`
  （blob=ss1 条目指针、stderr 空否二分、15s/10s/3s 强制超时）、darwin
  未实现（`createPlatformBackend` 返回 null → 落 C′）。
- **C′ = keyLocal 本地混淆**（保护级别近似 Chromium `basic_text`）。
- 失败语义（K1–K4，09-20/09-21 事故沉淀）：transient（timeout / spawn-failed /
  protocol-error / backend-unavailable）退避重试 0/3/10/30s vs deterministic
  （decrypt-failed / corrupt-local）blocked；读路径零破坏；**A 档读不到不降级
  C′**；`REBUILD` 确认词是唯一销毁路径。
- 捕获链：dom-ready→did-finish-load→did-stop-loading 三事件武装、CDP
  `Runtime.addBinding`、动态表单 observer（可见性判据）、Chrome 去重语义、
  阶梯填充时序 120ms~30s。
- 已知限制：**OOPIF 跨站子帧捕获不到**（E11 debugger 只能 attach webContents，
  探针 56 固定）。

**Next 变量（2026-11-21 联网核实 Electron 官方文档）**：safeStorage 在 E39/142
已有**异步 API**（`isAsyncEncryptionAvailable` / `encryptStringAsync` /
`decryptStringAsync`），同步 API 已标 deprecated、**E46 将移除**：

- 三平台密钥提供方：Windows=DPAPI / macOS=Keychain（要求代码签名，否则每次
  更新重弹授权）/ Linux=portal Secret + Secret Service + fallback。
- async 解密返回 `shouldReEncrypt`（密钥轮换/安全级别变化）与
  `isTemporarilyUnavailable`（临时不可用）——**官方语义正好映射 v2 的
  transient/deterministic 二分**。
- Linux 无 secret store 时 fallback 的保护级别官方未写明（同步 API 时代是
  basic_text 明文）；`getSelectedStorageBackend()` 只覆盖同步路径【待核】。
- `setUsePlainTextEncryption(true)` 存在但**绝不可调用**。

**裁决单**：

- **C4-D1 A 档载体换 safeStorage async API，自研 keyring 后端退役【已定
  2026-11-21】**（用户：早就想换了，中途错判一次导致 git 回退掉不少——Next
  不再有 Electron 11 无 safeStorage 的约束，是这次重造的直接收益之一）
  退役清单：`keyring.ts` 平台开关、`keyring-win-dpapi.ts`（PowerShell ANSI
  约束全删）、`keyring-linux-secret-tool.ts`（stderr 二分 + 超时全删）、darwin
  null 分支。收益①09-20 事故类结构性消失（无子进程 → 无超时误判面）；
  ②darwin A 档免费补齐（Keychain）；③transient/deterministic 二分由官方
  `shouldReEncrypt` / `isTemporarilyUnavailable` 显式建模，K1–K4 从"我们发明的
  语义"变成"平台语义"。代价：失去 ss1 条目指针形态——那本来就是要绕开的坑；
  macOS 签名依赖（挂 E3）。
- **C4-D2 Linux 明文降级守门【已定 2026-11-21，C′ 形态 = a】** 铁律：不调用
  `setUsePlainTextEncryption`；async 路径 fallback provider 的保护级别与探测
  方法官方未写明【待核，E39 实证任务】。**C′ = 直接用 safeStorage 的
  fallback/basic_text 形态**，keyLocal 自研混淆退役，少维护一份加密代码。
  Chrome 在 Linux 无 keyring 时同样明文+提示——对齐 Chrome，UI 如实标注
  保护等级（87 安全不变量平移）。
- **C4-D3 密钥链与失败语义骨架平移（架构不变）** DEK/wrap key 链、轮换只在
  `initVault` / `resetAll`、读路径零破坏、"A 档读不到不降级 C′"、blocked 等
  用户决策、`REBUILD` 唯一销毁路径——全部保留。变化：0/3/10/30s 退避序列由
  `isTemporarilyUnavailable` + 重试语义替代；`keyEncBackend` 亲和标签简化
  （无子进程后端漂移，但 Linux backend 变化仍走 `shouldReEncrypt` 重加密）。
- **C4-D4 v2 保险库数据导入【待定 2026-11-21，用户暂无法裁决】** a) 不做导入
  （v1→v2 先例，Next 独立新产品、用户基数从零，代价≈0）；b) 一次性导入工具：
  旧 BFB 内"导出"（走 reveal 门禁）→ Next 内"导入"重加密——跨机器场景 wrap
  key（DPAPI / ss1 指针）绑旧设备，导出只能跑在旧环境。不阻塞后续议程；
  若选 b，导出工具可独立排期在 Next 首版之后。
- **C4-D5 OOPIF 捕获限制重审【E39 验证任务，非纸面】** E11 限制：跨站子帧
  （OOPIF，如 7k7k `web.7k7k.com` 层）捕获不到。E39 机会：CDP
  `Target.setAutoAttach({flatten:true})` 可拿 OOPIF session（Chrome 自己的密码
  捕获就是这么做的）——限制可能**结构性解除**。照自证帧先例：E39 真机探针
  验证后再写进设计，不许按文档空谈。
- **C4-D6 捕获/填充行为规格平移（需求清单；代码按 Next B 区结构重写）**
  ①武装：三事件兜底、一次导航只武装一次——广告密集页不因 load 拖延漏捕获
  （11-10 实锤）；②observer：可见性判据（先插入后显示登录层）、style/class
  属性观察、提示文字不算已填、账号名上报时刻回读；③填充：阶梯 120ms~30s +
  no-form 短重试、点击类信号只重武装不触发填充、"此刻登录框还有用户输入就
  不填"；④去重：Chrome 语义（同 host+账号：同密静默/异密提示/解不出保守
  静默）；⑤不自动提交；teardown reason 化、ready/teardown 生命周期日志平移；
  ⑥安全不变量：observer 只发 presence signal、明文只经一次 IPC 出、密码不入
  console/URL。
- **C4-D7 与其他区的接口** ①view-gate 铁律归 C9（门禁在解密之前、共享失败
  计数 5 次锁 30 分钟；Windows CredUI 实现方式 PowerShell P/Invoke vs N-API
  原生插件在 C9 裁决）；②捕获/自动化租约互斥 → D 区统一 CDP 调度器设计，
  C4 只声明需求："捕获需要 debugger、不能被自动化踢，fill 争抢
  （250/500/.../3000ms 重试）从调度器层面消灭"；③IPC 合同 `password:*` 形状
  保留，实现挂 A2+B3 命令/投影；`keyStatus` ok/retrying/blocked 三态 +
  `tier` A/C/none 驱动 UI；④macOS 签名要求 → E3 打包分发注意项。

### C5 收藏/历史/设置【盘点 2026-11-21 深夜；D2-1 已定，C5-S1~S4 已定】

**87 线存储全量盘点**（2026-11-21 源码核查，出处见括号）——四类五处，这就是"乱"的全貌：

**① 主进程 electron-store（userData/*.json，8 个各自为政）**

| 文件 | 内容 | 出处 |
|---|---|---|
| `config.json` | 全部主进程设置：uiLanguage / proxy / flashVersion / flashPluginChannel / lowEndMode / screenshotDir / updateCheckMode / downloadEngine / downloadDir / userscript 额度 / automation warm start | `config.ts:118` |
| `download-state.json` | 下载记录（主进程唯一权威源，终端记录上限 1000、节流落盘） | `download-state.ts:9` |
| `password-store.json` | 密码保险库（DEK 加密条目） | `password-store.ts:78` |
| `password-autofill-key.json` | wrap key（A/C′ 档载体） | `password-store.ts:102` |
| `password-view-guard.json` | 查看门禁失败计数/锁定（独立 store，不随 resetAll 清） | `view-gate.ts:91` |
| `devtools-workspace.json` | DevToolbox 工作区 roots | `devtoolbox-workspace.ts:69` |
| `userscript-values.json` | 油猴 GM_value | `userscripts/index.ts:184` |
| `automation-v3/grants.json` | JS 沙箱授权 | `automation-v3.ipc.ts:74` |

**② 主进程目录（userData/ 下非 JSON）**：`automation-v3/packages`（导入包）、
`automation-logs/`、`screenshots/`（兜底目录）、`userscript-downloads/`、
`PepperFlash/System`（mms.cfg/mm.cfg）、`logs/`。

**③ 渲染层 Dexie IndexedDB（`BaoFlashDB`，db.ts:15）**

| 表 | 内容 | 消费方 |
|---|---|---|
| `favorites` | 收藏 | useDataStore |
| `history` | 历史（v2 升级时裁到 5000） | useDataStore |
| `downloads` | 下载遗留副本（**双层权威疤**，靠 persistence-merge.ts 弥合） | persistence-merge |
| `settingsSingleton` | **只有 searchEngine**（v1 `settings` 表 → v3 改名迁移） | FirstRunLanguageGate |
| `meta` | 杂项 key-value：`themeMode`、**标签页会话快照**（useTabManager.ts:456）、`migrated_v1` | useTabManager / useDataStore |

**④ 渲染层 localStorage（散装，无统一封装）**：Blockly 草稿
（AutomationBlocklyV2Editor.tsx:68）、DevToolbox 面板宽高/dock
（useDevToolStore.ts:31+）、`baoflash_*` 遗留键（db.ts:60 迁移后清除）。

**⑤ Chromium profile（userData 默认分区，隐式）**：cookies / cache / 站点
Local Storage / 站点 IndexedDB——不归应用代码管，但计入"备份/迁移"语义。

**乱点清单（用户体感"有点乱"的实物证据）**：

1. **设置分裂**：searchEngine 在渲染层 IndexedDB `settingsSingleton`（还经历
   了一次表改名迁移），其余设置在主进程 `config.json`——一个设置页跨两个
   进程两层存储。
2. **下载双层权威疤**：主进程 `download-state` 是权威，渲染层 `downloads`
   表是 v1 遗留，`persistence-merge.ts` 整个文件为弥合它而存在。
3. **主题三态史**：localStorage `baoflash_theme` → Dexie `meta.themeMode`，
   两代痕迹同在。
4. **会话快照是二等公民**：标签页恢复（高价值数据）以 key-value 塞在 `meta`
   杂项表里。
5. **localStorage 散装**：草稿/面板尺寸无归属约定。
6. **8 个 JSON schema 各写各的**，无统一版本/迁移机制。

**Next 归一方向（三轨制，作为 D2 的前置输入）**：

- **轨 1 · 主进程权威库（唯一权威）**：favorites / history / downloads /
  **全部设置（含 searchEngine，设置分裂消灭）** / 标签页会话快照（升一等
  公民）/ 密码保险库 / 油猴值 / 沙箱授权 / 门禁计数——收进**一个主进程存储**。
  渲染层 Dexie 整体退役。
- **轨 2 · 渲染层投影（A2+B3）**：渲染层不持任何权威库；会话快照、下载进度、
  设置全部走命令/投影。面板尺寸、Blockly 草稿这类纯 UI 态可留 localStorage
  （丢了无损失），在 §E 定归属。
- **轨 3 · Chromium profile**：站点数据原样（分区模型见 B 区）。

**轨 1 的载体裁决【D2-1 已定 2026-11-21 深夜 = a：SQLite 单库】**：

- **a) SQLite 单库【倾向】**：Chrome 本尊全线 SQLite；查询/索引/事务原生
  （history 5000 裁剪、按 host 聚合变 SQL）；单文件备份语义干净；WAL 抗
  崩溃。实现选项：`node:sqlite`（内建，零依赖；版本可用性【待核】）vs
  better-sqlite3（native 模块，E39 ABI 重编）。
- **b) electron-store JSON 群延续**：无新依赖、schema 校验现成；但 8 文件
  分散、无查询能力、原子性靠 tmp+rename、迁移各写各的——乱点 6 原样保留。
- 若 a：密码三件（vault / key / view-guard）是否也进同一 SQLite，还是保持
  独立文件（独立备份/删除语义、view-guard"不随重建清除"铁律）——
  **业内调查（2026-11-21 联网）后推荐独立文件，待用户确认**，见下。

**子问题 1 业内调查：密文与密钥同库还是分离？（2026-11-21 联网核实）**

| 产品 | 密文载体 | 密钥载体 | 是否同库 |
|---|---|---|---|
| Chrome/Edge/Brave（Chromium 系） | `Login Data`（SQLite，`logins.password_value` 为密文 BLOB） | **`Local State`（独立 JSON，浏览器级）**`os_crypt.encrypted_key`，DPAPI/Keychain 包装；macOS 在 Keychain"Chrome Safe Storage"；Linux 在 keyring | **分离** |
| Firefox | `logins.json`（密文条目） | `key4.db`（NSS 密钥库，独立文件） | **分离**（取证口径："one file without its partner is useless"——两文件成对独立正是设计意图） |
| 87 线 v2（本项目） | `password-store.json` | `password-autofill-key.json`（独立） + view-guard 独立 store | **分离** |

共识明确：**密文进库、密钥绝不与密文同库**——密钥放独立文件或 OS 层。
没有找到任何主流实现把 wrap key 塞进密码密文同一个库。附带的独立理由：

1. 密钥生命周期 ≠ 密文生命周期：轮换/重建密钥不应触碰密文库（87 线
   "轮换只在 initVault"的文件级对应物）；
2. view-guard"不随 `resetAll()`/重建清除"铁律：若计数器与密文同库，
   "重建保险库"的 `DELETE FROM ...` 一条事务就能顺手抹掉锁定状态——
   独立文件让铁律**结构成立**而非纪律成立；
3. 备份/导出语义：密钥文件是否随数据一起备份是用户决策，混库后失去选择权；
4. 写入节奏：view-guard 失败计数高频小写，独立小文件避免污染主库 WAL。

**推荐**：密码密文条目进 SQLite（与收藏/历史同库，享受统一备份），
`password-autofill-key.json` 与 `password-view-guard` 保持独立文件——
即 v2 布局在"密文库载体升级为 SQLite"后原样继承。
【已定 2026-11-21 = Chrome 方案：密文进库、key + view-guard 独立文件】

**子问题 2 提案：库形态与设置统一（2026-11-21 深夜，待裁决）**

**库文件**：`userData/store.db`（+ WAL/-shm sidecar），主进程唯一打开者；
文件名【待定，store.db / bao.db / data.db 均可，无实质差异】。

**Schema 与迁移（治"乱点 6"的核心）**：

- 单一迁移机制：`PRAGMA user_version` + 顺序编号迁移文件（`migrations/NNN-*.ts`），
  启动时单入口执行，禁止各模块自建迁移——87 线 8 个 JSON schema 各写各的、
  Dexie version() 分散在 db.ts 一处的状态不复存在。
- 每模块一张表（或一对表），模块所有权即表所有权；跨模块查询走显式
  repository 接口，不做隐式 JOIN。

**表草案**（字段细化留实现期，这里定形态）：

| 表 | 形态 | 来源（87 线对应物） |
|---|---|---|
| `settings` | **单行 JSON** + schema_version 列 | config.json 全量 + searchEngine（Dexie settingsSingleton）+ themeMode（meta）——**设置归一，乱点 1 消灭** |
| `favorites` | 列式，url PK | Dexie favorites |
| `history` | 列式，visitedAt 索引 + 上限裁剪 | Dexie history |
| `downloads` | 列式，id PK | download-state.json（权威源平移） |
| `tab_sessions` | payload JSON + savedAt | **meta 杂项里的会话快照升一等公民（乱点 4）** |
| `userscript_values` | scriptId+key PK | userscript-values.json |
| `automation_grants` | 列式 | automation-v3/grants.json |
| `password_vault` | 列式，password_value BLOB 密文 | password-store.json（Chrome Login Data 同构） |

**设置形态裁决点（C5-S1【已定 2026-11-21 深夜 = c) 列式】**：用户质疑"单行 JSON
可读性差"——成立。三选一重摆：

| 形态 | `SELECT *` 可读性 | 类型安全 | 加新设置的代价 |
|---|---|---|---|
| a) 单行 JSON | ★☆☆（一条长行，须 `json_extract` 拆） | 无（JSON 内无 schema） | 改 JSON 即可，零迁移 |
| b) key-value 行 | ★★☆（一行一键，值无类型） | 无 | INSERT 一行，零迁移 |
| c) **列式** | ★★★（天然一张表） | 有（列类型 + CHECK 约束） | ALTER 加列 = 一条迁移 |

**修订推荐 = c) 列式**：设置总数 ~15 键且高度稳定，加新设置本来就伴随
代码改动，迁移机制已存在——"加列一条迁移"不构成负担，换来的是
排障时 `SELECT * FROM settings` 直接出全表（用户排障习惯是直接看落盘
数据，这条权重高）+ 类型约束。嵌套结构（proxy 对象等）处理：扁平标量
各占一列，复合对象单独 JSON 列（如 `proxy_json`），不硬拆。

浏览器侧旁证：Chrome prefs / Firefox prefs.js 都保持人类可读——设置
的可读性在浏览器语境是传统，不是奢侈品。

a) 的存在理由只剩"设置键频繁增删"——本项目不成立。
【C5-S1 已定 2026-11-21 = c) 列式；嵌套结构扁平标量列 + 复合对象独立
JSON 列（proxy_json），不硬拆】

**子问题 3 提案：历史/收藏行为对齐 Chrome（2026-11-21，Chromium 事实源
已核实，待裁决 C5-S2 / C5-S3）**

**Chrome History 库事实**（多方取证资料交叉核实）：

- 双表模型：`urls`（每唯一 URL 一行：url/title/**visit_count**/**typed_count**/
  last_visit_time/hidden）+ `visits`（每次访问一行：url 外键/visit_time/
  from_visit/**transition**（低字节=类型：link/typed/reload/redirect…）/
  visit_duration），时间与 url/from 三索引。
- 保留策略：**90 天自动过期**（`kExpireDaysThreshold`），非行数上限。
- 隐私窗口**不写**历史。
- 书签**不在 History 库**——是独立 JSON 树文件（bookmark_bar/other/synced
  三根 + GUID），Chrome 选 JSON 是为 sync 整树原子语义；Next 无 sync
  需求，SQLite 载体维持 C5 已定不变。

**裁决点**：

- **C5-S2 历史模型【已定 2026-11-21 = a) Chrome 对齐双表】**：urls+visits+
  transition+from_visit 重定向链；写放大 = 每访问一个事务两写（SQLite 单
  事务无压力）；收益 = visit 粒度时间线、按天分组历史页、typed_count 供
  地址栏排序。
- **C5-S3 收藏模型【2026-11-21 优缺点已列，待裁决】**：

  | | a) flat（87 现状） | b) 文件夹树（Chrome 对齐） | c) 数据树、UI 先 flat |
  |---|---|---|---|
  | 心智模型 | 与 Chrome/Edge 用户习惯不一致 | 一致 | 一致（后期） |
  | 实现复杂度 | 最低 | 最高（树渲染/拖拽/空文件夹/面包屑） | 数据层同 b，UI 层同 a |
  | 导入 Chrome 书签 | 文件夹被拍平丢失 | 自然保留结构 | 自然保留结构 |
  | 站点数增长适应 | 只靠排序+搜索 | 分组管理 | 分组管理（启用后） |
  | 二次返工风险 | 升树 = 数据迁移+UI 重写 | 无 | **仅 UI 层改动，零数据迁移** |
  | 新增概念 | 无 | parent_id/排序位/递归 | parent_id 列（一列而已） |

  **推荐 c)**：数据层一步到位（parent_id + 排序位，null=根层），UI 首版
  可以只做 flat（只渲染根层）——"收窄范围"与"不二次返工"同时成立。这是
  对冲"产品决策反复"的标准形态：给未来留结构，不为未来提前付 UI 成本。
  【已定 2026-11-21 = 用户否决 c) 对冲，**直接 b) 一步到位**：数据与 UI
  均按 Chrome 文件夹树形态实现，首版即树 UI】
- **C5-S4【已定 2026-11-21 = 接受推荐】**：90 天过期替代行数上限；清除
  浏览数据带时间范围选择；隐私窗口不写历史【挂 B 区产品范围，引入隐私
  窗口时一并定】。

**裁剪/清理策略平移**：history 5000 上限（87 线 v2 迁移语义）、downloads
终端记录 1000 上限（download-state trim 语义）——从代码里手写循环变
定期 SQL（删除语句比内存裁剪+全量重写 JSON 干净一个量级）。

**Firefox vs Chrome 方案对比（2026-11-21，回应"火狐的方案怎么样"）**：
同为"密文/密钥分离"，安全底色差距明显——

| 维度 | Chrome（Chromium 系） | Firefox |
|---|---|---|
| 密文算法 | AES-256-**GCM**（AEAD，带认证标签，自描述 blob：版本号+12B nonce+密文+16B tag） | **3DES-CBC**（64-bit 块、无完整性校验的遗留算法，至今未换） |
| 密钥绑定 | 随机 32B key 由 **OS 层包装**：Windows=DPAPI（CurrentUser）、macOS=Keychain、Linux=keyring（无 keyring 降级 basic_text 明文=弱档） | key4.db 内的 key 由**主密码**（primary password）保护；**默认未设主密码 → key4.db 自包含，拿到两个文件即可离线解密全部密码** |
| KDF | 无自建 KDF（OS 包装即门禁） | PBKDF2（迭代数偏低，legacy 面） |
| 附加强化 | Chrome 127+ Windows 引入 v20 App-Bound（IElevator COM，绑定浏览器安装），争议中但方向是收紧 | 无对应机制 |
| 可读性/导出 | SQLite，元数据明文可查 | logins.json 人类可读（取证/迁移友好是其优点） |

**结论**：Firefox 的优势只有"明文元数据 JSON 化、迁移友好"；安全面上，
默认配置（无主密码）的 Firefox 密码库**没有任何 OS 级绑定**，弱于 Chrome
默认；算法代际（3DES-CBC vs AES-GCM）也落后。**Next 维持 Chrome 模型**
（无主密码 + OS 包装随机 key + AEAD）——这正是 87 线 v2 已选的同款，
方向无修正。Firefox 案例的真正教训：**"密文/密钥分离"是必要条件，不是
充分条件——分离之上还要看密钥那侧绑了什么**（OS 层 vs 用户口令 vs
什么都没绑）。

**SQLite 单库承载力核实（2026-11-21 联网，回应"能不能承担"）**：

- **版本事实**：E39 = Node 22.20.0（39.0.0 官方发布说明；39.8.10 = 22.22.1）。
  `node:sqlite` 自 Node 22.5 内置（`DatabaseSync`），**Electron 37 起即满足**、
  E39 富余——两个独立社区实践（Prisma 7 迁移记、WonderPen 存储迁移记）交叉
  证实"Electron 35+ 可直接用内建 SQLite，零原生 addon、零 electron-rebuild、
  零 ASAR unpack 问题"。better-sqlite3 → node:sqlite 迁移案例（kewutong
  issue #68）给出 API 映射：`prepare/run/get/all/iterate`、`exec`、
  `transaction` 在 22.x 均有；`pragma()` 需改 `exec("PRAGMA ...")`；async
  `Database` 是 Node 25+（不需要）。
- **载荷核算**：favorites（百级）/ history（5000 上限）/ downloads（终端
  记录 1000 上限）/ 设置（单行）/ 会话快照 / 油猴值 / 授权 / 门禁计数 /
  密码密文 blob——全部是 SQLite 下限级别的量，承载力无压力。
- **并发模型**：单主进程单写者 + WAL；渲染层零直连（轨 2 投影），不存在
  多进程写竞争。
- **残留 caution**：Node 22.x 中 node:sqlite 标注 experimental（API 稳定面
  以 DatabaseSync 为准）；**E39 真机一行冒烟**（`require('node:sqlite')` +
  建表 + WAL + 事务回滚）列入 E39 实证任务清单，照探针纪律不纸面放行。
- **对旧否决的推论**：若当年否决理由与 electron-store 相关（如
  better-sqlite3 原生模块重编/打包麻烦，或"electron-store 已够用"）——前者
  在 E39 已**结构性消解**（node:sqlite 内建，无 native addon）；后者见 b)
  项对比（乱点 6 原样保留）。

**SQLite 否决考古（2026-11-21，用户提示"提案过 sqlite 但被否决"）**：
检索结果——本地 docs 全量 grep（sqlite/Dexie/IndexedDB/数据库）只在
`docs/adr/0002-next-stack-baseline.md:56` 命中一处中性记录："Zustand + Dexie /
SQLite【待定】｜87 用 IndexedDB 镜像曾出过一致性问题；Next 可考虑主进程权威 +
SQLite"——**是待定，不是否决**。legacy 归档（lessons-learned /
repair-and-improvement-plan）记录的是 v1 时代 Dexie 层的缺陷与修补，无 SQLite
辩论。工作记忆日志、云知识库、历史会话检索均未命中否决记录；本会话压缩前
transcript 沙箱拒读，无法排除"否决发生在本会话早段（A1/A2/技术栈轮次）"。
结论：**未找到否决实锤**。若你记得否决理由（如 native 模块重编负担 /
electron-store 够用 / 引入数据库过重），请补充——命中与否决定 D2-1 是否
需要把旧理由重新过一遍审判。

### C6 扩展系统与垫片【提案 2026-11-21 深夜，待裁决】

**87 线现状**（04-userscripts.md，1.1.2 源码核对）：自研油猴平台 = E11 无
扩展支持下的替代品。重资产：GM 经典/现代双拼写、@connect 受控跨域预算、
GM_cookie 只读、GM_webRequest 只观察、@background 独立隐藏窗口 + 崩溃退避
（1s→…→60s，连 5 停）、run-at 四档调度、unsafeWindow 页世界桥（明确禁用
CDP 路线）、@require 缓存 512KiB、内置脚本（CSS Fixer、
automation-frame-assistant——与自动化模块绑定；缺失即重装、用户编辑永不
覆盖）。

**E39 扩展能力事实**（2026-11-21 官方文档 + 社区实证交叉核实）：

- `session.loadExtension` 仅 unpacked（.crx 原生不支持；接入 Web Store 是
  Electron 官方 non-goal）。
- **不跨启动记忆**：每次启动须重新 `loadExtension` → 持久化 + 启动重载是
  垫片第一项工作。
- MV3 **service worker 自 Electron 35 起可用**（SW preload + 
  `ServiceWorkerMain.ipc` 为 MV3 扩展而加）；`chrome.scripting` 在 39 修复。
  Tampermonkey 类 MV3 扩展可跑的前提成立。
- 缺口（社区 electron-chrome-extensions 库补齐的清单）：browserAction
  （工具栏图标/弹窗/badge）、cookies、contextMenus、notifications、windows、
  扩展工具栏 UI；`chrome.storage.sync/managed` 现已部分支持（落盘不跨设备
  同步、managed 恒空——2026-11-21 深夜复核，扩展面在增长但 userScripts
  仍不在列表且无排期迹象）；NM（
  `connectNative`/`sendNativeMessage`）**未实现**（依赖 OS host manifest）；
  `chrome.userScripts` **不在支持列表**。
- webRequest 冲突规则：Electron 主进程 webRequest 优先于 chrome.webRequest
  ——blocking 型扩展（广告拦截）与主进程逻辑的分层须显式设计（挂 D 区）。

**垫片的准确含义**（大方向已定的落地化）：

1. **userScripts 垫片【优先级 1】**：补 `chrome.userScripts*` API 面
   （Chrome 120+ 语义；Chrome 138 起用户侧为 "Allow User Scripts" 开关）。
   实现 = SW preload/main 注入 polyfill → Next 自有注入管线执行。
2. **native messaging 垫片【优先级 4】**：SW preload polyfill
   `connectNative` → 主进程 NM 宿主客户端（4 字节长度前缀协议 spawn 真宿主）
   → IDM 集成扩展等直接可用；C2-E2a 引擎式接管可复用此通道。
3. **持久化 + 启动重载**：扩展目录/状态进 SQLite 轨 1 + 启动枚举加载；
   多分区下"哪些 session 加载扩展"随 B 区分区模型定型。
4. **扩展管理 UI**：安装（目录/解包 crx）、启用/禁用/删除、权限展示、
   工具栏区（browserAction 缺口）。

**裁决点**：

- **C6-D1 自研油猴平台去留【核心裁决】**【已定 = d，2026-11-21 深夜，见下】
  - a) 退役：用户装真 Tampermonkey（垫片补 userScripts API 面）——87 平台
    删除，GM API 资产退役（由扩展自身提供）；CSS Fixer/automation-frame-
    assistant 改造成原生功能或内置扩展。
  - b) 保留自研平台（87 平移重写）——与真扩展双轨并存，GM 生态自持。
  - c) **自研平台转为垫片引擎【推荐】**：对外提供 `chrome.userScripts`
    API 面，对内复用 87 的调度/沙箱/注入资产；GM API 层退役（Tampermonkey
    自带）；内置脚本去留单独裁决（C6-D5）。平台从"平行宇宙"变成"API 的
    实现细节"，87 资产里真正独特的部分（run-at 四档、页世界桥、崩溃退避）
    全部保留价值。
- **C6-D1 修订议题：Violentmonkey 直接内置移植评估（2026-11-21 深夜，用户
  提出"当初不能移植，看看现在能不能"）**

  当初（E11）失败的结构性根因，三条全部已被时代消除：①VM 当时是 MV2
  持久 background page，electron-chrome-extensions 库 2021 年处于襁褓期、
  tabs/contextMenus/notifications 全缺；②Chromium 87 连 VM MV3 的最低
  门槛（135）都够不着；③GM 桥依赖的 runtime 消息面不完整。E11 时代
  "自研平台"是当时唯一解。

  **VM 现状（2026-11-21 核实）**：Chrome 商店版 v2.49.0 已迁 MV3（要求
  Chromium ≥135，E39 的 142 满足）；另提供 signed MV2 legacy 构建（Chromium
  142 上不可用，排除）。MIT 开源——撞上 Electron 缺口时**可以自己改**，
  这是与闭源 Tampermonkey 的本质差别。

  **MV3 版权限清单逐项对照**（build script 实证）：tabs（部分支持）、
  webRequest（全支持）、storage/unlimitedStorage（local 支持）、
  declarativeNetRequestWithHostAccess（本会话已实证有效）、cookies/
  contextMenus/notifications/windows（electron-chrome-extensions 补齐）、
  webNavigation（不在支持列表，小垫片）、alarms（不在列表，小垫片或降级
  手动更新）、identity（仅云同步 OAuth 用，可降级裁掉）、**offscreen**
  （不在列表——GM_setClipboard 等需 DOM 的操作降级，中等垫片）、
  **userScripts（核心缺口，正是已计划的优先级 1 垫片）**。

  **关键架构事实（modernmonkey 同源 fork 实证）**：VM MV3 注入主路径 =
  `chrome.userScripts`（USER_SCRIPT world + messaging）；fallback =
  `chrome.scripting.executeScript world:'MAIN'` 多方法链（eval/blob/inline），
  **但 fallback 路径下 GM_* API 全部不可用**——即"裸 Electron 装 VM"只能
  得到残废版；userScripts 垫片是 VM 完整工作的**前提**而非增强。

  **由此推出的结构变化**：userScripts 垫片在 c) 方案里要自己实现 GM API
  层；在 d) 方案里垫片之后 **GM API、编辑器 UI、@meta 解析、同步、更新
  检查全部由 VM 承接**——垫片工作量不变，平台工作量归零。c) 的 87 资产
  复用论（run-at 四档/页世界桥/崩溃退避）在 d) 下降级为"垫片注入管线的
  实现参考"。

  - d) **直接内置 Violentmonkey MV3 作为官方油猴方案**【新选项，待与 c)
    对决】：内置 unpacked VM MV3 + userScripts 垫片 + 三小垫片
    （webNavigation/alarms/offscreen）+ 必要的开源补丁（fork 进仓库维护）。
    风险：①垫片与 VM SW 的 `onUserScriptMessage` 对接细节未经真机验证，
    须探针纪律；②VM SW 无常驻 background，状态全在 storage.local——
    Electron 支持无虞；③Chrome 138+ 的 per-extension "Allow User Scripts"
    开关在 Electron 不存在 → BFB 设置里做原生等价开关（顺手成为安全特性）。
  - 与 c) 对决的实质：c) = 自持 GM 平台、可控性最高、工程量最大；d) =
    白拿一个 90 万用户的成熟管理器 + 开源可补丁、工程量最小、可控性让渡
    给"fork 维护义务"。【已定 = d，2026-11-21 深夜用户裁决】

  **d) 定案落地清单**：①VM MV3 fork 进仓库维护，随包分发 unpacked，启动
  `loadExtension`（持久化走 C6 垫片第 3 项）；②userScripts 垫片为硬前提
  （fallback 路径 GM_* 全不可用）；③三小垫片 webNavigation/alarms/offscreen；
  ④identity 裁掉（云同步 OAuth，BFB 不承诺）；⑤E39 真机探针验证
  `onUserScriptMessage` 对接后此决策才算最终落地（探针纪律）；⑥BFB 设置
  原生等价 "Allow User Scripts" 开关；⑦87 平台退役，run-at 四档/页世界桥
  /崩溃退避等坑位知识转为垫片注入管线实现参考；⑧内置脚本处置（C6-D5）
  随后裁决。

- **C6-D2 安装通道【已定 = 推荐，2026-11-21 深夜】**：一期 = unpacked 目录
  + 本地 crx 解包；二期评估 electron-chrome-web-store（第三方库，Flow
  Browser 生产案例）。内置 VM 属"随包分发"，不占用此通道。
- **C6-D3 垫片基座【已定 = 推荐，2026-11-21 深夜】**：electron-chrome-
  extensions（开源成熟，补 browserAction/cookies/contextMenus/notifications/
  windows）为基座 + 自研叠加 userScripts/NM 两个垫片。
- **C6-D4 NM 垫片形态**：SW preload polyfill → 主进程 NM 客户端。排期
  跟 C2-E2a（IDM）绑定，优先级 4 维持。
- **C6-D5 内置脚本处置【已定 = 推荐，2026-11-21 深夜；D1=d 后语义】**：
  CSS Fixer → 改造成原生功能（样式注入是浏览器能力，不必伪装成用户脚本）；
  automation-frame-assistant → 归 C1.1 自动化视觉平台，实现时一并定——
  VM 内置脚本体系不再需要。
- **C6-D6 webRequest 分层【已定 = 推荐，2026-11-21 深夜】**：挂 D 区进程
  架构，C6 声明需求："扩展 blocking 不得破坏密码捕获与自动化注入"
  （Electron 主进程 webRequest 天然优先于扩展）。

### C6 结案小结（2026-11-21 深夜）
D1=d 内置 Violentmonkey MV3（fork 维护 + userScripts 垫片硬前提 + 三小垫片
+ E39 探针验证 onUserScriptMessage 后决策最终落地）；D2 一期 unpacked+crx
解包；D3 electron-chrome-extensions 基座 + 自研叠加；D4 NM 优先级 4 挂
C2-E2a；D5 CSS Fixer 原生化 / frame-assistant 归 C1.1；D6 webRequest 分层
挂 D 区（红线：扩展不得破坏密码捕获与自动化注入）。

### C7 Flash 子系统【基线恢复 2026-11-21 深夜：已定部分来自技术栈 §6 + ADR-0002，勿再重议】

**已定基线（AI 曾因上下文压缩遗失，用户纠错后从 tech-stack 文档恢复）**：

- Next **肯定要 Flash**：驻扎 Electron 142，PPAPI 补丁集已打通
  （ppapi 恢复、`pepper_routing_id_`、prefs 真值化、bind_generates_resource；
  138 基线已出帧、140 推荐、142 驻扎）。
- **Next = Flash/Ruffle 双引擎**：原生 PPAPI 为主 + Ruffle 回退；87 的
  引擎语义（PPAPI↔Ruffle 销毁重建 + 三重 token 校验）保留但重造；87 的
  polyfill/私有 scheme（`ruffle-resource` 等）不再需要【ADR-0002 既有结论】。
- **Modern 平行分支**：摘除 Flash、专注 Ruffle（内建注入，不是扩展——
  §7.2.3 实证 Ruffle 扩展本质是 content-script 注入器）、追最新 Electron
  官方 tag、兑现 Linux 日用；Modern = Flash 之外体验最好的路径（WASM
  红利）。
- 现代内核下 Ruffle 注入：browser-use/内建注入即可，无需扩展机制。

**C7 真正待议的子问题**：

- C7-S1 Flash 二进制发现与版本管理：三级解析（文件名 → 二进制内嵌
  `WIN/LNX x,y,z,w` → macOS manifest）+ path+size+mtime 缓存平移；
  `ppapi-flash-version` 恒取 config.flashVersion（34.0.0.330）的伪装结论
  平移（历史结论：不要"修正"）。
- C7-S2 引擎选择语义重造：每页/每站/全局的引擎选择粒度、切换 UI、
  Ruffle 触发条件（87 是 PPAPI 失败回退还是用户手选）。
- C7-S3 Ruffle 资源加载路径：87 私有 scheme 不再需要的验证方式（E39/142
  探针：Ruffle WASM/外部资源直载是否受限）。
- C7-S4 PPAPI 补丁集 142 重放状态：已打通确认到哪一步、补丁面随 Chromium
  142 的差集核对（140 spec 的 vendor override 静默降级教训直接适用）。
- C7-S5 Flash 生命周期管理【已定 = 快速收案，2026-11-21 深夜】：
  ①插件加载 = `setupFlash`/mms.cfg/mm.cfg/版本伪装整套平移（142 PPAPI
  已实证可跑）；②崩溃恢复 = 87 `crashed` 位 + 重建路径平移，**Flash 崩溃
  信号形态【探针挂账】**（PPAPI 独立 plugin process 的 reason/进程归属
  文档不写，需真机触发）；③B1 交互 = **Flash tab 豁免 discard**（SWF
  内存态冻结即丢，游戏进度是硬约束），豁免后的内存占用数据
  【探针挂账】；④三重 token 校验/引擎感知 = 纯设计重造（87 语义平移）。

**C7-S2 引擎选择语义【已定 2026-11-21 深夜】**

**87 线现状（tabs.ts / App.tsx 源码核对）**：
- 触发 = **纯手动**：UI 切换按钮（`handleToggleRuffle`）per-tab 翻转，无任何
  自动回退（PPAPI 失败不会自动切 Ruffle）；
- 粒度 = 每 tab（`isRuffle` 字段），随会话快照恢复（restore 时
  `ruffleMode: entry.isRuffle ? ...`），**不按站点记忆**；
- 切换 = 销毁重建 BrowserView（`webPreferences.plugins` 创建时锁定，无热
  切换），只保 URL，**历史丢失**；
- Ruffle 源 = bundled / CDN 双源（`settings.ruffleSource` 全局），bundled
  失败 → 诊断上报 + 错误 toast 提供"改用内置版重试"；
- 右键菜单只读状态行显示当前引擎。

**Next 提案（四个子裁决）**：

- **S2-D1 粒度【已定，2026-11-21 深夜，用户修正后】**：87 线实际已有
  `settings.flashEngineMode`（'auto'/'prefer-ruffle'/'ppapi-only' 全局默认）
  与 `settings.flashEngineRules`（域名规则表，后缀匹配，设置页手动维护，
  `tab-initial-state.ts:15` resolveInitialRuffleMode 消费）——原提案"站点
  记忆新增"不成立，改为：**规则表保留 + 手动切换后询问用户"是否锁定为
  该站点规则"**（一键沉淀替代手填；不静默锁定，锁与不锁由用户确认）。
- **S2-D2 自动触发边界【已定，用户实证否决自动回退】**：**PPAPI 加载不了
  的内容 Ruffle 几乎不可能加载**（PPAPI 是真 Flash，兼容性天花板；真
  Flash 失败的 case Ruffle 模拟只会更糟）→ **不设 PPAPI 失败自动回退**。
  自动应用仅剩：全局默认引擎 + 域名规则命中。不做 SWF 内容嗅探。
- **S2-D3 Ruffle 源【已定 = 推荐】**：bundled 为唯一正式源（Next 内置
  dist）；CDN 降级为诊断后备（bundled 损坏时人工启用），不再是平级选项。
- **S2-D4 切换实现【已定，用户实证确认】**：销毁重建必须——C87 实证不
  销毁重建 Ruffle 注入不进去（preload/contextIsolation 时机在页面加载前
  已定）；E39 `webPreferences.plugins` 同为创建时锁定。三重 token 校验/
  引擎语义重造保留。升级项【待核】：87 切换只保 URL 丢历史，E39
  `navigationHistory` API 可回灌 back/forward 栈——若成立切换后历史不丢。
- UI：地址栏右侧引擎指示器 + 一键切换（新 UI 归 A 区），右键菜单状态行
  保留。Modern 分支无此语义（纯 Ruffle，无切换）。

  （WebContentsView）的配合。

**C7 结案小结（2026-11-21 深夜）**
基线（技术栈 §6 恢复，勿重议）：Next 驻扎 E142 + Flash/Ruffle 双引擎 +
Modern 分支（Ruffle-only 追新内核兑现 Linux）。S1 版本管理平移（三级解析
+ 伪装常量结论）；S2 已定（规则表 + 锁定确认制、无自动回退、bundled 唯一
正式源、销毁重建）；S3/S4 验证任务挂账（Ruffle 直载探针、PPAPI 补丁 142
差集）；S5 已定（平移 + Flash tab 豁免 discard + 两探针挂账）。
C7 探针挂账合计：Ruffle 资源直载、PPAPI 补丁差集、Flash 崩溃信号形态、
Flash tab 豁免内存数据（并入 E39 实证任务批次）。
**排期修订（2026-11-22，A4-D1）**：Modern 分支的**工程开设暂缓**——待
Next 基地落定后再随 Electron 版本迁移时机跟进；引擎方向（Ruffle-only 追
新内核）不变，仅推迟落地窗口。

### C8 DevToolbox 去留【已定 2026-11-21 深夜：D1=A′ 传输 / D2 按盘点执行 / D3 CDP Hub 定案】

**三个决定性事实（2026-11-21 核实）**：

1. **E39/142 自带现代 DevTools 前端**——87 线自建 chii 前端体系（构建降
   级、SOURCE_PATCHES、zh.json、两级自愈、replay 时序修复）的**存在理由①
   消失**，全套退役无悬念。
2. **Electron `webContents.debugger` 层仍是单客户端**（官方文档现行措辞）：
   'detach' 事件 = "webContents 关闭**或 DevTools 被调用**"——内置前端
   `openDevTools()` 一开，程序化调试器强制 detach。87 线租约体系的存在
   理由②在 `webContents.debugger` 层**依旧成立**。
3. **Chromium 自 Chrome 63 起 CDP 多客户端成立**——但作用于
   `--remote-debugging-port` 传输层（多个 WebSocket 客户端各自独立
   session，cdp-share 在 Chrome 157 实证多客户端共存正常）；Electron 的
   单客户端约束是 `webContents.debugger` 封装层的旧形态，不是 Chromium
   限制。

**由此推出 C8-D1（命运裁决，实质是传输层选型，与 D 区 CDP 调度器耦合）**：

- **路线 A【推荐】：CDP 全迁 port 层**——主进程以 localhost 绑定 +
  内部开关启动 `--remote-debugging-port`，密码捕获/自动化/DevTools 全走
  port 层独立 session → Chromium 多客户端原生并存，**租约互斥结构性
  消失**，DevToolbox 整体退役，内置 DevTools 直接用。代价：调试端口的
  安全面（localhost-only + 仅内部开关启用 + 生产默认关闭须设计）；D 区
  CDP 调度器按 port 层重造。
- **路线 B：维持 `webContents.debugger` + 租约**——DevToolbox 退役，但
  "打开 DevTools = 强制 detach = 捕获断"成为产品语义（87 的
  inspectWithPasswordCapturePaused 扩展成 UI 提示），体验受损。
- **路线 C：保留自建 DevToolbox（现代前端重做嵌入）**——仅当"观测绝不
  可断捕获"且 port 层被否决时才成立，成本最高。

**C8-D2 保留件盘点【与 D1 路线无关的部分】**：自动化画面/区域绑定 UI 归
C1.1（本来就不是 DevToolbox 的一部分）；Windows 保留端口段检测（
netsh excludedportrange）化为开发期工具；devtools preload 教训（主
preload 不暴露敏感 API）在 Next 架构下天然成立；观测陷阱类知识随 chii
体系退役。

**C8 探针挂账（并入 E39 实证批次）**：E39 真机验证 `webContents.debugger`
与 `openDevTools()` 的实际行为是否与文档一致（仍强制 detach）；port 层
多客户端在 Electron 142 的实际表现（捕获 + DevTools 并存）。

### C8-D3 CDP Hub 重设计【已定 = A′，2026-11-21 深夜定案；骨架定于本节，详细设计归 D 区；用户发起：87 线"危险但稳定"，要健壮设计】

**87 线痛点全景（文档实证）**：

- 消费者五路：密码捕获（长期）、密码填充（短时裸 attach）、自动化
  game-surface-detector（自持租约+watchdog）、transient-cdp-inspection
  （暂停→取→执行→释放→恢复四步舞）、DevToolbox（铁律不占租约）。
- 失败形态：attach 竞态（fill vs capture，"CDP is already attached" /
  "attach retries exhausted"）；`released` 标志与 `isAttached()` 两套真值
  不一致 → 幂等判断误判拒绝重建；四步舞顺序一错全崩；叠租约禁忌靠纪律
  不靠结构；generation 失效要在导航/切引擎/取消/销毁四处手工配合；
  openDevTools 强制 detach 不可控。

**根因分析（五条）**：

1. 单客户端物理约束 → 资源稀缺 → 需要互斥 → 租约（问题的起点）
2. 租约是**命令式手工协议**：acquire/release 散布调用点，顺序靠纪律
3. 附着状态是**全局可变暗状态**：两套真值源必然漂移
4. 消费者直接持有传输层句柄：生命周期清理靠每模块自觉，四处手工 generation
5. 无显式仲裁：优先级/抢占/恢复语义散落，外部事件（openDevTools）被动响应

**Next 设计：CDP Hub（主进程单例，消费者永不接触传输原语）**

- **传输层裁决（修正 C8-D1 的路线对比）**：
  - A（原推荐 port 层）：多客户端原生，但调试端口常开 = 常驻安全面
    （密码捕获是常驻需求 → port 必须常开，任何本地进程可连）。
  - **A′【新推荐】：`webContents.debugger` 单物理连接 + flatten 多路复用**
    ——Hub attach 一次，内部 `Target.setAutoAttach({flatten:true})` +
    `Target.attachToTarget` 为每个消费者造独立逻辑 session（
    sendCommand 的 sessionId 参数官方支持）；OOPIF 经 flatten auto-attach
    结构性解除（C4-D5 同源结论）。**零端口暴露**，安全面消失。唯一残留
    冲突 = openDevTools 强 detach 整个物理连接 → Hub 自动重挂 + 订阅
    重放（秒级自愈，把"断"从事故降级为瞬时事件）。
  - B 维持现状互斥：被 A′ 结构性取代，出局。
- **会话模型**：`hub.session(targetId, consumerId)` 幂等门面；消费者声明
  意图（域订阅集 + 全局副作用集 + 优先级），**永不触碰
  attach/detach/enable 原语**——命令式四步舞从 API 面上消灭。
- **生命周期绑定**：target 创建/销毁/导航（Target.targetInfoChanged）、
  render-process-gone → Hub 自动重建 session 并重放域订阅；session 失效
  从"异常"降级为"常态事件"。TabStore 的 tabId↔targetId 映射显式化（治
  87 线"切标签渲染层先变主进程后跟"类时序坑）。
- **仲裁最小集**：多 session 下 per-session 域（Runtime/DOM/Input/
  Network 事件观察）天然隔离；仅全局副作用域（Fetch 拦截、Emulation
  overrides）需 per-target 登记——声明冲突时按优先级排队或显式拒绝，
  拒绝带原因，无静默互踩。
- **不变量（结构保证，非纪律）**：
  - I1 每 target 恰有一条物理连接（模块层禁止 import 传输原语）
  - I2 消费者只见门面与声明，attach/detach 在 API 面不可达
  - I3 session 重建自动重放订阅，消费者无感
  - I4 所有拒绝/错误显式带原因，无静默重试
- **与 B3 衔接**：CDP 事件（密码提交/surface 指纹/自动化反馈）统一进
  事件流投影协议，渲染层零 CDP 直连。
- **与 C8-D1 关系**：DevToolbox 退役结论不变（A′ 下 openDevTools 可用，
  断连自愈）；D1 传输层定为 A′（见考古回执后结案小结）。

**C8-D3 考古回执（2026-11-21 深夜，用户提示"Hub 当初设想过但好像没采纳"）**

考古结论：**Hub 当初不仅设想过，还落地了一半**。实锤 =
`docs/archive/superpowers/specs/2026-11-06-devtools-cdp-bridge-design.md`
（DevTools CDP 桥 v2，IPC + flatten session，2026-11-06 全部真机完成）。

**当年采纳的部分（= Hub 的单消费者版）**：browser 级 ws + `Target.attachToTarget`
({flatten:true}) + sessionId→targetId 路由表 + session 生命周期推送 + 切标签
热切换 + **重放域开关命令**（实测一次切换重放 32 条）+ 16ms 合批 + 负载基线
（主进程增量 < 10pp 达标）——全是 Hub 的核心机构，E11 真机已验证。

**当年明确拒绝的部分（= "没采纳"的准确含义）**：铁律 B1"桥不碰 embedded"——
密码 capture/fill、automation 租约保持原样；边界§8"不做：把密码模块迁到桥"。
即**统一所有 CDP 消费者**的部分被否决，Hub 缩水成 DevToolbox 专属桥。

**当年拒绝的三个理由 vs Next 语境重审**：

| 当年理由 | Next 重审 |
|---|---|
| R1 "S7 证明没必要"（flatten 与 embedded 零耦合，迁移无收益） | S7 只证明了**共存**无冲突；四步舞的痛苦在 embedded **内部竞争**（fill vs capture attach 竞态），桥根本没碰它。痛苦未被裁决，只是被绕开。"没必要"判的是迁移收益，不是统一价值 |
| R2 端口依赖（非目标：去端口，flatten 依赖 CDP 端口） | A′ 走 `wc.debugger` 单物理连接，**零端口**——R2 结构性消失。且 sessionId+flatten 支持自 Electron 10.0.0-beta.10 / 11.0.0 就有（官方 spec 测试直接演示 per-target flatten session），当年 wc.debugger 路线并非不可行，是桥需要跨标签 browser 级视野才选了端口 |
| R3 Target 域模拟复杂（S14：须按 page-ws 真实语义模拟，"此前两轮基于推理的伪造全是错的"） | 桥要伺候第三方前端（须伪装 page-ws 行为）；Hub 的消费者全是自己人，直接用真实 session，**模拟层消失** |

**当年真机探针直接转为 Hub 设计约束（这是本考古最大价值）**：

- S15：响应与事件**必须同一有序流**——顺序错乱 = Elements 树残缺。Hub 每
  session 单流严格串行，禁双通道。
- S9：attach 后必须等 `Target.attachedToTarget`（或首条事件）再放行流量——
  attach 后立即 evaluate 的"域未找到"是瞬时竞态。Hub session 建立协议照此。
- B4：CDP 消息含凭据字段，**流量不落日志**（只记条数/字节/耗时）。
- S4：`openDevTools`（detach/docked 两种顺序）与 `wc.debugger` **共存**（E11
  真机）——与现行官方文档"DevTools invoked → detach"措辞矛盾，E39 探针必须
  复验两种行为哪个是真相（影响 A′ 自愈路径是否真的需要）。
- S7：flatten 与 embedded 零耦合——Hub 迁移期可灰度（消费者逐个迁，旧通道
  仍在），回归风险可控。
- B1.3 负载基线方法论：主进程 CPU 对照须先统一页面可见性（±50pp 混淆）。

**对 A′ 的影响**：不推翻，反而大幅降险——flatten 多路复用/路由/重放/合批/
有序流这套机构在 E11 真机跑通过（负载、真站、切标签全绿）。Hub = 桥 v2 的
"全消费者版 + 去端口版 + 去模拟版"。C8-D3 的四不变量与 session 模型维持，
补充三条设计约束（有序流/等 attached 再放行/流量不落日志）。

**C8 结案小结（2026-11-21 深夜，用户定案）**

- **C8-D1【已定 = A′】**：DevToolbox 整体退役（chii 体系/构建降级/
  SOURCE_PATCHES/两级自愈全删），内置 DevTools 直接用；传输层 =
  `wc.debugger` 单物理连接 + flatten 多路复用，**不走 port 层**（常驻
  安全面否决了原推荐 A）。
- **C8-D2【已定】**：保留件按盘点执行——画面/区域绑定 UI 归 C1.1、
  Windows 保留端口段检测化开发期工具、preload 教训在 Next 架构天然成立、
  观测陷阱知识随 chii 退役（文档沉淀保留）。
- **C8-D3【已定 = A′ CDP Hub】**：主进程单例 + 幂等门面（
  `hub.session(targetId, consumerId)`）+ 意图声明（域订阅集/全局副作用集/
  优先级）+ 生命周期自动重建重放 + 仲裁最小集 + 四不变量 I1–I4；详细设计
  归 D 区 CDP 调度器章节。设计约束三条（考古回执）：每 session 单流严格
  串行（S15）、session 建立等 attachedToTarget 再放行（S9）、流量不落日志
  只记统计（B4）。
- **E39 探针挂账新增**：`wc.debugger` + `openDevTools` 实际行为复验
  （E11 实测共存 vs 官方文档 detach 措辞矛盾）、flatten auto-attach 对
  OOPIF 的行为（与 C4-D5 同探针批次）、断连自动重挂自愈路径实测。
- Hub 前身 = 11-06 DevTools CDP 桥 v2（真机全绿），机构已验证；87 租约
  体系（cdp-lease/四步舞/watchdog）整体退役。

**A3 结案小结（2026-11-22 凌晨，五项全收官）**

- **D1 = Fluent 2 设计语言**（对齐 Edge，微软公开 token 为事实源；首帧
  表面 stroke 分层、Acrylic 禁用、Mica【待核 backgroundMaterial】）
- **D2 = Fluent 三档 token 架构**（global→alias→component；tokens.css +
  [data-theme] 切换，明暗只写一份，消灭 body.dark 双写税）
- **D3 = Chrome 标准两行布局**（用户裁决"没必要抢夺那点空间，实在受
  不了还有 F11"；开口标签 + 独立工具栏，a3-layout-demo.html 基准稿）
- **D4 = 组件基座两案并存待选**（Reka UI【推荐意见】vs Ark UI，触发点
  = D3 定型或 A 区组件清单落地；全自绘/成品库出局不变）
- **D5 = 密度/焦点环/动效全按推荐**（单一密度不暴露设置；焦点环采纳
  现代形态 = 圆角跟随 + Fluent 两层描边 + :focus-visible，附铁律禁
  outline:none 无替代移除；动画 120/180ms 两档 + prefers-reduced-motion
  + AA 对比度）

- C3. i18n【U 点名】：框架选型（i18next 等）、语言包管理、范围（仅 UI or 含自动化脚本文案）。
- C4. 密码管理器【A】：v2 架构（A 档 + C′ + view-gate）在 Next 重造的取舍——Electron 39 有 safeStorage，A 档可换官方实现，view-gate 铁律保留。
- C5. 收藏/历史/设置【A】：存储权威源划分（原项目渲染层 IndexedDB 的教训——下载记录曾因双层权威翻车）。
- C6. 扩展系统 + 垫片【A，已定大方向】：userScripts 垫片（优先级 1）、native messaging 垫片（优先级 4）、扩展管理 UI。
- C7. Flash 子系统【A】：Next 独有——PPAPI 补丁对接面、flash-version 三级解析与伪装、flash-version 常量不要"修正"的历史结论。
- C8. DevToolbox 去留【A】：142 自带现代 devtools，自建 chii 体系大概率整体退役——留哪些不可替代的部分（若有）。
- C9. 查看门禁 view-gate【A】：铁律（门禁在解密前、共享失败计数、5 次锁 30 分钟）平移。
- C10. 通知/右键菜单/查找栏等浏览器标配【A】：范围待定。

## D. 进程与数据架构【已收官 2026-11-22：D1~D4 全定（D4-S3 分发待定挂审）】

### D1 主进程模块划分 + preload 策略 + IPC 物理合同【已定 2026-11-22，四点全定】

- **S1 进程清单【已定】**：主进程 = 唯一业务进程（全部业务模块 + CDP Hub +
  storage + 日志）；外壳 renderer = 单 BrowserWindow（React 19 + Pinia
  只读投影 + 命令发送器）；标签 renderer = 每标签一个 WCV（Chromium
  自管）；utilityProcess 家族 = JS 沙箱 broker（C1.7 已定）+ OCR/vision
  形态（C1.6 benchmark 未终选）——**D1 只留槽位，不定内容**；Chromium
  内建（GPU/network/audio）不建模。
- **S2 模块分包【已定】**：87 的 30+ 文件扁平堆 → `core/`（hub、tabs、
  sessions、storage——基础设施，可被所有 feature 依赖）+ `features/`
  （password、automation、flash、userscripts、update……按 C 区清单一一
  对应）+ `protocol/`（三端同源，A4-D2 已定）。**两条依赖规则（结构
  保证，非纪律）**：①feature 之间禁止互相 import 内部，只走显式导出面；
  ②**Hub 不反向 import 任何 feature**——feature 经 `hub.session()` 消费
  Hub，单向（C8 I1/I2 的模块层形态）。
- **S3 preload 家族【已定，四类 → 三类】**：
  - shell preload = 薄转发（A2 命令/投影桥），**preload 零业务逻辑**
    升级为铁律；
  - guest preload **瘦身为二**：引擎 bootstrap（Ruffle/PPAPI）+ 扩展
    chrome.* 桥（electron-chrome-extensions 需要）；userscripts 运行时
    随 C6 迁 userScripts world——**sendSync 的存在理由随之消失**；
  - devtools preload 随 DevToolbox 退役（E142 内置 DevTools 无需自建）；
  - 浮层子 WCV 的 preload 随实现定（复用 shell preload 或薄壳）。
- **S4 IPC 物理合同【已定】**：全 `handle/invoke` + 单向事件推送，
  **sendSync 彻底禁绝**（唯一历史理由 = userscripts get-config，已随
  C6 消失）；通道命名沿用 `<domain>.<action>`；信封 `{ v, seq, payload }`；
  zod 校验统一在 protocol 层入口；错误语义统一
  `ApiError { code, message, cause }`——拒绝裸 Error 跨 IPC（87 的 IPC
  错误经常丢栈）。
- **教训平移核对**："devtools 必须独立 preload"随 DevToolbox 退役而
  失效；"CDP 租约共享 hack 不复活"由 D4 Hub 结构性达成。

**D2 存储架构收尾【已定 2026-11-22，总表 + 两裁决点全定】**

- **权威源总表**（行行有出处）：

  | 数据 | 权威源 | 介质 | 出处 |
  |---|---|---|---|
  | 标签状态（TabEntry） | 主进程内存 | 内存（投影经 B3 协议） | B2/B3 |
  | 历史记录 | 主进程 | store.db `urls`+`visits`（90 天过期） | C5 |
  | 收藏 | 主进程 | store.db 文件夹树 | C5 |
  | 设置 | 主进程 | store.db 列式 | C5 |
  | 密码 vault | 主进程 | store.db 同库 + wrap key / view-guard 独立文件 | C4 |
  | 下载记录 | 主进程 | store.db downloads 表 | C2 |
  | 自动化包 / sprite | 主进程 | 文件系统（userData 子目录），大二进制不进 SQLite | C1 |
  | 用户脚本 GM values | Violentmonkey 自管 | 扩展 origin 自带 storage | C6 |
  | Cookies / 缓存 / HTTP storage | Chromium 自管 | partition 目录，业务代码只经 session API 触碰 | — |

- **边界三条**：①store.db 单写者 = 主进程，渲染层访问一律 protocol/IPC，
  渲染层 Dexie/IndexedDB 整体退役（87 双层权威教训的终结条款）；
  ②"清除浏览数据"责任切分——Chromium 自管数据走
  `session.clearStorageData`，业务数据按表清，UI 只做聚合入口；
  ③journal_mode = WAL，迁移入口 `PRAGMA user_version` 单通道（C5）。
- **会话恢复介质【已定 = store.db `session_state` 表】**：启动读、变更
  节流写；SNSS 式自管二进制文件出局（单人浏览器重造 SNSS 是过度工程）。
- **session 分区策略【已定 = 单 `persist:` 分区沿用】**：Chrome 默认
  profile 亦是单分区，无隔离需求不建模（与 B1"全 WCV 化否决"同逻辑）；
  平移 87 注意点：`defaultSession` 与 `persist:` 是两个对象，配置两边
  都打（session-manager.ts:28 注释实证）。

**D3 日志与崩溃上报【已定 2026-11-22，五点全定】**

- **electron-log 沿用 + 百行级 log4j 式薄层【已定】**（用户问"有没有
  log4j 那种分层日志"后横评定案：Node/Electron 无 log4j 原生等价物，
  winston 无层级 / pino 无 per-child 级别且 JSON 行摩擦大 / debug 无
  文件体系——三者能力缺口照样要自建薄层，故不换底盘）：
  - `getLogger('hub.sessions')` 命名 logger，**级别解析 = 精确名 →
    最近祖先前缀 → 根默认**（前缀继承 ~20 行）；
  - 每模块级别 map 持久化在设置（如 `{ hub: 'info', automation.vision:
    'debug' }`），**运行时改级立即生效**（log4j setLevel 体验），设置页
    出配置入口；
  - MDC 对应物 = logger 绑 scope 字段（`{ mod }`），CDP 消费者叠
    `{ targetId, consumerId }`——一条 grep 定位模块与 target；
  - IPC 汇聚/轮转/文件位置全是 electron-log 现成，薄层只管级别路由。
- **多进程写者**：renderer/preload/sandbox 全部经 IPC 汇聚主进程单写者
  （electron-log 多进程模式），避免多进程写同一文件锁问题。
- **分级与轮转**：默认 info，debug 级默认关；单文件上限 + 归档保留 N 个
  （electron-log 轮转钩子）。**Hub 诊断面（D4-S7）走 metrics 不走日志**
  ——诊断数据高频，进日志 = 刷屏 + 变相落内容。
- **B4 衔接（模块级铁律，双道锁）**：CDP 参数/响应/载荷、密码值、凭据
  字段永不进日志——诊断面已结构化保证，日志层独立重申，谁漏了另一道
  还在。
- **crashReporter【已定 = 本地收集不上传】**：crashDumps 保留最近 N 份，
  `render-process-gone` 照常记日志；不上传与 C3 隐私立场一致；崩溃
  转储查看入口留设置页（用户手动导出）。
- **文件位置**：`userData/logs/`（与 store.db 同父分目录，敏感度不同，
  清理策略独立）。

### D4 CDP Hub 详细设计（C8-D3 移交，本区重头戏）

**D4-S1 内部结构与 API 面【已定 2026-11-22，含用户挑战后的修正】**

- **文件布局**：`src/main/core/hub/` = hub.ts（全局单例门面，唯一公开
  入口）/ transport.ts（每 target 一条 `wc.debugger` 物理 attach +
  `Target.setAutoAttach({flatten:true})`）/ sessions.ts（session 注册表 +
  状态机）/ arbiter.ts（per-target 全局副作用域登记与冲突裁决）/
  replay.ts（消费者订阅清单存档 + 重建重放）/ metrics.ts（条数/字节/
  耗时，B4 只记量不落内容）。
- **API 面**：`CdpHub.session(targetId, spec)`；`ConsumerSpec { id 幂等键,
  domains 事件订阅域, exclusive 全局副作用域, priority }`；
  `CdpSession { send / on / status / close }`。域 enable/disable 由 Hub
  代发（消费者 API 面无此原语）——重放 I3 的单一事实源 = 声明本身。
- **三个关键决策**：
  1. `session()` 幂等且即返：同 `(targetId, id)` 返回同一 session——
     87"released 标志 vs isAttached() 两套真值"消失（注册表唯一真值）。
  2. **发送 = pipeline，非串行等待**（修正：原"FIFO 等响应"会造成
     head-of-line blocking）：`send()` 入队即写传输层，保持发送序；响应
     按 CDP id 配对（与顺序无关），事件与响应同一流按到达序处理
     （S15 约束的是入站方向，与出站 pipeline 正交）。真依赖（先 enable
     再 evaluate）靠消费者 `await` 表达，不靠队列阻塞。
  3. **队列按 session generation 划界**（修正：用户挑战"排队会不会错位"
     揪出的真雷）：命令带隐含页面上下文，队列跨重建边界存活会把旧文档
     命令执行到新文档 = 语义错位。故 rebuilding/detached 时 in-flight 与
     queued 命令**全部显式 reject（带原因 `session-rebuilt`）**，绝不迁移
     新 session；消费者在 status 回 ready 后自行重发。FIFO 只剩一个职责：
     同 session 内保持发送顺序。
  【S2 修订】决策 3 的"队列"被 S2 锁裁决取代——见下。

**D4-S2 session 状态机【已定 2026-11-22，含用户裁决"加锁"】**

- **状态集**：`attaching → ready → rebuilding → detached(终态)` +
  `closed`。物理连接（per-target `wc.debugger`）是执行器不是独立状态机
  ——物理断连/恢复事件广播到该 target 所有逻辑 session，各 session
  独立走 rebuilding→ready。
- **转移表**：

  | 从 | 触发 | 到 | 副作用 |
  |---|---|---|---|
  | （首调） | `hub.session()` | attaching | 物理 attach + setAutoAttach |
  | attaching | S9 门过 + 域 enable 完成 | ready | 流量放行 |
  | attaching | target 销毁 | detached | 终态 |
  | ready | detach / 传输错 / render-gone(可恢复) | rebuilding | in-flight 命令 reject(`session-rebuilt`) |
  | rebuilding | 重挂成功 + S9 门 + 订阅重放 | ready | **同一对象**，订阅重放 |
  | rebuilding | 退避重挂失败中 | rebuilding | 持续退避自环（0.5s×2 起，上限 10s，+0~100ms jitter） |
  | rebuilding | target 销毁 | detached | 终态 |
  | attaching/ready/rebuilding | 消费者 `close()` | closed | 幂等；末位消费者离场才拆物理连接 |

- **send() 锁契约（用户裁决：加锁，不让调）**：`send()` 仅 ready 态可用
  ——非 ready 态调用**立即 reject（`E_SESSION_LOCKED`，附当前 status）**
  ，不 hold、不排队。S1 的 pipeline 队列**整体消失**：ready 态 send 即写
  传输层，唯一残余的 in-flight 登记表按连接 generation 记账，状态转移时
  全部显式 reject。API 补 `whenReady(): Promise<void>`（锁的自然搭档：
  消费者 `await whenReady()` 后再 send，消灭轮询）。
- **六个关键决策**：
  1. session 对象身份跨重建稳定（rebuilding→ready 不换对象，引用永远
     有效，只有 status 变）= I3"消费者无感"的形态：无感的是"引用不
     失效"，不是"事件不中断"。
  2. **导航触发零状态变化**：同 webContents 导航，物理连接/逻辑 session/
     域 enable 全存活。87"四处手工 generation 配合"收敛为零处。
  3. 引擎切换（C7 销毁重建）= target 生命周期事件，**Hub 不做自动迁移**
     ：旧 session detached(`session-destroyed`)，新 targetId 由消费者
     显式重新 `session()`（跨 target 迁移是语义决策，显式交给消费者）。
  4. openDevTools 走位：detach → 全部 session rebuilding（队列——已无
     队列，in-flight reject）→ 退避重挂，DevTools 关闭后下周期回 ready +
     重放。DevTools 打开期间事件停流 = 接受的成本；S4 探针若证实 E39
     上 openDevTools 与 wc.debugger 共存，此路径整段旁路。
  5. render-process-gone 分流：crash 后 reload 同 webContents →
     rebuilding 可恢复；tab 关闭 → detached 终态。
  6. API 面定稿：`send / on / status / onStatusChange / whenReady /
     close`——`onStatusChange` 供"target 死了就停"类消费者（密码捕获）
     感知。
- **S1 修订记录**：决策 3"FIFO 队列按 generation 划界"升级为"无队列 +
  锁"——用户指出排队语义留口子（rebuilding 期收新命令多半是时序 bug，
  显式失败优于静默排队/放行），锁让"跨代队列"这一事故形态从 API 面
  不可表达。

**D4-S3 事件分发与单流串行【提案已写，整体待定——用户对方案存疑，
挂后续审计复核，勿基于本节下游设计】**

- **入站路由（transport 层单点）**：`wc.debugger.on('message')` 单流
  到达序处理，禁双通道/重排（S15 字面落实）。JSON.parse 一次后三分：
  response 按 `id` → in-flight 登记表 resolve/reject；event 按
  `sessionId` → 逻辑 session → 域订阅匹配 → 分发；系统事件
  （Target.attachedToTarget 等）→ Hub 自用。
- **分发模型三决策**：
  1. per-session 有序分发队列，microtask 排空——慢 handler 只堵自己
     session，不连坐整条物理连接（入站版 head-of-line blocking 的防护；
     S15 是 per-session 语义，非跨 session）。
  2. OOPIF 子会话：flatten auto-attach 自动建子逻辑 session，订阅自动
     继承同一 ConsumerSpec，事件带 `{ sessionId, targetId }` 溯源帧来源；
     不提供 main-only 开关（密码捕获/自动化恰恰需要 OOPIF 覆盖，C4-D5
     同源）。
  3. 无 Hub 级背压、无丢包：订阅即全量派发，慢是消费者自己的事
     （handler 快进快出约定）；未订阅域事件直接丢弃 + 计数（Network
     洪水第一道闸，丢订阅外事件安全）。
- **分发队列无界**：有界队列在消费者真慢时静默丢已订阅事件（密码提交
  事件被丢 = 捕获静默失败，比 OOM 更糟）；metrics 条数曲线是定位证据。
- **metrics（B4 落实）**：per `session × domain` 条数/字节/耗时三列，
  环形缓冲保留最近 N 条聚合，`hub.metrics()` 快照；**内容永不落**（含
  凭据字段），debug 日志只打 method 名与尺寸。
- **执行原语选型（用户提议"上成熟消息队列"后的分层裁决）**：
  持久化/分布式 MQ（BullMQ/Kafka/Redis 系）否决——单进程内存路由、
  B4 不落盘，引入 broker 是负收益；RxJS/EventEmitter 否决（范式税 /
  同步派发无队列语义）；**per-session 串行分发原语拟用 p-queue**
  （concurrency:1 = 严格 FIFO，pause/clear 映射锁与销毁），三分路由 /
  id 配对 / generation 记账仍手写（Hub 特有核心资产）；per-handler
  try/catch + metrics 计数（`handler-error`）手写。
- **用户标记（2026-11-22）**：方案整体存疑（具体疑点未指明），挂审计
  ——复核重点候选：p-queue 是否真有必要（手写 drain 仅 ~20 行）、
  无界队列与锁语义的组合、OOPIF 自动继承订阅是否过宽。复核前本节
  仅作参考，不作为下游设计依据。

**D4-S4 仲裁器【已定 2026-11-22，Input 入集（用户裁决）】**

- **定位：空转的保险丝**。当前消费者（密码捕获/填充/自动化 surface/
  扩展桥）全是事件观察，无一需要排他；真正动 `Fetch`（拦截改写）/
  `Emulation`（UA/网络覆盖）的是未来物（C6 webRequest 垫片挂 C2-E2a、
  广告拦截）。结构先行，消费为零，成本近乎零。
- **排他域登记表**（per target）：`Map<domain, { consumerId, priority,
  grantedAt }>`，**初始集合 = Fetch / Emulation / Input**（用户裁决：
  Input.dispatchMouseEvent 是合成输入，两消费者同时打输入真实互踩；
  填充与自动化均为毫秒级短持有，冲突显式失败好过静默交错）。配置可
  扩展。`ConsumerSpec.exclusive` 声明即申请，S9 门过后生效。
- **冲突策略 = 显式拒绝，不抢占不静默排队**：被占即 reject
  `E_DOMAIN_TAKEN { domain, holderId, holderPriority }`。抢占 = 静默踢人
  （违 I4）；排队 = hold 语义复辟（S2 刚堵死）。priority 仅作拒绝原因
  参考信息；**策略函数隔离在 arbiter.ts**——未来要"排队等释放"换策略
  函数，API 面不动。
- **释放全自动，无手动 release 原语**：close() / detached / target 销毁
  即释放。短时占用（87 四步舞残影）= `session('transient-cdp') → 干活
  → close()`，幂等门面 + 自动释放覆盖。
- **执法靠 send() 拦截器（S4 的牙），不靠纪律**：①消费者
  `send('Fetch.enable')` 绕过声明 → 无登记即拒 `E_DOMAIN_NOT_GRANTED`；
  ②Hub 代管域（spec.domains 声明的）消费者手调
  `.enable/.disable` 一律拒——域状态机唯一主人，双 enable 是 87"两套
  真值"的 API 层重演。
- **观察域零仲裁**：Runtime/DOM/Page/Network（纯观察用法）多 session
  并存互不可见。

**D4-S5 生命周期与自愈【已定 2026-11-22】**

- **targetId 语义统一**：`targetId := webContents.id`，全局唯一；TabEntry
  增 targetId 字段（B3），feature 从 TabStore 取 targetId 调
  `hub.session()`；**Hub 零 tabs 依赖**，映射方向严格 `tabs → feature →
  hub`，hub 只认裸 targetId（87"切标签渲染层先变主进程后跟"的坑根因 =
  映射隐式散落，此处显式收进 TabEntry 单一真值）。Hub 服务任意
  webContents（标签/浮层子 WCV），不止标签。
- **事件源接线表（Hub 被动监听，无主动轮询）**：

  | 事件 | 来源 | Hub 动作 |
  |---|---|---|
  | `destroyed` | webContents | 全部 session → detached 终态；登记表/排他域/物理连接全清理 |
  | `debugger 'detach'` | wc.debugger（带 reason） | 全部 session → rebuilding（S2 退避循环接管） |
  | `render-process-gone` | webContents | 同上；reload 后同 webContents 可恢复 |
  | `targetInfoChanged` | CDP | 仅更新元信息缓存，零状态变化 |
  | `Target.attachedToTarget` | flatten auto-attach | 子会话建立（依赖 S3 待定项，**接线位预留**，审计落定后回填） |
  | `Target.targetDestroyed` | CDP 子 target | 子会话 detached，父不受影响 |

- **物理连接引用计数**：首消费者 attach + setAutoAttach，末位 close 拆；
  每 attach 分配连接 generation，in-flight 按 generation 记账、断连全拒
  （与 S2 锁契约衔接，无新增机制）。
- **泄漏防护双保险**：主路径 `destroyed` 事件清理；兜底 60s 对账扫描
  （registry 中 targetId 对应 webContents 已 destroyed 而未清理 → 强制
  detached 路径 + metrics `leak-guard` 计数）。事件驱动为主、对账兜底。
- **退出顺序**：`will-quit` 有序 teardown——全部 session close → 全部
  物理 detach → 清空 registry，避免退出瞬间 detach 风暴。

**D4-S6 消费者接线清单与灰度顺序【已定 2026-11-22，含用户挑战后的
成本闸】**

- **接线表（87 形态 → Next 形态）**：

  | 消费者 | 87 形态（痛点） | Next 形态 |
  |---|---|---|
  | transient-cdp-inspection | 四步舞，顺序一错全崩 | `session('transient-cdp') → 干活 → close()`；排他域声明进 spec，捕获暂停语义 = 域冲突显式失败 |
  | 密码填充 | 裸 attach，与捕获竞态 | 短持有 session + `Input` 排他域 + `whenReady()`；attach 竞态结构性不存在 |
  | 自动化 surface-detector | 自持租约 + watchdog | 长会话 + `onStatusChange`/`whenReady`；**watchdog 职责被状态机吸收** |
  | 密码捕获 | 长期常驻租约，挂 did-stop-loading 重挂 | 常驻 session（每标签一个），声明最小域集；提交事件经 Hub → feature → B3 事件流投影 |
  | DevToolbox | 铁律不占租约 | 已退役；与 Hub 共存 = openDevTools 场景（S2 决策④） |

  接线层无新增机制——五路全由 S1~S5 既有机构覆盖（设计自洽验证）。
- **灰度顺序（S7 零耦合结论：逐个迁，旧通道保留至验证通过）**：
  ① transient-cdp-inspection（验证幂等门面+排他域+自动释放）→ ② 密码
  填充（Input 排他 + 短持有）→ ③ 自动化 surface（长会话 + 自愈活体
  回归）→ ④ 密码捕获（常驻 + 多标签 + 事件流入投影，最后迁）。每步
  真机探针绿灯才进下一步；四步全绿 → 87 租约体系删除。
- **密码捕获 session 时机【已定 = 标签创建即建、全程持有】**：session
  生命周期 = 标签生命周期，87"detach 后只在下一次加载才重挂"的脆弱
  窗口消失；物理连接按 target 引用计数，多标签零额外物理成本。
  **用户挑战"会不会一直占用 CDP 不放"后的澄清与成本闸**：常驻在新
  架构不排他（观察域无仲裁，不挡填充/检查），但真实成本两项承认——
  per-target 物理连接（attach 不 enable 域，极轻，87 同样如此）+
  常驻域 enable（Runtime.enable 是公认贵域，10 标签各一份）。
  **两道闸**：①最小域集声明（spec.domains 只声明捕获真正需要的，常驻
  ≠ 全域常驻，声明面 = 成本边界）；②实测门禁——E39 探针：10 标签
  全常驻（含 Runtime.enable）CPU/内存基线对照（对照组无 session）。
  **后备策略（实测超标才启用）**：域按可见性调档——物理连接与 session
  对象全程持有，贵域仅激活/可见时 enable；实现 = 捕获消费者订阅 B3
  tab.activated + Hub 调档 API `setDomains()`（API 面 +1）；现在不做，
  只留策略位。固有交互承认：DevTools 打开期间捕获 rebuilding、关闭
  秒级自愈，捕获语义容忍间隙。

**D4-S7 探针映射【已定 2026-11-22，含用户要求的三层设计】**

- **协议与宿主整套平移**：87 探针协议（`{ id, name, needsElectron,
  timeoutMs, run(ctx) → { ok, summary, detail } }`）+ 宿主自动发现 +
  watchdog + 只读铁律（探针永不写 userData、日志只读追加）——验证过的
  成品资产一字不改；协议头部加 manifest 字段 `ci: false, batch:
  'E39-cdp'`（落 A4-D3 双分机制），编号沿用 10-19 = Electron 段惯例，
  Next 重新起号。
- **埋点 = Hub 内建诊断面（设计期定死，探针不刮日志不自建观测）**：

  ```
  hub.diagnostics（主进程事件源，B4 安全）
    session:transition  { targetId, consumerId, from, to, reason }
    session:phase       { phase: attach-start|attached-to-target|domains-enabled|ready, durationMs }
    session:command     { method, durationMs, ok, errCode }
    arbiter:reject      { domain, holderId, reason }
    leak-guard          { swept: n }
  ```

  埋点区 = 三文件三职责点：transport.ts（attach/detach 计时）、
  sessions.ts（转移点）、arbiter.ts（拒绝点）。探针期与运行期共用同一
  面。**B4 边界写死在诊断面**：只有 method 名/耗时/错误码，无参数/
  响应/载荷——诊断面生来合规。
- **五条探针规格**（fixture 归 `tools/probe/fixtures/`：跨域 iframe 页/
  表单提交页/普通页）：

  | id | run 概要 | 判定标准 |
  |---|---|---|
  | `10-cdp-devtools-coexist` | session(Runtime.enable) → openDevTools（docked/detached 两序）→ 观察存活或 detach → 关闭 → 观察恢复 | 记录 E39 真相（共存 or detach）；两序均断言"回 ready + 订阅重放完整" |
  | `11-cdp-flatten-oopif` | attach + setAutoAttach(flatten) → 加载跨域 iframe fixture → 记录子会话流 | 子会话出现、sessionId→targetId 路由正确 |
  | `12-cdp-session-timing` | N target 建 session，订阅 session:phase 聚合 p50/p95 | 输出时序分布校准退避参数；fail 线【待实测定标】 |
  | `13-cdp-self-heal` | 常驻 session → 人为 detach → rebuilding 退避 → 关闭 → ready | 恢复 + 订阅重放逐条到达（对照声明清单） |
  | `14-cdp-resident-baseline` | 10 标签全常驻 → 静置 30s → CPU/内存 vs 无 session 对照 | 增量阈值【待实测定标】——先跑基线再定 fail 线 |

  12/14 的"待实测定标"刻意为之：阈值不预设，首轮探针跑出基线后才写入
  manifest（"不纸面放行"的延伸——阈值本身也要实证）。
- 五条全部 `ci: false`（真窗口/真实页面/真实计时段）。

**D4 收官小结（2026-11-22）**：S1 API 面（含锁修订）/ S2 状态机 /
S4 仲裁器 / S5 生命周期 / S6 消费者接线与灰度 / S7 探针映射 = 已定；
**S3 事件分发待定挂审**（用户标记存疑，复核前不作下游依据）。四不变量
I1~I4 逐层落地：I1 = transport 单物理连接 + 模块层禁 import；
I2 = 门面 + send 拦截器（attach/detach/enable 原语 API 面不可达）；
I3 = session 对象跨重建稳定 + replay.ts；I4 = 全错误带原因
（E_SESSION_LOCKED / session-rebuilt / E_DOMAIN_TAKEN /
E_DOMAIN_NOT_GRANTED / target-destroyed）。五条探针挂账 E39。

## E. 工程结构与共享层【A】（待定——用户引入 F 区模块后暂缓）

- E1. Monorepo 布局：哪些目录是 Next/Modern 共享层（服务 Modern 保险分支）。
- E2. 测试策略（Vitest / Playwright；原项目"本沙箱不能用 Electron 验证"的约束对策）。
- E3. 打包分发（electron-builder / Forge、自动更新、签名）。

## F. Agent 架构【已收官 2026-11-22：F0/F0′/F1/F2（含 F2′）/F3/F4/F5/F6 全定】

> **2026-11-24 归档标记：本区已被 [`docs/agent-automation-architecture.md`](../agent-automation-architecture.md) 全面取代。**
> F0–F10 只保留为历史决策过程，不再是 Agent、自动化、CDP、感知、权限或交付顺序的实现合同。
> 特别是“CDP Hub/自动化 v3 已存在”“执行面 90% 就绪”“`targetId = webContents.id`”等旧前提不得用于新实现。

> 用户引入新模块：Next 原生支持 Agent 作为独立操作者。骨架采纳外部 AI 设想
> （五层分层 + Agent Host + 六项基础能力），经市面调研校准后开题。
> **核心定位：Next 不是「浏览器 + Agent 插件」，而是「从底层支持 Agent 作为
> 独立操作者的浏览器」。Agent 是架构核心参与者，但不是产品唯一卖点。**

**历史标注（已失效）**：2026-11-23 曾把本区视为 Agent 实现合同；2026-11-24 起，本区整体归档，现行合同改见 [Agent 与自动化架构](../agent-automation-architecture.md)。

### F0 市面调研摘要（2026-11-22，作为设计素材与必避清单）

**行业四象限（谁拥有控制回路）**：

| 形态 | 代表 | 本质 |
|---|---|---|
| Agent 拥有回路 | browser-use（MIT/Python）、Skyvern（AGPL/视觉优先） | 目标进 → 规划/执行/校验循环出 |
| 你拥有回路 | Stagehand（MIT/TS） | act/extract/observe/agent 四原语叠在 Playwright 上，AI 只用在 DOM 不稳定步骤 |
| 谁都不拥有 | Playwright MCP | 纯工具面，大量团队选择自己握回路 |
| 云端托管 | ChatGPT cloud browser、Claude computer use | 监督式，不进应用栈 |

**三种内核集成架构**：

| 架构 | 代表 | 机制 | 教训 |
|---|---|---|---|
| 外部驱动 | browser-use / Stagehand | CDP/Playwright 从外面开 | 无内核特权，但拿到全部 cookie |
| 内部隐藏扩展 | Comet | renderer 私有扩展 + Trusted Origin 经 externally_connectable 驱动 | **Varonis 拆穿**：Trusted Origin 被打穿 = 绕过模型直接驱动特权 API |
| 进程分离 + 结构化 IPC | Atlas (OWL) | agent 与 Chromium 分离，Mojo IPC 结构化命令，非 JS 注入 | 暴露面最小；UA 指纹 = Chromium 142，与我们同代际 |

**可抄清单**：DOM+a11y 组合观察格式（browser-use）；act/extract/observe 工具粒度（Stagehand）；planner/actor/validator 三段（Skyvern）；workflow 编译缓存（Skyvern → C1 自动化平台，token 省 ~90%）；Background Assistant 多任务仪表盘（Comet Max）；@tab 跨标签引用（Atlas）。

**必避清单**：Trusted Origin 特权桥（我们结构性不存在，保持没有）；Agent 带全量 cookie/权限静默运行（会话隔离进 F3）；prompt injection 无防线（工具最小特权 + 敏感操作强制审批）；每步必 LLM（确定性路径优先）。

**历史定位（已失效）**：2026-11-22 曾判断执行面已 90% 就绪；当前源码核验表明 Hub、自动化运行时和 Agent Host 尚未实现。现状及新交付顺序以 [Agent 与自动化架构 §1、§18](../agent-automation-architecture.md) 为准。

### F0′ 工具面定位（用户核心输入，2026-11-22）

**Agent 不仅要能执行脚本包，更要能绕过脚本包直接原子操作**——两者执行速度/效率不是一个级别（脚本包整段预编译路径 vs tool 毫秒级即时反馈）。**userscript 平台与自动化 API 封装成 tools**，AI 可像其他浏览器 AI 直接操作 DOM，或依靠视觉 API/CDP API 更轻松操作。

**工具面四层（全部主进程直调，零 IPC 折返）**：

| 层 | Tools | 载体 | 对标 |
|---|---|---|---|
| DOM 级 | click / fill / extract / observe / navigate | CDP Hub（DOM/Runtime/Input 域） | browser-use / Stagehand——普通网页主通道 |
| 视觉级（独有） | findTemplate / findColors / ocrLocate / ocrRead / surfaceDetect | C1 视觉平台底层模块 | Skyvern vision——但我们是**一等通道非 fallback**（Flash/游戏里 DOM 不存在） |
| userscript 等价级 | GM_setValue / GM_xmlhttpRequest 等价面 | **主进程原生实现，不走 VM 扩展沙箱** | GM 能力共享语义、不共享通道（C6 userScripts world 是用户脚本的隔离环境，Agent 是主进程一等消费者） |
| 自动化原语级 | 定位引擎四型 / action 原语 / 工作流单步触发 | **直调 core/automation 底层模块，绕过 C1.7 沙箱预算** | 沙箱预算防的是不可信用户脚本；Agent 可信但需自建资源闸（per-session 工具调用预算 + 视觉操作节流，F2 定） |

**架构收益**：DOM 模式 vs 视觉模式 = 同一 session 可混用的两族 tools，选择权在 Agent 决策层——普通网页走 DOM（快、token 省），Flash/canvas/反爬切视觉。比 Stagehand（仅 DOM）与 Skyvern（vision 为主）完整，双引擎 Flash 场景成为 agent 工具面的独特优势。

### 议程

- **F1** 分层与依赖方向定案（五层映射到 D1 分包；三处收紧初评已给：Agent Host 落 `features/agent-host`、mode 映射 Hub 既有机构非新枚举、Adapter 窄接口）
- **F2** Agent Host 详细设计（会话/目标绑定/工具注册/任务生命周期；工具面按 F0′ 四层展开；资源闸定值）
- **F3** 权限与审批系统（与 view-gate/排他域/Chromium permission handler 三层切分；会话隔离；prompt injection 防线——**本区最难点**）
- **F4** 观察系统一致性（DOM+a11y 组合格式、原子观察快照、导航代际 expectedNavigationId、validator 接入）
- **F5** Runtime Adapter 窄接口（云端/本地/外部 Agent 可替换；换 Adapter 不改 Host 一行）
- **F6** 探针与里程碑（15 号探针：A/B 双标签实验——用户操作 A，程序在 B 完成观察/截图/DOM 操作/输入并跨导航恢复绑定；Agent Host 三件事验证；142 补丁集 #52844/#54311 留 C7 邻位随后台出帧探针一并处理）

### F1 分层与依赖方向【已定 2026-11-22】

**五层 → Next 实体映射**：Browser Core = core/（D1-S2，不新建）；Browser Capability API = Hub 门面 + protocol 命令面（不新建）；Automation Capability API = C1 底层模块 + F0′ tools 封装层（封装新建）；**Agent Host = features/agent-host/（新建，与 password/automation 平级）**；**Runtime Adapters = features/agent-host/adapters/（新建，随 Host）**。五层是逻辑分层，不要求独立进程。

**三条依赖铁律（结构保证非纪律）**：

```
adapters → agent-host → (Hub 门面 / protocol / automation tools)
                              ↓
                    core/（不知道 agent 存在）
```

1. `core/` 零 agent 感知——D1"Hub 不反向 import feature"自动保证，无需新机制；
2. Agent Host 不 import 其他 feature 内部——调自动化走 tools 封装面（F0′），调其他 feature 走显式导出面；
3. adapters 只认识 agent-host 接口——推理框架的一切（工具 schema/流式协议/记忆管理）挡在 adapter 内，**换 adapter 不改 host 一行** = 可替换性验收标准。

**六项基础能力 → 机构归属**：标签页身份 ✅ 已根治（D4-S5-1，API 面无 getActiveTab()）；控制权争用 🟡 域级仲裁已有、意图级缺 → F3；观察一致性 🟡 快照缺 → F4；输入系统 🟡 排他域已有、误操作防护缺 → F3/F4；权限系统 ⬜ 全新 → F3（最难点）；任务生命周期 ✅ Hub 生命周期事件 + B2 恢复机构已有，挂接即可。

### F2 Agent Host 详细设计【已收官 2026-11-22：S1~S6 全定 + F2′ 轨迹格式定案】

**S1 会话模型【已定】**：session/task 两层——AgentSession（执行上下文，单 target，持 Hub session + tools 上下文）与 AgentTask（决策层工作单元，目标导向，管多 session；目标/进度/审批状态挂 task 层）。不分层则监督者被迫单 session 轮询几十 target，违反显式 target 铁律。mode 三态映射 ConsumerSpec（observe=观察域 / cooperative=观察+操作无排他 / exclusive=申请 Input+排他域，被拒显式失败）；创建时锁定，调档走 upgrade(mode) 显式 API 不静默升权。生命周期：createSession 即返、ready 前 tools reject（复用 E_SESSION_LOCKED）；target destroyed → session 终结事件、task 决定重建或放弃；closeSession 幂等；**人类关标签不需要问 agent**——人永远赢是争用优先级基线。task 持久化：a) 内存态起步（监督场景丢了重新下发），store.db 恢复留真实需求出现再做。

**S2 工具注册面【已定】**：AgentTool 结构（name 域前缀命名 / description 给 LLM / zod schema 入口强校验 / level / requires 域声明 / run）；**Host 是唯一注册点**（adapter 只能要 manifest 不能注册工具，防推理框架绕审计）；level/requires 注册时静态声明；schema 校验失败不计资源闸预算。权限三级：read（无审批）/ write（默认无审批，F3 可挂可配置审批）/ sensitive（**强制审批**，F3 落定前过渡策略=直接拒绝）。四层清单 v1：DOM 层（observe/extract/click/fill/navigate，read×2+write×3）；视觉层（findTemplate/findColors/ocrLocate/ocrRead/capture/surfaceDetect **全 read 只找不算**，操作归 dom.clickAt——工具粒度正交，复合工具=决策进工具=不可审计，不做）；GM 等价层（setValue/getValue/xmlHttpRequest**[sensitive]**/notification/clipboard）；自动化层（locate 四型/action 原语/workflowStep/workflowRun）。**sensitive 不对称裁决**：同一能力（如 xmlHttpRequest）用户脚本可用、agent 要审批——脚本是人写的静态代码审计一次，agent 是运行时动态决策每次不可信（成熟行业共识，用户认可"安全先用成熟方案"）。结果大小治理：maxResultBytes 超限截断+标注；dom.observe 双粒度（完整树/精简交互元素，browser-use 同款）；截图等二进制不进 LLM 上下文，返回文件路径引用由 vision-capable adapter 自决读图。

**F2′ 轨迹录制格式【提案已收，四轴+环形缓冲定案，schema 与参数待真机定标】**（用户设想 2026-11-22：类视频类日志的数据结构，录制脚本并被 AI 理解，服务"AI 自主制作脚本包"=工作流编译器的素材层）：

- **时间轴**：每帧时间戳（事件日志，极小）；**操作轴**：每帧操作信息，无操作=显式静默标记（比 Playwright 离散 action 流更适合"等待也是语义"的挂机场景）。
- **视觉事件轴【F2′ 新增，用户挑战驱动】**：实时检测器命中记录（鱼咬钩@t=123.4s conf 0.87/阶段字牌/画面异常突变）——**静默段关键信息的结构化形态**。用户挑战"高速游戏必须连续采样否则丢关键信息"（鱼咬钩 0.5s 发生在无操作静默段）成立 → 操作轴驱动采样结构性错配 → 修正为四轴。
- **视频轴 = 环形缓冲 + 双触发固化**（ShadowPlay/行车记录仪模式）：实时层低帧率（8~15fps，检测层本来就在跑 game-surface-detector，零新增成本）连续抓帧进内存环形缓冲（~60s）→ 事件（操作事件 ∪ 视觉事件）触发固化"前 30s+后 10s"落盘。**连续分析 ≠ 连续存储**。
- **鸡生蛋问题（什么算关键事件）三层解**：①一级触发=廉价启发式（模板/找色/阶段切换/变化率突变，平台现成检测器）；②AI 事后升档（判断信息不足→调高该类事件录制等级，下次录制补上——在线学习闭环，比无限回看务实）；③手动标记兜底（缓冲窗口内回溯固化）。
- **发给 AI = 裁剪是视图层不是删除**：完整时间轴+操作轴+视觉事件轴+按双轴选出的关键帧；"静默但有事件"段自动带帧。原始层 TTL 过期后只剩三轴结构化数据（操作轴本身就是脚本包生成骨架，画面是理解辅助，过期可接受）。
- **成本账**：60s×10fps=600 帧，720p JPEG q70 ≈50KB/帧 ≈30MB/标签；10 标签并行=300MB 偏大 → 缓冲上限进 F2-S3 资源闸（挂机模式默认降分辨率/缩窗口）。原始层存储=文件系统+索引进 DB（blob 不进 SQLite，sprite 素材同律）；密集段可选视频编码（H.264/WebM，~5MB/min vs PNG 1.8GB/min）。
- **escape hatch**：持续全录模式（视频编码+大 TTL）——首次熟悉新游戏用全录喂 AI 学检测特征，再切正常模式。
- **录制源独有优势**：后台截图（surface detector/captureScreenshot）录制不抢前台，用户边玩边录，Playwright 系做不到。
- 行业对应物：Playwright trace viewer / DevTools Recorder / GUI agent trajectory 数据集（OSWorld）——结构同构，差异点=显式静默标记+视觉事件轴+AI 回看/升档闭环。
- 【待定标】三轴 schema 具体字段、帧率/缓冲时长/分辨率/固化窗口参数——真机探针后定（归 F6）。

**S3 资源闸【已定】**：原则=预算是保险丝不是配额（触线=失控信号，非限制正常使用）；**Host 层单点记账**（87 沙箱预算三处分散配置的教训，工具内部不自查）。五道闸 v1（全部探针定标可调）：①工具调用速率 per-session 60 次/分（LLM 延迟天然限速，正常 10-20/min）；②per-task 总量 5000 次；③单调用超时 30s；④轨迹缓冲 per-target 64MB + 全局总池 512MB（超池按 task 活跃度降档不拒服务）；⑤视觉节流同 target 截图 500ms 间隔——**工具级 capture 与录制层 8~15fps 流分开记账，两条通道不混**。超限行为：reject E_BUDGET_EXCEEDED{gate,usage,limit} + task 层预算事件，决策权交还 agent（I4 哲学延续）；唯一自动干预=速率闸连续 3 次触发 → session 降级 observe（防"收到失败原样重试"死循环）。

**S3′ 执行模型【已定，用户核心输入】**：同步阻塞是反模式（workflowRun 20s 阻塞循环+占速率闸+堵对话）。**双轨**：同步工具（毫秒级）直接返回；异步工具（workflowRun/等待类/长导航）立即返回 taskId 前台释放。**唤醒源五路收敛 task 层一条事件流**：后台任务完成/超时/定时闹钟 scheduleWake/视觉事件（鱼咬钩）/target 状态变化 → 唤醒 adapter 推理循环——"AI 怎么知道是否完成"的答案=不是它去查，是完成来叫它；挂机场景 agent 下发工作流后睡掉、视觉事件唤醒；wait 工具族全异步，永不原地 sleep 轮询。异步任务执行期间不计入 per-session 速率闸（闸只记决策循环真实调用）。**防睡死三保险**：①异步任务强制显式 timeoutMs（Host 无默认放行）；②scheduleWake 定时唤醒一等工具；③循环级 watchdog（adapter 心跳，无活跃推理 60s → 标记停滞 → UI 亮灯可恢复——87 watchdog 教训升格为 Host 结构行为）。**用户与 AI 交流【两层并存，用户裁决】**：软消息=入 task 事件流**插队队头**下一轮必达，不自动取消任何东西（双轨模型下 agent 前台几乎总空闲，排队=下一步就看到；打断丢上下文；语义歧义交给 LLM 带 cancelTask 工具自决）；硬控制=UI 停止键**绕过 agent** 直杀 task/后台任务/session 降 observe（人永远赢的物理形态，不依赖 agent 听话）；sensitive 审批点=强制打断点。**消息永远排队（插队最前），打断永远显式（按钮/审批），不靠语义猜**。

**S4 目标绑定与导航恢复【已定】**：三级寻址——targetId=webContents.id（D4-S5-1）/ frameId（flatten 子会话映射）/ **navigationId（per-target 递增，主帧导航 +1，S4 新增）**；工具 target 参数统一 `{tabId, frameId?, expectedNavigationId?}`。导航代际治"旧意图打新页面"（表单页跳转后 fill 打到新页面——命令没错配语义全错位；D4 generation 防物理重建，此防同连接内页面换代）。执法复用 Hub 机构零新增：frameNavigated 已订阅计数；**write 级强制校验**（不符 reject E_NAVIGATION_CHANGED{current}，错误即信息，agent 重观察自愈）；read 不校验（省 token）。标准节奏被结构塑造成 observe→act(带代际)→失败自动重观察 = F4 validator 模式地基。**行业先例核实（用户问"有没有可参考的"）**：Selenium StaleElementReference（2007 元祖问题）/ CDP executionContextId+DOM.documentUpdated（协议层原生代际，作实现底座）/ Playwright locator 隐式重试 / 87 DevToolbox 节点 id 作废亲身教训。**与 Playwright 关键差异**：隐式自动重试对脚本合理（语义固定），对 agent 错误（页面变了语义本身变，"重新找到输入框照常填"恰是错的）——agent 需要的不是重试成功而是"页面变了"的事实显式暴露。target 销毁→task 策略钩子 recreate|abandon|escalate（默认 abandon）；引擎切换=新 targetId 显式重建不自动迁移（D4-S2 决策④同律）。开销预估 <10%（同代际连发免重复 observe，只有跨导航才重观察）。

**S5 任务生命周期与状态持久化【已定】**：task 状态机六态——created→running⇄waiting(等唤醒，挂机监督常态)→终态四兄弟 done/failed/cancelled/**stale**(watchdog 停滞标记，UI 亮灯可 resume/kill)。终态全部产生审计日志条目（目标/时长/工具调用计数/终态原因）——task 内存态丢但事件有痕，重启后 UI 读日志提示"N 个任务未完成"（不建恢复机制）。并发上限：全局 task 16 / per-task session 32，超限 reject E_TASK_LIMIT 无自动排队（排队=意图被延迟执行，显式失败让人决定）。收尾顺序：will-quit 时 task 层先收（异步任务 cancel 带原因→session close）→ Hub teardown（D4-S5-5）→ 审计日志 flush；崩溃无收尾、依赖方全内存态重启自然干净，审计日志末条缺正常退出标记=启动提示异常退出。

**S6 事件投影【已定，F2 收官】**：原则=agent 一等操作者必须永远可见（Comet 黑箱教训）。agent-host 作 B3 事件流新事件源，投影五类（task 状态转移/摘要节流 1s/当前动作摘要/预算阈值提示/审批请求最高优先级）；不投影工具完整参数结果（B4 同律）与 CDP 流量。UI 挂钩件（形态归 A5，只定存在性）：①**标签级 agent 指示器必须有**（exclusive/cooperative 显示标记，observe 不显示防噪音）；②agent 面板（task 列表/停止键=硬控制入口/审批队列/审计日志；命令面 createTask/cancelTask/resumeStale/respondApproval 全走 protocol）。审批 UI 方向：**面板队列优先 + 模态例外**（批量挂机审批高频，模态烦死；未决时工具调用挂起、超时自动拒绝宁保守；极高危如支付升模态）——最终形态 F3 一并定。

### F3 权限与审批系统【已收官 2026-11-22：S1~S5 全定】

**F3-0 调研摘要（2026-11-22）**：

**Operator 四模式（可抄框架）**：Takeover（敏感输入人接管，agent 不截获）/ 用户确认（只在有外部后果动作前确认）/ 任务限制（拒绝银行类高风险任务）/ Watch mode（敏感站点强制人工监督）。审批疲劳警告：确认框弹多=新的自动允许 → 全行业收敛到按后果分级确认（与我们 read/write/sensitive 三级完全收敛）。MCP rug pull 教训：批准后工具描述可被偷换 → 检查必须持续不能一次性审批。

**Prompt injection 三阶梯（行业铁律：无根治方案，只能纵深减险）**：OpenAI/Anthropic/DeepMind 联合红队=12 种已发表防御全被自适应攻击 90%+ 绕过。①启发式（Spotlighting 不可信内容来源标记 50%→2%，必上；instruction hierarchy 提示）②模型级（对抗训练，不适用）③系统级（CaMeL 能力跟踪/Dual LLM 隔离——唯一可证明级）。**CaMeL 原则工具面版**：页面内容只能填参数值、永不改变工具选择逻辑（设计铁律）。**Lethal trifecta（Willison）**：私人数据+不可信内容+外发通道三腿齐占=可注入盗窃；浏览器 agent 三腿全占，**但 BFB 主力场景不是**——挂机/游戏工作流 agent 不读 DOM 内容（视觉事件轴=结构化摘要）天然砍注入腿；砍外发腿最便宜（微软/GitHub 补丁同款）。Claude for Chrome：site-level permissions + action confirmations 限 blast radius。

**议程**：S1 四机构权限切分 / S2 审批模型（Operator 四模式映射+敏感站点名单+rug pull 防御）/ S3 会话隔离 / S4 注入防线落地 / S5 探针。

**S1 四机构权限切分【已定】**：view-gate（人类查密码 OS 鉴权，原样保留）/ Chromium permission handler（站点权限，需桥接）/ Hub arbiter（资源域，D4-S4 引用）/ agent 权限层（新，意图层）。**两条硬边界（结构非配置）**：①agent 永不碰明文密码——工具面里不存在"agent 查看密码"，只有 password.autofill 触发既有流程、明文不进 agent 上下文（I2"原语不可达"的权限版：最好的防御是能力不存在）；②agent 不代答权限弹窗——Chromium handler 照常走人类决策，无人值守补法=预授权清单（站点+权限组合事先批过自动放行），未预授权=E_PERMISSION_PENDING 绝不静默代答（Comet 危险默认不抄）。**决策管线**：schema 校验→资源闸→站点上下文检查→level 审批→执行，每步失败带原因第一道挡住即停（D4 send 拦截器同构）；站点上下文每次调用过检（rug pull 防御，watch 站点每次强制）。

**S2 审批模型【已定，用户修正裁决范围】**：站点三档默认名单（用户可编辑，域名后缀+通配，每次调用过检不缓存放行=rug pull 防御）：**deny**（支付/银行/证券——write/sensitive 全拒 observe 可用，Operator 任务限制映射）；**watch**（邮箱/社交私信/云文档/网盘——write 逐条挂审批 sensitive 拒，watch mode 映射）；**普通**（按 task mode+level 走默认管线）。Operator 四模式映射：Takeover=密码类结构不存在+支付 deny 挡；确认=sensitive 队列+watch 逐条；任务限制/Watch mode=deny/watch 档。**task mode × 档位交互（用户修正）**：exclusive 建立时前置校验目标站点档位，watch/deny 拒建带原因（用户调档后显式重试，责任前置到配置时刻）——**只管 exclusive 无人值守特化场景**；cooperative 日常工作在 watch 档完全可用：人在场逐条审批队列就是设计好的协作节奏（S6 面板），日常工作场景不因安全档位被拒之门外。

**S3 会话隔离【已定】**：task 创建参数 profile: 'shared' | 'isolated'。**默认 shared**——挂机监督与日常工作两大主力场景都依赖登录态，强制隔离自废武功；isolated=独立持久分区（"无痕但持久"，用于不可信任务：陌生站批量收集/可疑页测试，可手动登录测试账号，持久=免重复登录，持久本身无新增风险）。**共享前提减险三条**（b 的危险不是共享是"agent 摸得到 cookie"）：①工具面无 cookie 读取工具（getCookies 不存在——agent 能用登录态自然操作但拿不出 cookie 值，注入偷不走）；②外发腿已砍（xmlHttpRequest sensitive+无其他外发工具）；③私人数据腿由 S4 防线管。**三腿被砍成两腿**（不可信内容+受控操作）：注入最多让 agent 页面里乱点，偷不走数据——比 Atlas/Comet 更强的安全姿态，场景白送。

**S4 注入防线落地【已定】**：五层纵深。①减概率=Spotlighting：页面来源工具结果（observe/extract/vision 描述）进上下文统一包来源信封 [UNTRUSTED page targetId navId]，**Host 层 ToolResult 封装**（不依赖 adapter 自觉，未标记版本拿不到）；②断控制流=CaMeL 原则工程化：控制类参数枚举校验（workflowRun 只收注册表 ID，页面文本无效）、click 用 agent 自生成 selector/坐标——诚实边界：LLM 决策自由度无法机械执法，此条为设计审查原则（新增工具审"哪参数可被页面间接操纵"）；③挡后果=S2/S3 已定；④止损=硬停止+速率闸降级+**轨迹录制=黑匣子**（F2′ 事后审计用途）；⑤监控=Operator 有独立 monitoring model 我们没有，轻量替代（速率闸/watchdog）覆盖失控形态，剩余风险接受并记录不装假防线。

**S5 探针【已定，F3 收官】**：注入 fixture 页（隐藏文本注入指令样例）。**关键诚实边界：agent 决策行为无法确定性断言（LLM 不可预测），探针验证防线机构而非"模型不被骗"**——被骗率是 adapter 层模型质量的事，我们合同只保证机构在注入成功时兜得住后果。三条：probe-agent-spotlight（信封必在✅确定性）/ probe-agent-gate（注入场景 sensitive 必挂审批、deny 必拒✅）/ probe-agent-trifecta（全工具面扫描无 cookie 读无外发控制参数枚举生效✅静态+动态混合）。

**F4 观察一致性【已定 2026-11-22】**：原子观察快照=dom.observe 一次返回 DOM 精简树+a11y 树（CDP Accessibility 域，Hub 观察域 +1 零新机制）+可选截图，全带 navigationId 戳；采集期间代际变化→整包作废重采（原子性=同代际，复用 S4 navigationId）。双粒度落定：精简=仅交互元素+短标签（browser-use 同款省 token）。**validator 不建新机构**：动作后校验=agent 自 observe(before/after) 对比（Skyvern 同款 LLM 判断），Host 只保证快照原子+navigationId 可比，不造 dom.diff（两快照进 LLM 上下文自己比，机构零新增）。

**F5 Runtime Adapter 窄接口【已定】**：AdapterContext 三件——manifest（Host 唯一注册点导出）/events（task 事件+五路唤醒源）/executeTool（Host 决策管线全过）。推理循环/工具 schema 格式/流式协议/记忆管理全挡 adapter 内（F1 铁律③），换 adapter 不改 Host 一行=验收标准。**首个内置 adapter=OpenAI-compatible 协议**（chat completions+tool calling）：一个 HTTP 协议覆盖云端+Ollama 本地端点，不绑 SDK（narrative-dice 教训：Host 只信"消息进→工具调用请求出"）。用户消息入口=events 唤醒事件一类（S3′ 已定），adapter 无特殊通道。

**F6 探针与里程碑【已定，F 区收官】**：探针汇总（全 local-only ci:false）——probe-agent-spotlight/gate/trifecta（F3）、**15-agent-ab-experiment**（第一里程碑：双标签 A/B——用户操作 A、程序在 B 观察截图/DOM 操作/输入并跨导航恢复绑定；验证 Agent Host 三件事 createSession/observe/executeTool）、16-agent-recording-calibration（F2′ 参数定标：帧率/缓冲/固化窗口）。里程碑：**M0 架构验证**（15 号探针全绿，不纸面放行）→ M1 工具面（四层 tools+资源闸+权限管线）→ M2 挂机监督者 MVP（轨迹录制+视觉事件唤醒+exclusive 挂机，真机钓鱼回归）→ M3 工作流编译器（AI 生成包→C1 包库，端到端试跑）→ M4 通用助手（adapter 成熟+审批 UX，日常场景实用验收）。142 补丁集 #52844/#54311 维持 C7 邻位挂账。

### F7 内核补丁集清单（142 自编译，结题前盘点 2026-11-22）【待审计——清单为公开检索的高价值命中，非全集；A/B 级每条必要性须真机探针确认后方可进入自编译补丁集，审计前勿据此改内核构建】

**A 级——挂机出帧核心（三件一组，缺一不可）**：

| PR | 内容 | Backport 线 | 备注 |
|---|---|---|---|
| **#52844** | hidden 时 setBackgroundThrottling(false) → show 后 WebContentsView 白屏（WasShown 绕过 view，LocalSurfaceId 失配）；修复走 ShowWithVisibility(kHiddenButPainting) | 42/43/44（39 线无） | 已挂账；探针=hidden 出帧 |
| **#54311** | **#52844 的 follow-up**（必须一组 backport）：节流 false→true 后 hidden 页面残留全速渲染/visibilityState 假 visible | 44/45 | 含 Chromium 侧补丁 allow_disabling_blink_scheduler_throttling_per_renderview.patch，rebase 时注意 |
| **#54090【本轮新增】** | hidden 窗口（show:false）跨导航停渲染 → ready-to-show 不触发、rAF 停（disable_hidden.patch 键控 host visibility） | 43/44/45 | 直接命中挂机场景；探针=后台标签出帧（已挂账，规格需覆盖三条各自故障形态：show 后白屏/节流恢复残留/跨导航停帧） |

**结构性提醒**：三条全是 Electron 对"hidden 窗口持续出帧"意图的补丁——BFB 挂机需求与 Electron 官方节能方向相反，属**对抗性维护**：每次跟 Electron 版本都要 diff 渲染可见性行为（releases.electronjs.org 的 rendering/hidden/WebContentsView/capture 类目是监视点，本次高价值条目全部来自此）。

**B 级——正确性类（按需评估，探针定必要性）**：

| PR | 内容 | 相关性 |
|---|---|---|
| #51246 | hidden WebContentsView 内 -webkit-app-region: drag 仍劫持父窗口拖动（Windows，40/42+） | WCV 多标签正确性，低概率 |
| #51217 | Windows 无边框透明窗口 setResizable(false)→(true) 往返丢透明（42+） | 浮层 WCV |
| #53810/#53816 | capturePage() offscreen 窗口按 display scale 重采样而非 offscreen.deviceScaleFactor（44） | 仅当启用 offscreen rendering；自动化视觉若走 offscreen 备选则升级为 A 级 |
| #52365 | macOS 透明/点击穿透窗口被误判 occluder → 误节流（42+） | mac 实验位，低优先 |

**C 级——版本纪律（非补丁）**：自编译基线选 **39.x 最新 patch**（如 39.8.1+，含 CVE-2026-34774 offscreen UAF 等安全修复积累；我们不用 offscreen:true 不受影响，但基线纪律照守）；Chromium 142.x 取最新 sub-version 安全补丁。上游 ANGLE/Dawn/V8 backport（如 #54222）按需跟进。

**D 级——Flash/PPAPI 无新增**：检索确认 Chrome 88 移除的是 Pepper Flash 自带运行时（旧闻），PPAPI 插件基础设施在自编译中保留（142 已打通实证）；PPAPI 前瞻（144+ legacy IPC 移除等）已在 forward-version spec 版本梯队，无需新补丁。

**诚实边界**：公开检索无法穷尽 Electron 40~45 全部 release notes，本清单是"高价值命中"非全集；A/B 级每条必要性须真机探针确认（#54090 是 show:false BrowserWindow 场景，我们是 WCV，是否受影响探针判定）——不纸面放行。

### F8 决策层实现选型（F5 延申，2026-11-23）【待审计——候选版本/许可/体积为 npm registry 实测元数据，「适配度」评级为推断；审计通过前不得写入 package.json】

**为什么有这一条**：F5 只定了窄接口（manifest / events / executeTool）与「首个内置 adapter = OpenAI-compatible 协议、不绑 SDK」，没定实现层的三件事——循环谁写、依赖捆不捆、用户机器上没有任何 AI 工具时怎么办。2026-11-23 就这三点追问后形成本调研：决策层职责边界、引入外部 CLI 的意义、无 CLI 时的默认路径。

**一、职责边界（不改 F3/S3/F4 合同）**

决策层只产出「下一步工具调用」，六件事：目标解析与分解、工具选择与参数生成、结果解释与自我修正、上下文管理（裁剪/压缩/token 预算）、边界判断（验证码/支付/陌生站点→申请审批）、长任务编排。它**不**执行动作（Host 唯一执行者）、**不**做权限判定（F3）、**不**做资源记账（S3）、**不**保证观察原子性（F4）。一句话：**决策层是提议者，Host 是执法者**——F1 铁律②③的结构保证不变。

**二、三档策略（建议，待审计）**

| 档 | 依赖 | 能力 | 默认 |
|---|---|---|---|
| **A0 零决策层** | 无 | 预编译工作流执行、录制/回放、视觉事件唤醒、异常暂停交接（人接） | **默认，开箱即用** |
| **A1 云端/BYOK** | 一个 OpenAI-compatible 端点（云端 key，或 Ollama / llama.cpp server） | 自然语言下任务、异常改写、录制后编译成包 | 可选 |
| **A2 外部 CLI / 本地模型** | 用户机器上已装的 Codex / Claude Code 等 | 开放式多步任务、跨站点编排 | 可选，**只检测不捆绑**（Tabbit 同款策略） |

依据：F0 必避清单「每步必 LLM（确定性路径优先）」；挂机 8 小时每步问 LLM 的延迟与成本不可接受；M2 挂机 MVP 的目标形态（确定性工作流 + 视觉事件唤醒）本身不含决策层。**A0 成立即回答「用户什么都没装」**——核心卖点不依赖任何 AI 组件。

**三、候选清单与筛选（2026-11-23 实测 npm registry）**

筛选硬约束三条：①**不接管浏览器**（我方有 Hub/CDP 与工具面）②**纯 JS 可打进 bundle、无 postinstall 下载**（否则破坏固定工具链与来源门禁）③**许可干净**（MIT / Apache-2.0，AGPL 出局）。

| 用途 | 候选 | 版本 | 许可 | 解包体积 | 依赖特征 | 判断 |
|---|---|---|---|---|---|---|
| 决策层 | `ai`（Vercel AI SDK v7） | 7.0.179 | Apache-2.0 | 8.1 MB | 仅 `@ai-sdk/*`，零原生，Node≥22，**ESM-only** | 首选【推断】 |
| 决策层 | `@openai/agents` | 0.22.0 | MIT | 23 KB | 带 `openai` SDK | 备选 |
| 本地模型 | `node-llama-cpp` | 3.22.3 | MIT | 39.4 MB | **postinstall 拉预编译二进制**（`@node-llama-cpp/win-x64` 等可选包） | 违反门禁；需离线镜像，建议本阶段不做 |
| 本地模型 | `@huggingface/transformers` v3 | — | Apache-2.0 | — | wasm/WebGPU，无原生模块 | 仅小模型/槽位填充，不做长程决策 |
| 外部 CLI | `@openai/codex-sdk` | 0.171.0 | Apache-2.0 | 78 KB | 依赖 `@openai/codex` 平台二进制（Tabbit 捆的即此物，247 MB）+ OpenAI 登录 | 不捆绑 |
| 外部 CLI | `@anthropic-ai/claude-agent-sdk` | 0.3.330 | 非标准（见 README） | 5.0 MB + 平台包 | peer 需 MCP SDK / anthropic SDK | 不捆绑，许可须先审 |
| 工具面外露 | `@modelcontextprotocol/sdk` | 1.32.2 | MIT | 4.3 MB | 带 express/hono/jose/ajv | 只进 utilityProcess，或手写 stdio 子集 |

**四、`ai` 与既有决定的对应（若审计通过，F3/S3/S1/S4 已有现成对应物）**

| 我们已定 | AI SDK v7 现成 |
|---|---|
| F3 三级权限 read/write/sensitive | `toolApproval`：`'approved'` / `'denied'` / `'user-approval'`（可带 reason），整包回调或逐工具配置 |
| S3 五道闸里的步数闸 | `stopWhen`（默认 `isStepCount(20)`），可接我们自己的计数器 |
| S1 mode 三态 observe/cooperative/exclusive | `activeTools`：按 session 只暴露该模式允许的工具 |
| 「同 target 必须串行」 | `toolCallConcurrency: 1` |
| Host 是唯一执行者 | `execute` **可缺省**——工具调用转发给调用方（Host）执行后回填 |
| 注入防线「页面内容只能填参数值」 | `inputSchema` 强校验；`allowSystemInMessages` **默认 false**（官方理由即防注入） |
| F5「换 adapter 不改 Host 一行」 | `dynamicTool` + 运行时 schema，工具清单由 Host manifest 生成，库本身不认识浏览器 |

来源：[ToolLoopAgent 参考](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent)、[Tool Calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)、[Loop Control](https://ai-sdk.dev/docs/agents/loop-control)。

**五、明确排除（附理由，避免重复调研）**

- **Skyvern**：AGPL-3.0（[官网自述](https://www.skyvern.com/developers)），传染性许可，不可进闭源发行包。
- **Stagehand 4.4.0**（MIT）：`new Stagehand({env:"LOCAL"|"BROWSERBASE"}).init()` 自己拥有浏览器，再让 Playwright `connectOverCDP` 反连；带 otel + Browserbase SDK 依赖。**只作参考实现**（observe/extract 粒度），不作依赖。
- **Mastra**：Apache-2.0 核心 + EE 目录付费混许可，逐目录挑许可的成本高。
- **LangGraph.js**（MIT）：图/状态机抽象对「一 task 一循环」过重；审批用 `interrupt()` 不如 `toolApproval` 直接。
- **Nanobrowser**（MIT）：扩展形态，Electron 不可用。**browser-use**：Python。**PageAgent（阿里）**：页面内自嵌入，非驱动任意站点。

**六、与 F5「不绑 SDK」的冲突（审计须先裁决）**

F5 原文：首个内置 adapter = OpenAI-compatible 协议，「不绑 SDK（narrative-dice 教训）」。`ai` 是库不是协议；即便它只出现在 `adapters/` 内部（F1 铁律③允许），仍是新增依赖。三个选项：

- **选项 1 维持原判**：adapter 内手写 OpenAI-compatible 循环（估 300–500 行），零新依赖；A1 = 自研薄循环。
- **选项 2 修订 F5**：首个 adapter 用 `ai`，SDK 只活在 `adapters/` 内，Host 与工具面零感知，验收仍是「换 adapter 不改 Host 一行」。
- **选项 3 并存对比（建议）**：先按选项 1 落地，`ai` 版作为第二个 adapter，用 15 号探针 A/B 定夺；选项 2 待数据后议。

**七、审计通过后必须同步的工程动作**

1. `ai` 是 **ESM-only** → 必须打进 `out/main`；main 侧**不得**加 `externalizeDepsPlugin`（否则 CJS 主进程 require ESM 失败）。现行 `electron.vite.config.ts` 为 `main: {}`，默认打包依赖，符合。
2. `app/package.json` 用精确版本（与现有依赖风格一致，不用 `^`）。
3. `app/NOTICE.md` + `app/licenses/` 增 Apache-2.0 全文；`pack-win.cjs` 若已枚举许可证/产物断言，需同步。
4. 新增直接依赖 `zod`（`ai` 的 peer）。

**八、待验证项（审计清单）**

- [ ] `toolApproval` 挂起 → 人工批准 → 续跑的语义与恢复点（仅读官方 reference，未真机）。
- [ ] `execute` 缺省时 `toolCallId` 与调用顺序是否无损保留（决定 Host 能否零损接管）。
- [ ] 打进 Electron 39 / Chromium 142 主进程后的体积增量与冷启动开销实测。
- [ ] A0 vs A1 同任务对比（步数 / 延迟 / 失败率）；**M2 是否需要 LLM 由这组数据裁决**，不纸面放行。
- [ ] `@ai-sdk/openai-compatible` 对 Ollama / llama.cpp server 的 tool calling 兼容差异。
- [ ] 许可证全文与声明落位核对。
- [ ] 外部 CLI 检测面（Codex / Claude Code 版本探测与协议差异）是否值得做、何时做。

**诚实边界**：版本、许可、体积、依赖为 2026-11-23 从 npm registry 拉取的元数据【事实】；「首选」评级与「估 300–500 行」为【推断】；本条未做任何打包或运行验证，也不修改 F5 合同——只把「实现选型」从隐含变成显式待审计项。

### F9 定位修订提案：通用浏览器 + 自动化增强（2026-11-23 提出）【待审计·冻结至 M3——仅记录提案，不改 §1 正文、不改 F0/F0′ 已定结论；M3 立项时按第九节裁决清单逐项处理】

**提案（用户 2026-11-23 口述，保留原意）**

> 项目定位是通用，但针对自动化额外定制，让 AI 可以直接操作浏览器，用更高效的自动化 API 实现操作，而不是靠截图点 DOM。它可以不用特化分析页面，但该有的都要有，比如跨标签页读数据、整理标签页；不仅仅是 WebContentsView 层，连 Vue 外壳层也一样可以操作。

**一、与现行文档的冲突（提案生效前必须逐条处理）**

| 位置 | 现文 | 提案要求 |
|---|---|---|
| §1 产品边界 | 「Next 是从空白构建的 **Flash 浏览器**」 | 改为通用浏览器 + 自动化增强；**Flash 是差异能力，不是产品定义** |
| F0 定位结论 | 第一形态 = 挂机监督者 + 工作流编译器，非通用网页助手 | **不变**——「通用」指底盘，不指助手 |
| F0′ 工具面 | 四层（DOM / 视觉 / GM 等价 / 自动化原语） | 增**第五层：浏览器与外壳层**（标签、窗口、面板、设置） |
| §6 交付顺序 | M0–M4 以挂机为主线 | 需并入「通用最小集」（第七节） |
| F8 决策层 A0/A1/A2 | 三档策略 | 不变；「通用」会**提升 A0 的权重**（无 LLM 也能完成整理类任务） |

**二、措辞边界：通用浏览器 ≠ 通用助手**

| | 通用浏览器（做） | 通用助手（不做，见 [边界文档](2026-11-23-bfb-next-agent-boundary.md)） |
|---|---|---|
| 内容 | 标签 / 会话 / 历史 / 书签 / 下载 / 设置 / 多窗口 | 问答、深度研究、生成 PPT·Word、站点配方市场 |
| 判据 | 浏览器的**基线能力** | **模型能力**的包装 |
| 竞争面 | Chrome / Edge（靠自动化差异取胜） | ChatGPT / Comet（无胜算） |

对外口径建议一句话：**「一个通用浏览器，AI 是它的第一个原生调用者」**——不是「带 AI 的浏览器」。

**三、三层可操作对象（提案的技术核心）**

| 层 | 现状 | 提案 | 实现要点 |
|---|---|---|---|
| **页面层** | F0′ 四层工具面已覆盖 | 不变 | 语义工具优先，视觉兜底（判据：有 API 路径时不得默认走视觉） |
| **标签层** | 自动化 v3 支持多 target | 跨标签读数据、整理/分组/搬迁/去重 | **不切换选中标签、不打断用户**；返回带 `navigationId` 的原子快照；每次调用过站点上下文检查 |
| **外壳层** | 外壳命令面（protocol 命令 + IPC 校验） | agent 可操作外壳 | **不要让 AI 点外壳 DOM**：外壳是主进程的投影，把 protocol 命令暴露成工具即可 |

外壳层的判断依据：点 DOM 慢、脆（样式一变即废）、绕过 IPC 的语义校验、不可审计；protocol 工具则语义明确、零 token、可撤销、可回放。这也是 Tabbit 结构上做不到的一层（其 agent 在浏览器外，连自己的侧边栏都只能靠 Playwright 去点）。

**四、第五层工具草案（未定，M3 评审）**

| 允许（write） | 需审批（sensitive） | 能力不存在（结构性禁止） |
|---|---|---|
| 标签：创建 / 选中 / 分组 / 排序 / 移动 / 固定 / 静音 | 关闭用户标签、清空分组 | 读取密码明文 |
| 窗口：排布 / 聚焦 / 最小化 | 关闭窗口 | 修改站点权限 |
| 面板：任务 / 下载 / 历史 的开关 | 删除书签 / 历史 / 下载记录 | 安装或授权扩展 |
| 页面内查找、主题切换、缩放 | 修改下载目录、清缓存 | 关闭安全设置、修改 agent 自身权限 |

后四行不是「要审批」，而是**工具面里不存在**（与 F3 密码策略同构：最好的防御是能力不存在）。

**五、两条硬约束（提案自带，不新增机构）**

1. **跨标签读取契约**：不切换选中标签；快照原子且带 `navigationId`；按 target 计预算；只取所需字段（结果最小化）。
2. **外壳操作契约**：白名单语义动作；每个动作可审计、可撤销（关闭标签走既有 undo-close）；第四节「能力不存在」四项不得进入工具面。

**六、对内核补丁优先级的影响（须在 M3 重新评估）**

跨标签的 **DOM/a11y 读取**不需要内核补丁（Hub 观察域即可）；跨标签的**截图与视觉**依赖 F7 挂账的 #52844 / #54311 / #54090。提案生效后，这三条从「挂机专属」升级为「通用能力底座」，其必要性、探针归属与 A/B 级判定需重新评估（仍遵守「不纸面放行」）。

**七、通用最小集（P0）与分期**

| 优先级 | 缺件 | 备注 |
|---|---|---|
| **P0** | 会话恢复（还原上次） | 通用浏览器的及格线 |
| **P0** | 历史 + 书签（基础） | 落 M2 的 SQLite |
| **P0** | 下载（有策略落盘） | 现为默认拒绝 |
| **P0** | 标签组 + 标签搜索 | 提案点名的「整理标签页」 |
| **P0** | 设置页 | M2 已规划 |
| P1 | 多窗口 / 拖出 | tearoff 已有 |
| P2+ 或非目标 | 密码库 / 扩展 / 同步 / i18n | 需单独裁决 |

**与提案 §6 的关系（2026-11-23 对齐，处置 C5）**：上表 P0 中的**会话恢复、历史/书签、下载**已在[提案 §6](2026-11-22-bfb-next-architecture.md) 的 M2 范围内，不是新增项；本节真正新增的是**标签组 + 标签搜索**与设置页的细化。合并维护时以提案 §6 为准，本节只保留差异项。

**M3 之前不做任何实现**；本节只界定「通用」的下限，防止 scope 无边界扩张。

**七·补 WebMCP 处置结论（2026-11-23）【结论：不抢跑、不实现兼容层、只留接口位】**

- **判断**：WebMCP 现为 W3C Web Machine Learning CG 草案（明示不在 Standards Track），Chrome 需 146.0.7672.0+ 且挂 `#enable-webmcp-testing`，Edge 仅 Canary/Dev；无公开证据表明 Copilot / Gemini 已消费站点工具；且 Flash 与游戏站点不会声明工具，与本项目第一形态（挂机监督者 + 工作流编译器）无关。故**不做 preload shim、不打内核补丁、不为它升内核**——144+ 的 legacy IPC 复活成本见 [往上推进版本可行性](../specs/2026-11-15-forward-version-feasibility.md) §1.7。
- **只做两件零成本动作**：① M3 定配方格式时字段直接对齐 WebMCP（`name / description / inputSchema / annotations{readOnlyHint, consequentialHint, untrustedContentHint}`），使配方与站点工具可双向映射——**做格式，不做适配器**；② 记录下列触发条件，供将来重新评估。
- **触发条件（全部可观测）**：Chrome / Edge 的 origin trial 转为正式（去 flag）｜真实用户会用的站点开始声明工具｜F9 定位提案进入 M3 并立项。
- **将来若做，分三档且每档可独立停**：L0 只读发现（约 1 天，仅收集站点声明的工具清单、不执行）→ L1 可调用（+2 天，仅 read 级往返）→ L2 注解与审批（+2 天，`consequential` 强制审批、结果打不可信信封后进上下文）。
- **不变项**：本条不修改 §1、F0′ 四层工具面与 F7 补丁集；内核侧仍以「页面可感知的 API 表面」为挑补丁的唯一标准，且每条补丁必须配用户态 fallback。

**八、三条可验收判据（草案）**

1. **API 优先**：任一「整理标签页」类任务，A0 档（零 LLM）可完成，p95 单步 < 100 ms；视觉路径只在 API 路径不存在时启用。
2. **不打断**：跨标签读取返回带 `navigationId` 的快照，且不切换选中标签。
3. **可撤销**：外壳动作全部经 protocol 白名单，可审计、可撤销；第四节「能力不存在」四项在工具面中查无此物。

**九、M3 裁决清单**

- [ ] 是否改写 §1 定位表述（含「Flash 是差异能力不是产品定义」的措辞）。
- [ ] 是否新增第五层工具面；清单与黑名单是否照第四节。
- [ ] 通用最小集是否进 M3 范围、如何切分与排序。
- [ ] 跨标签视觉是否提升 F7 补丁优先级，探针如何归属。
- [ ] F0「非通用网页助手」是否仍作为对外口径（建议：是）。
- [ ] 外壳工具的审批分级、撤销语义、审计留存期。
- [ ] 与 F8 A0/A1/A2 的关系是否需调整（预计不需要，A0 权重上升）。

**诚实边界**：本条为提案记录，**未修改任何现行条款、未做任何实现**；第四节工具清单、第八节判据均为草案【推断】，M3 立项时重新评审。编号说明：本条占用 F9；[边界文档](2026-11-23-bfb-next-agent-boundary.md) 第六节提到的「F9 反需求清单」顺延为 F10。

---

*本文为讨论稿。讨论方式：逐项讨论、逐项回填；每项结论回填时标注【已定】/【待定】。*
