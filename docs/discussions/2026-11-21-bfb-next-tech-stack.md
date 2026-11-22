# BaoFlashBrowser Next 技术栈选型（讨论稿·第一轮）

- 状态：**第三轮完成，§7.5 能力清单已定，§7.6 垫片优先级已定；下一主议题 = Next 架构设计（完全重造）**
- 日期：2026-11-21
- 性质：BaoFlashBrowser 进入长期维护；Next 全部重新设计，原项目仅供参考，不做机械搬运与直接代码移植
- 来源标注：文中【事实】= 有代码/实测依据；【推断】= AI 观点，待用户裁决；【待核】= 未核实项

---

## 0. 先框正决策的性质

【事实】BaoFlashBrowser 真正的核心资产是 **Chromium 层的 Flash 移植补丁集**（ppapi 接口恢复、
legacy IPC 恢复、`pepper_routing_id_` 修复、`<param>` 收集恢复、`ppapi_preferences_builder`
真值化、`bind_generates_resource` 能力协商等）。2026-11-21 的实测数据：

- 142 分支 52→265 的上游安全修复（1211 文件）与移植改动（1864 文件）交集 = **2 个 submodule 指针**；
- 这些移植改动全部落在 `ppapi/`、`content/`、`third_party/blink`、`gpu/` —— **没有一行依赖 Electron API**。

【推断】所以三个候选（Electron / CEF / Chromium）在"Flash 能不能跑"这件事上**没有差别**——
同样的补丁集可以叠到任何宿主上。选型的实质不是"哪个能支持 Flash"，而是
**外壳的成本结构**：一次性开发成本 vs 每个版本的长期维护成本。

另一个必须先说的事实：**更换技术栈不解决跨平台成本**。【事实】当前 Flash 二进制是 Windows
PE（pepflashplayer64.dll）；Linux 即便走 GNU 版 PPAPI Flash，补丁集中的平台相关部分
（CFG 适配、DComp 窗口链路均不存在）也要重新验证。"Linux 还得编另一个内核"在三个选项下
都成立，差别只在 Electron 的跨平台承诺对你是空头支票，而 CEF/Chromium 从一开始就没承诺。

---

## 1. 三个选项

### 选项 A：Electron 39/40+

| 维度 | 评估 |
|---|---|
| 一次性成本 | 最低。【事实】142 + Electron 39 的组合已端到端打通，补丁叠加流程、patch 冲突面（8 文件）、构建产物分发全部有现成经验 |
| 每版本维护 | 中。【事实】Electron patches 约 150 个，每 8 周重放一次 + 你的移植补丁 8 文件级冲突面；升级 Electron tag 即可拿到 backport（39.2.6 resize 补丁即实例） |
| UI 技术栈 | React/TS 全保留，IPC（ipcMain/ipcRenderer）现成 |
| 外壳形态适配 | **差**。【事实】BrowserView → WebContentsView 的迁移是 Electron 内部的形态摇摆；窗口置顶约束、`-webkit-app-region` 命中测试、沙箱默认值变化等，全部是 Electron 层的坑（本项目已逐一踩过） |
| 长期包袱 | Node 主进程。【事实】现 main 进程的历史包袱（双内核方案的残留、87 特有垫片、CDP 租约共享 hack）在 Next 中都要重写一遍 |
| 生态 | 最大：打包、签名、自动更新、崩溃上报、社区 |

【推断】Electron 的根本矛盾：它同时服务"桌面 App 开发者"和"浏览器外壳"两种形态，而
BaoFlashBrowser Next 是一个**浏览器**。浏览器外壳在 Electron 里是二等公民——这是过去
一年所有窗口问题的总根源。

### 选项 B：CEF

| 维度 | 评估 |
|---|---|
| 一次性成本 | 中高。【事实】CEF 提供 C++ API + 自带 remote debugging，但**不提供任何 UI**——标签条、侧边栏、密码面板全部要宿主自己画 |
| UI 路线困境 | 【推断】CEF 下做 HTML UI = 自己重新发明 Electron 的一半（JS binding、跨进程消息）；做原生 WinUI = 放弃全部前端技能。两头都贵 |
| 外壳形态适配 | 一般。【事实】CEF 的抽象是"把浏览器嵌进别的 App"（每个 CefBrowser 一个宿主窗口），对"做一个多标签浏览器"并不贴合——标签管理、会话模型仍要自己造 |
| 每版本维护 | 中。【事实】CEF 同样是 patch 层机制（`cef/patch/patches/`，数量与 Electron 同量级，未精确核实）；CEF 版本严格跟 Chromium |
| 进程模型 | 【事实】就是 Chromium 原生进程模型（browser/renderer/gpu/utility/ppapi 分离），比 Electron 透明，ppapi 进程是一等公民 |
| 生态 | 小于 Electron；遇到坑自己扛（但你们已具备内核层排障能力，此劣势减弱） |

【推断】CEF 的尴尬：它的最佳场景是"给 Qt/wxWidgets 程序加个内嵌浏览器"，而不是"做一个
浏览器"。Next 是浏览器，选 CEF 拿不到 Chromium 原生浏览器 UI 框架的红利，还得自己糊一层。

### 选项 C：裸 Chromium fork

| 维度 | 评估 |
|---|---|
| 一次性成本 | 最高。UI 是全新阵地（见下） |
| 每版本维护 | **最低**。【事实】零外壳 patch 重放——移植提交直接站在 chromium 上游上，`git rebase` 到新 tag 即完成升级（52→265 实测冲突面 = 2 个 submodule）。没有 Electron/CEF 的中间层，就没有中间层的税 |
| UI 路线 | 两条：【事实】① chrome/browser/ui 的 Views 框架（C++ 原生，Chrome 同款）；② **WebUI 路线**——外壳页面用 HTML/TS 写在特权页（chrome://bfb），经 Mojo 与 browser 进程通信，Chrome 自己的设置页/新标签页就是这套 |
| 进程模型 | 最正。【事实】多标签 = TabStripModel，窗口 = Browser 窗口，ppapi 进程、下载、会话、os_crypt 全部是内建子系统 |
| 安全 | browser 进程 C++ + Mojo 权限模型，无 Node 攻击面；密码模块可直接用 os_crypt（等于现 v2 的 A 档换官方实现） |
| 附加红利 | 【事实】DevToolbox 整个模块（chii 87 前端 + CDP 垫片 + 87 号节点自愈）在 142 上可直接退役——Chromium 自带现代 devtools；自动化模块可做成 browser 进程内建 feature，不再依赖外部 CDP 租约 |

【推断】裸 Chromium 常被低估的一点：**Chromium 源码里躺着一整个成品浏览器的 UI 实现**
（chrome/browser/ui/）。fork 后做的是"减法"（去品牌、去 updater、去 enterprise policy、
去 crash 上报接入）而不是"从零写外壳"。这条路是所有 Flash 浏览器的正统路径。

---

## 2. 被漏掉的第四个选项

【推断】上面三选一的问题在于把"内核"和"外壳 UI"绑死了。真正的组合空间是：

| 组合 | 内核 | 外壳 UI | 语言栈 |
|---|---|---|---|
| D1 | 裸 Chromium fork | Views（C++ 原生） | 纯 C++ |
| **D2** | 裸 Chromium fork | **WebUI（HTML/TS）+ Mojo** | C++ 骨架 + TS 面皮 |
| A | Electron | React + IPC | TS |
| B | CEF | 自建 glue | C++ |

**D2 值得认真对待**：它把"React/TS 技能不浪费"与"零 patch 重放、原生进程模型"两个目标
同时保住。代价是 WebUI 的开发体验不如 Electron IPC 顺滑（mojo IDL、特权页构建体系要学），
且 chrome/browser 的构建编排是学习成本。【事实】本项目已有 mojo 使用先例（140 树恢复的
`gpu_channel.mojom`、142 的 `ipc.mojom` 恢复），Mojo 不是空白区。

---

## 3. 决策维度矩阵

| 维度 | A: Electron | B: CEF | C: 裸 Chromium | D2: fork+WebUI |
|---|---|---|---|---|
| 一次性成本 | ★☆☆☆☆ 低 | ★★★☆☆ 中 | ★★★★☆ 高 | ★★★★☆ 高 |
| 每版本维护成本 | ★★★☆☆ 中 | ★★★☆☆ 中 | ★☆☆☆☆ 最低 | ★☆☆☆☆ 最低 |
| 外壳形态贴合（浏览器） | ★★★★☆ 差 | ★★☆☆☆ 一般 | ★☆☆☆☆ 最好 | ★☆☆☆☆ 最好 |
| UI 技术栈延续 | ★☆☆☆☆ 最好 | ★★★★☆ 差 | D2=好 / D1=差 | ★★☆☆☆ 好 |
| 安全模型 | ★★★☆☆ | ★★☆☆☆ | ★☆☆☆☆ | ★☆☆☆☆ |
| 排障自主权 | ★★★☆☆ | ★★☆☆☆ | ★☆☆☆☆ | ★☆☆☆☆ |
| 单人可维护性（现实约束） | ★★☆☆☆ | ★★★★☆ | ★★★☆☆ | ★★★☆☆ |

（★ 少 = 好/低/优）

## 4. 影响选型的先决问题（请用户拍板，比选型本身更优先）

1. **Next 是否仍以 Flash 为唯一使命？** 若 Flash 是 Next 的长期核心，内核是否永远驻留 142？
   【事实】144+ 连 legacy IPC 都删了，Flash 移植成本随版本递增。若 Next 永驻 142，则
   "每版本维护"维度的权重下降，Electron 的 patch 重放频率归零，A 的论据显著变强。
2. **Next 是否还需要 Linux？** 若只要 Windows，三个选项的跨平台差异全部消失。
3. **Next 的 UI 是否保持 HTML/TS 技术栈？** 这直接决定 CEF（两头贵）和 D1（纯 C++）的去留。
4. **"做到最好"的定义边界**：外壳贴近 Chrome 的原生质感（→ C/D），还是保持 web 技术的
   迭代速度（→ A/D2）？

## 5. AI 初步倾向（待裁决）

【推断】如果先决问题 1 的答案是"Next 永驻 142"：A（Electron）是理性选择，无必要为升级
红利付 UI 重写税。如果答案是"Next 要继续追内核/或做十年期产品"：**D2（fork + WebUI）**
是最优解——它消灭了 Electron 这个中间层的一切税，且是这个项目唯一没有天花板的路。
CEF 在本项目的场景里我认为可以出局。

---

## 6. 第二轮：先决问题答复与双分支格局（2026-11-21）

### 6.1 用户答复（原文要点）

1. **内核策略**：Next 长期驻扎 142；若未来出现类似窗口拉伸异常这类必须升级内核的 BUG，
   会考虑跨版本升级（87→142 规模）。
2. **新增平行分支 BaoFlashBrowser Modern**：不再支持 Flash，专注 Ruffle；保持 Next 的
   核心功能、摘除 Flash、追赶最新内核——"这样可以不用重建补丁"。
3. **Linux**：有考虑。至今仍想把 Linux 作为日用，但上学/上班被迫用 Windows。
4. **UI 层**：都可以，无所谓——唯一底线是文档质量（点名 QT6 文档写不清楚的反例）。
5. **"做到最好"的定义**：未考虑过，暂不构成决策输入。

### 6.2 答复对选型权重的影响

| 答复 | 影响 |
|---|---|
| 驻扎 142 | 【推断】D2 的唯一决定性优势（零 patch 重放）在驻扎策略下作废——Electron 官方 patches 由上游维护，自研 8 文件补丁面不再随版本移动。§5 的条件分支正式落到 A 侧 |
| 跨版本升级仅作兜底 | 【事实】实践已确立"backport patch 优先"（viz 四补丁解决 resize 黑边，未跨版本）；跨版本触发频率进一步降低 |
| Modern 无 Flash | 【事实】PPAPI 系列补丁全部摘除；Modern 追新内核 = 跟 Electron 官方 tag。单人不可能每 4 周重建裸 Chromium fork，Modern 几乎必然是 Electron |
| 双分支共享核心功能 | 【推断】**决定性新论据**：Modern 是 Electron，Next 若选 D2（C++ + WebUI）则核心功能要写两遍。同栈（都 Electron）是唯一理性解 → Next = Electron 142 |
| Linux | 【事实】Next 的 Linux 障碍是补丁集平台相关部分（Flash PE、CFG/DComp），不是 Electron；Modern 摘 Flash 后 Electron 官方 Linux 支持直接可用 → **Linux 日用愿望由 Modern 兑现，Next 保持 Windows** |
| UI 无所谓 | CEF 的最后一点存疑理由（原生质感）也失去权重 |

### 6.3 第二轮结论（待用户确认）

| 分支 | 选型 | 核心理由 |
|---|---|---|
| **Next（驻扎 142）** | **A：Electron 142** | 驻扎使 D2 优势作废；与 Modern 同栈共享核心功能 |
| **Modern（追新）** | **原生 Electron（官方 tag）** | 无 Flash = 零自研补丁；跟 tag 即追 Chromium 新内核；Linux 可用 |
| CEF | 正式出局 | 两个分支都没有它的最佳场景 |
| D2（fork + WebUI） | 出局 | 优势依赖"持续追内核"的成本模型，与驻扎策略矛盾；且双栈共享不可行 |

### 6.4 Modern 补丁账目精确化

- 【事实】PPAPI 系列（ppapi 恢复、`pepper_routing_id_`、prefs 真值化、bind_generates_resource）
  在 Modern 全部摘除。
- 【事实】viz 四补丁（kDirectCompositionResizeFixes 等）：Chromium 上游自行修复，Modern 跟版本自动获得。
- 【待核】gin 双 tag 约定（用户提交 22985bf842）：Electron 上游是否已含同类修复，升级时核一次——
  这可能是 Modern 仅剩的自研补丁。
- 【事实】`kHiddenButPainting`/最小化强制渲染：内核机制不变，Electron 23 删除 JS API 需 feature-detect 适配（此前已核实）。

### 6.5 双分支架构的连带红利（Modern 侧）

- 密码模块可直接用现代 Electron 的 `safeStorage`，自制 A/C′ 档 + wrap key 轮换整套复杂度退役。
- DevToolbox 大幅简化（142+ 自带现代 devtools，chii 87 前端 + 垫片体系退役）。
- Ruffle 是 WASM：新内核的 wasm/图形特性对 Ruffle 有真实性能红利，"Modern = Flash 体验最好的路径（兼容性除外）"。

### 6.6 新决策点（下一步议论）

1. **共享层切分**：Next 与 Modern 共享哪些模块（下载记录、历史/收藏、密码、自动化、UI 组件）？
   Monorepo + 分支裁剪，还是双仓？【推断】同栈 Electron 后此项变得可行且必要。
2. **自动化模块是否进 Modern**：依赖 capturePage/CDP 机制，现代 Electron 下需 feature-detect 适配，是否保留？
3. **Modern 是否承担 Linux 日用目标**：若是，打包/签名/自动更新等 Linux 工程项要列入 Modern 范围。
4. **Next 的技术栈定稿**：确认 A（Electron 142）后，下一议论点转入 Next 的架构设计（外壳形态、
   WebContentsView 迁移、模块划分）。

---

## 7. 第三轮：定位修正与 Chrome 扩展议论点（2026-11-21）

### 7.1 用户答复（第二轮结论的修正与补充）

1. **Modern 定位修正**：Linux 愿望被架构拆解的说法**不成立**——若真换 Linux，会重建 Flash
   （GNU 版 PPAPI）。**Modern 是保险单**：以防某天 Flash 被彻底粉碎（AS3 游戏只有 Flash 能跑），
   手里还有一个不依赖任何补丁、持续追赶最新内核的浏览器。Next 仍是唯一主角。
2. **共享原则**：能共享的都共享，该升级的都升级，允许 Modern 与 Next 模块不对等（Modern 持续
   追新，理应有更好更新的替代）；但 Modern 只是设想，**首要目标是 Next**。
3. **自动化进 Modern**：要进——"没了 Flash，这个浏览器唯一能留住我的就是自动化"。
4. **Linux 工程项**：暂不考虑。
5. **Next 架构设计**：等待讨论。**注意：不是迁移，是完全重造，原项目仅供参考。**

### 7.2 新议论点：Chrome 扩展支持

用户观点：有扩展可以舍弃很多自建改造（例：Ruffle 扩展），而 Electron 不支持扩展——
这是对 Electron 路线的实质性质疑，也是唯一可能把 D2（裸 Chromium fork）重新拉回桌面的论据。
以下为核实结果（2026-11-21 检索）。

#### 7.2.1 Electron 扩展支持现状【事实，有出处】

- **Electron 内建支持已超出"只能装 devtools"**：官方文档
  （electronjs.org/docs/latest/api/extensions，对应 Chromium 152 / Electron 44）声明支持
  `tabs`（部分）、`scripting`（全）、`storage.local`（全）/`sync`/`managed`（部分）、
  `runtime`、`webNavigation`、`cookies`、`webRequest`（官方声明全支持，含拦截）、
  `declarativeNetRequest`。
- **Electron 35（2025-03）补了 MV3 关键缺口**：service worker preload script
  （`ses.registerPreloadScript({type:'service-worker'})`）+ `ServiceWorkerMain.ipc`，
  专为 MV3 扩展的 service worker 路由补口（RFC #8, samuelmaddock）。
- **社区库 electron-chrome-extensions**：补齐 browserAction/contextMenus/notifications/
  popup UI 等外壳侧 API（DeepWiki 文档：tabs/browserAction/cookies/runtime/notifications/
  webNavigation/windows/storage 标记"complete"）。
- **真实项目实测（another-arc PHASE0 报告，2026-10，Electron 44.9.3 / Chromium 152）**：
  - 依赖 tabs/scripting/storage/action/webNavigation/contextMenus/cookies/offscreen/
    **declarativeNetRequest** 的 MV3 扩展"基本可用"，**DNR 拦截实测生效**（uBlock Origin Lite 可用）；
  - **核心功能不可用的扩展类**：webRequest 事件类（uBlock MV2、视频嗅探）、
    userScripts 类（Tampermonkey）、identity、tabCapture/desktopCapture、tts、captureVisibleTab；
  - 该项目结论："替换底层引擎（CEF、自编 Chromium）的成本远高于收益"，策略是
    对高价值 API 逐个补垫片（已示范 onInstalled、storage.onChanged、sidePanel）。

【待核】官方文档称 `chrome.webRequest` "全支持"与 another-arc 实测"webRequest 事件类扩展
核心功能不可用"**存在矛盾**——可能在 blocking 语义或 MV2 差异上，需在 Next 上实测裁决。

#### 7.2.2 MV2/MV3 时间线与两个分支的关系

| 分支 | MV2（webRequest 拦截） | MV3（DNR） |
|---|---|---|
| Next（Electron 39 / Chromium 142） | Chromium 142 源码中 MV2 代码仍在但默认关闭，fork 可尝试打开（【待核】开关状态）→ 若可开，uBlock Origin 完整版可跑 | 可用（Electron 39 ≥ 35，SW preload 已在） |
| Modern（追新） | MV2 代码将被上游持续移除，不可依赖 | 唯正解（uBOL 等 DNR 系） |

#### 7.2.3 "比如 Ruffle"这个例子不需要扩展机制

【事实】Ruffle 浏览器扩展的本质是一个 content-script 注入器（向页面注入 ruffle.js + 配置）。
Electron 应用可以**原生自己做注入**（preload / `executeScript`），不经过扩展机制——且体验更好：
启用范围、版本、配置完全由应用控制。Modern 集成 Ruffle 的正确姿势是内建注入，不是装扩展。

#### 7.2.4 结论

【推断】Chrome 扩展支持**不构成推翻 Electron 142 的理由**，理由：

1. Electron 内建 + 社区库已覆盖 MV3 日常扩展的主要面（含 DNR 广告拦截），有真实项目背书；
2. 用户举的例子（Ruffle）恰恰不需要扩展机制；
3. 真正的缺口（Tampermonkey 类 userScripts、identity、captureVisibleTab）属于长尾，
   可逐个垫片，且另一项目已示范此路线可行；
4. 为扩展支持换 D2，等于为"长尾扩展兼容性"支付整套 C++ 外壳成本——本末倒置。

**扩展路线（Next）**：Electron 内建扩展加载 + electron-chrome-extensions（外壳 UI 桥）
+ 高价值缺口垫片。**前置动作**：列一份"我真正想要的扩展能力清单"（adblock/翻译/视频嗅探/
油猴/其他），按清单决定垫片优先级；清单若出现"必须能装任意第三方扩展且 MV2 拦截不可妥协"，
则重新评估 D2——这是 D2 回桌面的唯一条件。

### 7.3 决策点状态更新（覆盖 §6.6）

1. ~~共享层切分~~ → 原则已定（7.1.2），具体模块清单待 Next 架构设计时落。
2. ~~自动化是否进 Modern~~ → 已定：进（7.1.3）。
3. ~~Modern 是否承担 Linux 日用~~ → 已定：暂不考虑（7.1.4）。
4. **Next 架构设计 → 下一主议题**，性质为**完全重造**（7.1.5）。
5. **新增：扩展能力清单**（§7.2.4 前置动作）→ 请用户列出想要的扩展能力，逐项定垫片优先级。

### 7.5 扩展能力清单分析（2026-11-21，用户提供清单）

用户清单：①油猴（首要）②翻译扩展 ③广告过滤/拦截 ④IDM 下载插件类；此外多年无其他扩展需求。

| 优先级 | 目标 | 对应扩展 | Electron 142 可行性 | 建议路线 |
|---|---|---|---|---|
| 1 | 油猴 | Tampermonkey / Violentmonkey | ⚠️ 卡在 `chrome.userScripts` API 缺口（another-arc 实测"userScripts 类核心功能不可用"） | **userScripts API 垫片**（首选）+ Violentmonkey；备选内建 userscript 管理 |
| 2 | 翻译 | 沉浸式翻译等 MV3 | ✅ content script + storage + fetch，属"基本可用面"【待实测】 | 直接装 |
| 3 | 广告拦截 | uBlock Origin Lite (MV3/DNR) | ✅ DNR 拦截有实测背书 | 直接装；或内建自建（webRequest + adblock 引擎，性能更优，无规则数上限） |
| 4 | IDM 下载 | IDM Integration Module | ⚠️ 双重障碍：MV2 默认关（142 fork 开关【待核】）+ 依赖 Chrome Native Messaging | native messaging 垫片（完整）或自建下载接管（简单） |

**油猴的关键洞察**：GM_* API 全部由扩展自身实现，缺的只是 `chrome.userScripts` 注入通道。
垫片只需桥接该 API 语义（register/unregister、@match 匹配、MAIN world 注入，Electron 底层
`webContents.executeJavaScript`/preload 均有对应能力）→ **垫片工程量 << 自建 userscript
管理器**，且保住用户"不费力实现 userscript"的目标。一次性工程，驻扎 142 不漂移。
配套建议：优先 Violentmonkey（开源可排查），Tampermonkey 核心混淆、Electron 下排障痛苦。

**IDM 两条路**：
- 垫片路线（完整）：主进程读 NativeMessagingHosts 注册表项 + spawn IDM host 进程 + 桥接
  （native messaging 协议 = 长度前缀 JSON，垫片可行）。可与 MV2 开关叠加，两层不确定性。
- 备选（简单）：不做扩展，URL 拦截 → `idman.exe /d <url> /p <path>`；缺点：无 cookie/referer，
  网盘类下载会失败。

**清单总体判定**：不推翻 Electron 142；把"高价值垫片"具体化为两个一次性工程：
`userScripts` API 垫片（优先级 1）、native messaging 垫片（优先级 4，可延后）。
MV2 开关不再阻塞主线（uBOL 够广告拦截用），仅 IDM 路线需要。

### 7.6 决策点状态更新（覆盖 §7.3）

1. **扩展能力清单 → 已提供（7.5）**，垫片优先级：userScripts > native messaging。
2. **Next 架构设计 → 下一主议题**（完全重造，原项目仅供参考）。
3. 【待实测】翻译扩展、uBOL 在 Electron 39/142 下的实装验证 → 并入 Next 架构设计后的 POC 阶段。

---

*本文为讨论稿，不构成决策。所有【推断】均待用户确认或驳回。*
