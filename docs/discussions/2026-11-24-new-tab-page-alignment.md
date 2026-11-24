# 新标签页对齐 Chromium：现状、依据与实施方案

2026-11-24 · 状态【已交付 P0/P1/P1.5】：本稿是调研、差距梳理与实施设计；交付记录见[新标签页对齐报告](../reports/2026-11-24-newtab-alignment.md)。§7 D1 的差异已用「标签标记 + 重建 NTP 视图」补上（页面状态不保留）。

**触发**：用户反馈「新标签页仍是占位符，不具备新标签页真正的职责，且行为也奇怪——打开设置页竟然是新开标签页，而不是把当前的新标签页跳转到设置页」。

**依据**：Chromium 142 源码（本机检出 `D:\electron-build-142\cr\src`，标签 `bao-v142-265-ppapi-sandbox-1-gaf379570b1d17`，即当前内核同源）+ 本仓库代码。下文 Chromium 证据一律写 `chrome/...` 相对路径，本仓库证据写 `app/...`。

---

## 0. 结论摘要

1. **【事实】根因是 NTP 没有身份。** 我们现在的新标签页是 `data:` URL 字符串常量（`app/src/main/start-page.ts:5`），不是真实文档、没有可比较的 URL。Chromium 的「打开设置覆盖 NTP」判定（`singleton_tabs.cc:76-94`）恰恰依赖 `WebContents::GetVisibleURL() == chrome://newtab/`；我们是 `data:…`，判定永远不成立，所以 `openSettingsTab()` 只能走「新建标签」（`app/src/main/browser-window.ts:661-671`）。
2. **【事实】Chromium 的规则是三层优先级**：窗口内已有设置标签 → 切过去；否则当前标签是 NTP（或 `about:blank`）→ **就地导航**，标签数不变；否则新开标签。就地导航会**追加**一条历史项（`should_replace_current_entry` 默认 `false`），所以 Back 能回到 NTP（`instant_extended_interactive_uitest.cc:120-144` 就是断言这件事）。
3. **对齐方案**：新增 `bao://newtab/` 内部页（与 `bao://settings` 同一内部会话），给标签加内部页身份；`openSettingsTab()` 按上面三层优先级实现；NTP 页面本体做 realbox（地址/搜索框）+ 设置入口 + Flash 状态，快捷方式等数据板块**没有真实数据源就不画**（历史/书签还在 M2 未完成清单里）。
4. **【已处置】一条真实取舍**：因为「内部会话永不承载 http(s)」是已经赚到的安全不变量（`internal-pages.ts:6-19`），从 NTP 输入 http(s) 必须**换掉 WebContents**，「从网页 Back 回 NTP」的那条历史项留不下来。方案 A（安全优先）已实施，并用标签标记 `fromNewTab` + `returnToNewTab` 补出等效的 Back/Forward（页面状态不保留）。见 §7 D1。
5. **改动面可控**：`internal-pages.ts` + `browser-window.ts` 两个主进程文件、1 个新 preload、1 个新页面、2 个构建入口，外加 1 条**现有用例必须改**（`app/tests/smoke/internal-page.test.cjs:37-61` 现在断言「Ctrl+, 后标签数 = 2」，改动后应为 1）。

---

## 1. 现状盘点（我们的代码）

| 环节 | 现在的做法 | 证据 |
| --- | --- | --- |
| NTP 载体 | `data:text/html,…` 字符串常量，内联样式 + 两行文案 | `app/src/main/start-page.ts:5-23` |
| 标签创建 | `addTab(initialTitle, url = START_PAGE)`，用页面会话建 `WebContentsView` | `app/src/main/browser-window.ts:618-632` |
| 地址栏 | `describe()` 把 `START_PAGE` 映射成空串（所以地址栏空白，这点与 Chrome 一致） | `app/src/main/browser-window.ts:336` |
| 打开设置 | `openSettingsTab()`：有设置标签就切过去，**否则一定新建** | `app/src/main/browser-window.ts:661-671` |
| 内部页 | 只有 `bao://settings` 一个 host；其它 `bao://` 地址直接 404 / 非法 | `app/src/main/internal-pages.ts:21-24, 108-132, 149-185` |
| 内部页会话 | `persist:bao-next-internal`，只在该会话绑定 `bao` 协议 | `app/src/main/sessions.ts:16-20`、`app/src/main/browser-window.ts:226` |
| 引擎/规则 | `hostOf()` 只认 http(s)，`bao://` 一律无站点 → 默认引擎 | `app/src/shared/engine.ts:44-52`、`app/src/main/browser-window.ts:289-293` |
| 休眠 | 扫描排除 `tab.internal`（这条对 NTP 继续成立） | `app/src/main/browser-window.ts:730-747` |
| 撤销关闭 | 记录导航栈；设置页可恢复（`closed.internal`） | `app/src/main/browser-window.ts:972-1027` |
| 外壳 UI | `internal` 标签隐藏引擎胶囊、显示齿轮图标 | `app/src/renderer/App.vue:412, 472` |
| 测试现状 | 初始标签断言为「标题=新标签页、地址=空」；`Ctrl+,` 断言标签数 1→2 | `app/tests/smoke/isolation.test.cjs:82-84`、`app/tests/smoke/internal-page.test.cjs:41-61` |

**一句话**：NTP 现在只是「页面会话里的一张 data: 文档」，主进程没有任何「这是新标签页」的判断手段，所以既不能承载页面职责，也无法参与 Chrome 那套「单例页覆盖 NTP」的复用规则。

---

## 2. Chromium 是怎么做的（142 源码证据）

### 2.1 `chrome://newtab` 是虚拟 URL

- `chrome://newtab/` 是**对外可见的 URL**，真实文档是 `chrome://new-tab-page/`（Google 默认）或搜索提供商的 `new_tab_url`。`BrowserURLHandler` 双向重写，且**只看 host、不看 path/query**，所以 `chrome://newtab/anything?x` 会被整体替换。证据：`chrome/common/webui_url_constants.h:191,198-199`、`chrome/browser/search/search.cc:368-379`。
- 虚拟 URL 让标签的 `GetVisibleURL()` 永远是 `chrome://newtab/`——后面的复用判定、地址栏隐藏 URL、Back 回 NTP 全部依赖它。
- 我们**不需要**第二层 host：没有远端 NTP，`bao://newtab/` 直接作为可见 URL 与真实文档即可（少一层重写，语义不变）。

### 2.2 NTP 页面本体的职责

- 结构是两层：可信层 `chrome://new-tab-page`（Mojo WebUI）+ 不可信层 `chrome-untrusted://new-tab-page` 的 iframe（背景图、doodle、第三方登录等外部内容）。可信层渲染进程没有网络访问权。证据：`webui_ntp_browsertest.cc:114-125`、`new_tab_page.mojom:277-278`、`new_tab_page_ui.cc:645-654`。
- 职责清单（`new_tab_page.mojom` + handler 分类）：realbox（复用 omnibox/TemplateURLService）、快捷方式（TopSites + 自定义链接）、主题/背景、Doodle、模块、promo，数据来自 pref / 历史 TopSites / 网络服务。
- 「最小可观察行为」：realbox 与地址栏同语义；快捷方式可增删改排序；背景/主题可自定义且换肤不闪；**打开 NTP 时焦点在地址栏**；NTP 页面自己**不**跳 `chrome://settings`（个性化入口是 Customize 侧边栏）。证据：`browser.cc:2370-2398`（`ShouldFocusLocationBarByDefault` 对 NTP 返回 true）、`new_tab_page_handler.cc` 全局搜索无 `openSettings`。
- 明确不该照搬的：Doodle、模块、promo、OneGoogleBar、NTP 预加载/预渲染流水线（`chrome/browser/preloading/new_tab_page_preload/`）、远端 NTP 与 instant 进程。这些依赖 Google 网络服务或 Chromium 特有基础设施，移植没有收益。

### 2.3 「单例页覆盖 NTP」的判定

`ShowSingletonTabOverwritingNTP`（`chrome/browser/ui/singleton_tabs.cc:76-94`）：

```cpp
content::WebContents* contents = params->browser->tab_strip_model()->GetActiveWebContents();
if (contents) {
  const GURL& contents_url = contents->GetVisibleURL();
  if (contents_url == chrome::kChromeUINewTabURL || search::IsInstantNTP(contents) ||
      contents_url == url::kAboutBlankURL) {
    int tab_index = GetIndexOfExistingTab(params->browser, *params);
    if (tab_index < 0) params->disposition = WindowOpenDisposition::CURRENT_TAB;   // ← 就地
    else params->switch_to_singleton_tab = ...GetWebContentsAt(tab_index);          // ← 切过去
  }
}
Navigate(params);
```

- 设置页入口就是这条路：`ShowSettings()` → `ShowSettingsSubPage()` → `ShowSettingsSubPageInTabbedBrowser()`（先 `FocusWebContents`，再 `ShowSingletonTabIgnorePathOverwriteNTP`）。证据：`chrome/browser/ui/chrome_pages.cc:106-119, 466-498`。
- `IGNORE_AND_NAVIGATE`：查找既有标签时忽略 path/query，命中后**导航到新 URL**（所以设置页在子页时再按一次会回到根页）。`browser_navigator.cc:861-869`、`browser_navigator_params.h:269-275`。
- 使用同一入口的不止设置页：历史、书签、扩展、密码管理器、帮助都用 `ShowSingletonTabIgnorePathOverwriteNTP`（`chrome_pages.cc:334,361,369,401,497,565,616,664,670`）。**「chrome:// 单例页覆盖 NTP」是通用规则，不是设置页特例。**
- Windows/Linux 上 Chromium **没有**把 `Ctrl+,` 绑到设置（`accelerator_table.cc` 无 `IDC_OPTIONS`/`VKEY_OEM_COMMA`，只有 macOS 的 `accelerators_cocoa.mm:63-65`）。我们沿用产品既有选择（`Ctrl+,`），与 NTP 对齐无关。

### 2.4 历史、Back 与撤销关闭

- `chrome://newtab` 是**普通历史项**，不是「不可回退的起点」。内容层只替换「初始占位 entry」（`is_initial_entry`），NTP 提交后就是第 0 条。证据：`navigation_request.cc:10619-10629`、`navigation_controller_impl.cc:2107-2112`；BrowserTest 明确断言 `CanGoBack()` 后 `GoBack()` 回到 NTP：`chrome/browser/ui/search/instant_extended_interactive_uitest.cc:120-144`。
- 就地导航用 `CURRENT_TAB` + `should_replace_current_entry = false`（默认），所以设置页是**追加**的历史项，Back 回 NTP。证据：`browser_navigator_params.h:328`、`browser_navigator_params_utils.cc:31-32`。
- 「孤儿 NTP」只在 `SWITCH_TO_TAB` 回退路径上被关闭：源标签无历史且 URL 是 `chrome://newtab/` 或 `about:blank` 时，切走后 `Close()`。证据：`browser_navigator.cc:878-900`。
- 撤销关闭：`TabRestoreService` 把「只有一条导航且就是 NTP」的标签判为 not interesting，**纯 NTP 标签不进最近关闭**；设置页可以恢复。证据：`components/sessions/core/tab_restore_service_helper.cc:1098-1109`。

### 2.5 新建、关闭、启动

- `Ctrl+T` / 「+」/ 双击标签栏 → `NewTab()` → `AddAndReturnTabAt(browser, GURL(), …)`，空 URL 被替换成 `browser->GetNewTabURL()`（`chrome://newtab/`）。**在 NTP 上再按 Ctrl+T 仍然新增第二个 NTP 标签，不复用、不合并。** 证据：`browser_commands.cc:1034-1054`、`browser_tabstrip.cc:38-44`、`browser.cc:811-817`。
- 关闭最后一个标签 = 关窗口（`TabStripEmpty()` → `window_->Close()`，`browser.cc:1758-1763`）。我们是「自动补一个新 NTP」，属于既有产品差异（见 D4）。
- 启动：不恢复会话时首个标签就是 NTP；`--homepage` 只改主页、不改启动标签。证据：`startup_tab_provider.cc:339-346`、`startup_browser_creator_impl.cc:556-561`。
- NTP 失败兜底：`NewTabPageNavigationThrottle` 在「visible URL 是 NTP 且目标是 instant NTP URL」且响应 4xx/5xx/无内容时，改开本地 NTP 并 `CANCEL_AND_IGNORE`，避免失败页进历史。证据：`new_tab_page_navigation_throttle.cc:31-75`。

### 2.6 焦点与地址栏

- 打开/切到 NTP 时焦点在地址栏：`ShouldFocusLocationBarByDefault` 用 pending entry 优先判定 NTP（注释写明是为了 back/forward 回到 NTP 也能聚焦）。证据：`browser.cc:2363-2399`。
- 地址栏**不显示** NTP 的 URL：`ChromeLocationBarModelDelegate::ShouldDisplayURL` 对 `chrome://newtab` host 返回 false。证据：`chrome/browser/ui/toolbar/chrome_location_bar_model_delegate.cc:119-131`。
- NTP 上失败的 URL 会留在地址栏（`ShouldPreserveAbortedURLs`，`browser.cc:1864-1873`）。

### 2.7 本机实测补充（仅验证历史语义）

用 Playwright 起本机 Chromium 151（`ms-playwright/chromium-1234`，`--headless`，CDP `Page.getNavigationHistory`）：

```
goto('chrome://newtab')  → entries: [about:blank, chrome://newtab/], index=1
goto('data:text/html,…') → entries: [about:blank, chrome://newtab/, data:…], index=2
goBack()                 → url: chrome://newtab/（成功回到 NTP）
```

该构建的 NTP 文档体为空（WebUI 资源不完整），**只作为「NTP 是普通历史项、Back 可回」的旁证**；页面职责结论仍以 §2.2 源码为准。

---

## 3. 差距清单

| # | 行为 | Chromium | 我们 | 影响 | 处置 |
| --- | --- | --- | --- | --- | --- |
| G1 | NTP 身份 | 真实页面 `chrome://newtab/` | `data:` 常量，无 URL 身份 | 无法参与任何「单例/复用」判定 | P0 |
| G2 | NTP→设置 | 当前是 NTP 时就地导航，标签数不变 | 一定新建标签 | 用户直接抱怨的那条 | P0 |
| G3 | NTP→网页 | 同标签原地导航，NTP 留在历史里 | 同标签导航（已一致），但 NTP 是 data: 文档 | Back 能回占位页，不是「NTP」 | P0（换 `bao://` 后需处理会话，见 D1） |
| G4 | 焦点 | NTP 激活时焦点在地址栏 | 只有外壳点「+」时聚焦地址栏；`Ctrl+T` 后焦点在页面 | 打开新标签不能直接打字 | P0 |
| G5 | 页面职责 | realbox、快捷方式、个性化、状态 | 两行文案 | 「不具备真正职责」 | P1 |
| G6 | 撤销关闭 | 纯 NTP 标签不入最近关闭 | NTP 入栈 | `Ctrl+Shift+T` 会「恢复」一个 NTP | P0 |
| G7 | 地址栏 | NTP 隐藏 URL | 已一致（空串） | — | 保持 |
| G8 | 关闭最后一个标签 | 关窗口 | 补一个新 NTP | 产品既有差异 | 保持（D4） |
| G9 | 设置标签去重 | 导航层按 URL 去重（忽略 path） | `tabs.find(internal === 'settings')` | 等价 | 保持 |
| G10 | 页面内跳设置 | NTP 自身不跳设置（用 Customize） | 无入口 | 页面缺「设置」入口 | P1 |
| G11 | 崩溃重建 | 按 URL 恢复 | 内部页崩溃重建会回 `START_PAGE`（`browser-window.ts:965`） | 设置页/新 NTP 崩溃后变成空白占位 | P0 |
| G12 | 复制标签 | NTP 复制出 NTP | `duplicateTab` 用 URL 建**页面视图** → `bao://` 加载失败（设置页同样坏） | 复制内部页标签坏掉 | P0 |

---

## 4. 对齐后的行为合同（P0 验收口径）

| # | 场景 | 期望 |
| --- | --- | --- |
| B1 | 启动（无命令行地址） | 1 个 NTP 标签，`getURL() === 'bao://newtab/'`，标题「新标签页」，地址栏空 |
| B2 | 启动带 http(s) 参数 | 首个标签直接是网页（没有 NTP 标签），行为不变 |
| B3 | `Ctrl+T` / 「+」/ 双击标签栏 | 新增一个 NTP 标签并选中；地址栏空且**获得焦点**（窗口在前台时） |
| B4 | NTP 上 `Ctrl+,`（窗口内无设置标签） | **同一个标签**导航到 `bao://settings/`；标签数不变、位置不变；地址栏显示 `bao://settings/`；后退可用，后退回 NTP |
| B5 | NTP 上 `Ctrl+,`（已有设置标签） | 切到已有设置标签；NTP 保留原样 |
| B6 | 普通页上 `Ctrl+,`（无/有设置标签） | 不变：新建 / 切过去 |
| B7 | 齿轮飞窗「全部设置」 | 与 B4–B6 同规则（按发送时活动标签判定） |
| B8 | NTP 页内「设置」入口 | 与 B4/B5 同规则 |
| B9 | NTP 地址栏输入 http(s) | 同一个标签变成网页（数量/位置不变），引擎按站点规则解析 |
| B10 | NTP 地址栏输入 `bao://settings` | 同 B4 |
| B11 | 设置页地址栏输入 `bao://newtab` | 同标签就地回 NTP |
| B12 | 设置页地址栏输入 http(s) | 不变：新开普通标签，设置页不动（既有 P2 决策） |
| B13 | NTP realbox 回车（URL） | 同 B9 |
| B14 | NTP realbox 回车（非 URL） | 稳定错误提示，页面不跳转（搜索引擎设置落地前） |
| B15 | 关闭 NTP 标签 | 关闭；`undoCount` 不变（不入撤销栈） |
| B16 | 关闭设置标签 | 不变：入撤销栈，`Ctrl+Shift+T` 恢复为设置页 |
| B17 | 关闭最后一个标签 | 不变：补一个新 NTP（D4） |
| B18 | 复制 NTP / 设置标签 | 复制出同类内部页标签（不再用页面视图） |
| B19 | 固定 / 拖出 NTP | 可用；拖出后仍是 NTP；静音菜单对内部页隐藏（沿用现状） |
| B20 | 后台休眠扫描 | NTP 永不被丢弃（`tab.internal` 排除） |
| B21 | NTP 视图崩溃后重新加载 | 重建内部视图并回到 `bao://newtab/` |
| B22 | 普通网页 fetch / load `bao://newtab/` | 失败（协议仍只绑内部会话） |
| B23 | NTP 的 `baoNtp` 桥 | 只有 `read/run/subscribe`；没有 `baoBrowser`/`baoSettings`/`baoSettings.write` |

---

## 5. 实现设计

### 5.1 `bao://newtab/` 与协议

`app/src/main/internal-pages.ts`：

```ts
export const NEWTAB_HOST = 'newtab'
export const NEWTAB_URL = 'bao://newtab/'
export type InternalKind = 'newtab' | 'settings'
export function isNewTabUrl(url: string): boolean        // 与 isSettingsUrl 同构，host 归一
export function isInternalUrl(url: string): boolean      // newtab | settings
export function parseInternalAddress(input: string): { kind: InternalKind; url: string } | undefined
```

- handler 按 host 分派入口文件：`newtab` → `newtab.html`，`settings` → `settings.html`；`resolveFile(url, entry)` 复用现有越界防护。开发态代理同样按 host 映射（现在写死 `/settings.html`，见 `internal-pages.ts:78-89`）。
- **不新增 scheme**：`registerSchemesAsPrivileged` 只能调一次（`app/src/main/index.ts:29-31`），新增 host 不需要再登记。
- **不新增会话**：与设置页共用 `persist:bao-next-internal`（同会话、不同 origin）。好处是 NTP→设置可以就地导航，且「内部会话不承载 http(s)」这条不变量不变。
- CSP 沿用设置页那套（`default-src 'self'`、`frame-src 'none'`、`connect-src 'self'`），NTP 不嵌任何外部内容。

### 5.2 标签身份

```ts
interface Tab {
  // 现在：internal?: 'settings'
  internal?: InternalKind
  ...
}
```

- 创建：`openInternalTab(kind)`（替代现在的 `openInternalTab()`，`browser-window.ts:640-659`），按 kind 选 `BASE_URL`、初始标题与 preload。
- 视图：`createInternalView(kind)` 按 kind 挂不同 preload（设置页 `internal.js`、NTP `ntp.js`，见 5.5），沙箱参数保持一致。
- `guardContents` 的 allow 对内部标签从 `isSettingsUrl` 改为 `isInternalUrl`（否则 NTP 首次加载与 reload 会被自己的导航守卫拦掉）。
- `describe()`：内部页地址 `settings → SETTINGS_URL`、`newtab → ''`；标题回落到 `initialTitle`（`placeholderTitle` 继续负责首帧防闪）。
- `sourceOf()` / 引擎：内部页直接返回 `'default'`，不查站点规则。
- `revive()` / `rebuild()` / `reloadTab()`：内部页用 `tab.lastUrl || BASE_URL[kind]`，**不再回落到 `START_PAGE`**（G11）。
- `duplicateTab()`：内部页走 `openInternalTab(tab.internal)`（G12）。
- 所有「开一个新标签」的入口统一换成 `openInternalTab('newtab')`：启动首个标签（`browser-window.ts:1427-1430`）、`add` 命令、`Ctrl+T`（`:1081-1085`）、关闭最后一个标签后的兜底（`:1008-1011`）。
- `rememberClosed()`：`internal === 'newtab'` 直接返回，不入撤销栈（G6，Chromium 的 `IsTabInteresting`）。

### 5.3 内部页单例的单一入口

把「打开设置」抽成唯一入口，未来历史/书签直接复用：

```ts
function openInternalSingleton(kind: InternalKind): Tab {
  // ① 窗口内已有同类内部页 → 切过去（Chromium 的 GetIndexOfExistingTab）
  const existing = tabs.find((tab) => tab.internal === kind)
  if (existing) {
    select(existing, true)
    return existing
  }
  // ② 当前标签是 NTP → 就地覆盖（Chromium 的 CURRENT_TAB）
  if (kind === 'settings' && active?.internal === 'newtab') {
    controlInternal(active, { kind, url: SETTINGS_URL })
    select(active, true)
    return active
  }
  // ③ 都没有 → 新建前台标签
  const opened = openInternalTab(kind)
  select(opened, true)
  return opened
}

/** NTP ↔ 设置：同一内部会话内的就地导航，历史项追加（与 Chromium 一致）。 */
function controlInternal(tab: Tab, target: { kind: InternalKind; url: string }): void {
  tab.internal = target.kind
  tab.initialTitle = target.kind === 'newtab' ? '新标签页' : '设置'
  load(tab, target.url)
}
```

注意与 Chromium 的细微差别：Chromium 在 NTP 分支里**先**查既有标签，再决定就地覆盖（顺序与上面等价）；Chromium 命中既有设置标签且 URL 不同时会再导航一次（子页重置），我们的设置页目前没有子页路由（`SettingsPage.vue` 无 `history/pushState`），所以「复用不导航」是等价行为——等设置页有子页时再按 `IGNORE_AND_NAVIGATE` 补（D2）。

### 5.4 从 NTP 离开：换视图（D1 的核心）

`navigate` 命令对内部页分两种情况（现在只有「设置页 → 新开网页标签」这一支，`browser-window.ts:1266-1312`）：

```ts
if (target.internal) {
  const internal = parseInternalAddress(address)
  if (internal) { controlInternal(target, internal); break }     // NTP ↔ 设置：就地
  const url = parseAddress(address)
  if (!url) return fail('invalid-address')
  if (target.internal === 'settings') {
    // 既有 P2 决策：内部会话永不承载网页 → 新开普通标签，设置页原地不动
    select(addPageTab('新标签页', url, resolved.engine, resolved.source), true)
  } else {
    leaveNewTab(target, url)                                     // NTP → http(s)：同标签换装
  }
  break
}

function leaveNewTab(tab: Tab, url: string): void {
  const resolved = engineFor(url)
  tab.internal = undefined        // 先清身份，swapView 才会建页面视图
  tab.initialTitle = '新标签页'
  swapView(tab, resolved.engine, resolved.source)   // 复用引擎切换的重建路径
  load(tab, url)
}
```

`swapView` 已经处理「旧视图移除、绑定代际 +1、静音迁移、活动标签重新挂载/聚焦」（`browser-window.ts:781-805`），这里只是借用。

**代价**：新 WebContents 从零开始，NTP 不在它的历史里 → 从网页 Back 不回 NTP（Chromium 能）。这是 D1 的取舍；缓解方案见 §7 D1，不进本期合同。

### 5.5 NTP 页面与窄桥

新增：

- `app/src/renderer/newtab.html` / `newtab.ts` / `NewTabPage.vue`：与设置页同构（`data-theme` 预置 + 首帧底色 + `tokens.css`）。
- `app/src/preload/ntp.ts`：只暴露 `baoNtp`。
- `app/src/shared/ntp.ts`：通道与类型。

```ts
export const ntpChannels = { read: 'ntp:read', command: 'ntp:command', changed: 'ntp:changed' } as const
export interface NtpSnapshot {
  theme: ShellTheme
  settings: Pick<Settings, 'themeMode' | 'defaultEngine' | 'locale'>
  flash: boolean
  flashHint?: string
  storage: 'ready' | 'unavailable'
}
export type NtpCommand = { type: 'open-settings' } | { type: 'navigate'; address: string }
export interface NtpBridge {
  read(): Promise<NtpSnapshot | undefined>
  run(command: NtpCommand): Promise<{ ok: true } | { ok: false; code: BrowserFailureCode }>
  subscribe(listener: (snapshot: NtpSnapshot) => void): () => void
}
```

主进程侧与设置页同等级别的发送者校验：

```ts
function ntpSender(event: IpcMainInvokeEvent): boolean {
  const tab = tabs.find((item) => item.internal === 'newtab' && item.view?.webContents.id === event.sender.id)
  if (!tab) return false
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false
  return isNewTabUrl(event.senderFrame.url)
}
```

`ntp:command` 的 `navigate` 直接调用 §5.4 的同一段逻辑（抽成 `navigateTab(tab, address)`，外壳 `navigate` 命令也走它），保证「页面内输入」和「地址栏输入」语义完全一致。`settings:changed` 广播扩展到 NTP 标签（现有 `broadcastSettings()` 只遍历 `tab.internal`，改成按 kind 发对应快照即可）。

页面内容（P1，原则：**没有真实数据源就不画板块**）：

| 区块 | 内容 | 数据来源 |
| --- | --- | --- |
| wordmark | 产品名，纯装饰 | 静态 |
| realbox | 输入 + 回车 → `baoNtp.run({type:'navigate'})`；Esc 失去焦点 | 主进程 `parseAddress` |
| 设置入口 | 齿轮按钮 → `open-settings` | `openInternalSingleton('settings')` |
| Flash 状态 | 「原生 Flash 已就绪 / 未检测到，去设置导入」 | `NtpSnapshot.flash` |
| 快捷方式 | **本期不画**（历史/书签在 M2 未完成清单） | 待历史存储 |

### 5.6 焦点

- 主进程：`select(tab, focus)` 对 NTP 标签把焦点交给**外壳**而不是页面视图（`window.webContents.focus()`），再由渲染层聚焦地址栏；否则焦点会留在上一标签的页面视图里。
- 渲染层：`App.vue` 的 `watch(active.id)` 里，`active.internal === 'newtab' && document.hasFocus()` → `addressField.focus()`；`Ctrl+T`（主进程快捷键）与「+」（外壳）由此统一（G4）。
- 地址栏占位文案改成「输入网址或搜索」，与页面 realbox 一致（D6）。

### 5.7 其余交互

| 交互 | 处理 |
| --- | --- |
| 右键菜单 | NTP 保留「重新加载 / 复制 / 固定 / 关闭 / 撤销」，隐藏静音（内部页无声）；设置页维持现状 |
| 拖出窗口 | 不变（`adoptTab` 搬 WebContents，内部页一样成立） |
| 引擎切换 | 不变：`set-engine` 对内部页返回 `invalid-command`；工具栏胶囊隐藏 |
| 全屏 / DevTools / F11 | 不变（NTP 视图是普通 WebContents） |
| `Ctrl+W` / `Ctrl+Shift+T` | 不变；NTP 关闭不入栈（5.2） |

### 5.8 安全边界（不放松）

1. `bao` 协议仍只绑内部会话；普通网页 `loadURL/fetch('bao://newtab/…')` 仍失败（B22）。
2. NTP 与设置同会话意味着两个内部 origin 之间没有会话级隔离：按设置页报告实测（绑定了 handler 的会话里网页 `fetch('bao://settings/')` 能拿到 200），NTP 页也能取到设置页的**静态资源**。这与今天设置页取自己的资源同一性质，且两者都是我们自己的沙箱文档；设置页的写通道仍由 `internalSender` 三条件挡住（NTP 标签不是 `settings`）。
3. NTP 页不获得 `baoSettings`、不获得外壳桥；`nodeIntegration:false / contextIsolation:true / sandbox:true` 不变。
4. NTP 不嵌外部内容（`frame-src 'none'`），避免把不可信层的问题带进来。

### 5.9 文件清单

| 文件 | 改动 |
| --- | --- |
| `app/src/main/internal-pages.ts` | 新增 `NEWTAB_HOST/NEWTAB_URL/isNewTabUrl/isInternalUrl/parseInternalAddress`；handler 按 host 分派；开发态代理按 host |
| `app/src/main/browser-window.ts` | `Tab.internal` 联合类型；`openInternalTab(kind)`；`openInternalSingleton`；`navigateTab`；`leaveNewTab`；`describe/revive/rebuild/duplicateTab/rememberClosed/openSettingsTab` 适配；NTP 发送者校验与 `ntp:*` IPC；`broadcastSettings` 扩展 |
| `app/src/main/start-page.ts` | 删除（或被 `NEWTAB_URL` 取代） |
| `app/src/preload/ntp.ts` | 新增：`baoNtp` |
| `app/src/shared/ntp.ts` | 新增：通道、快照、桥类型 |
| `app/src/renderer/newtab.html` / `newtab.ts` / `NewTabPage.vue` / `ntp-env.d.ts` | 新增 NTP 页面 |
| `app/src/renderer/App.vue` | NTP 标签图标（齿轮只给设置页）；NTP 激活时聚焦地址栏；占位文案 |
| `app/electron.vite.config.ts` | preload `ntp`、renderer `newtab` 两个入口 |
| `app/tests/unit/internal-address.test.ts` | `isNewTabUrl` / `parseInternalAddress` 用例 |
| `app/tests/smoke/newtab.test.cjs` | 新增合同用例（§6） |
| `app/tests/smoke/internal-page.test.cjs` | **必须改**：现在断言 `Ctrl+,` 后标签数 1→2（`:41-61`），改动后是 1；改为「先导航到网页再按」或直接断言就地 |
| `app/README.md`、`docs/kickoff/m2-beta.md` | 增量交付后在「当前增量范围 / 已交付增量」补一行 |

---

## 6. 分阶段与验收

**推荐路线：P0 单独一个增量先落地，P1 再一个增量。** 不合并的理由：P0 修的是用户直接抱怨的行为，可独立验收、独立回滚；P1 引入新的页面文档与 preload 桥，需要单独评审安全面（`baoNtp` 的发送者校验、CSP、页面拿不到设置写通道），而且没有 P0 的 `bao://newtab` 身份，P1 根本无处挂载。

### P0 · 行为对齐（不含页面内容）

交付 B1–B12、B15–B22。退出证据：

| 用例 | 断言 |
| --- | --- |
| 启动身份 | `tabs[0].internal === 'newtab'`，`webContents.getURL() === 'bao://newtab/'`，地址栏空，引擎胶囊不存在 |
| NTP→设置就地 | 1 个标签，`Ctrl+,` 后仍是 1 个、同 id、地址 `bao://settings/`、`canGoBack === true`；`back` 后回 `bao://newtab/` |
| 已有设置标签 | 先开设置（普通页上），回 NTP，再 `Ctrl+,` → 切到已有设置标签，NTP 仍在 |
| 普通页语义不变 | 网页上 `Ctrl+,` → 新开设置标签 |
| NTP→网页 | 地址栏输入 http(s) → 标签数不变、URL 变化、引擎胶囊出现 |
| 设置→网页 | 不变：新开标签，设置页不动 |
| 撤销关闭 | 关闭 NTP 后 `undoCount` 不变；关闭设置后 `Ctrl+Shift+T` 恢复设置 |
| 复制 | 复制 NTP → 新 NTP；复制设置 → 新设置 |
| 崩溃重建 | NTP 视图销毁后 reload 回到 `bao://newtab/` |
| 协议边界 | 页面会话 `fetch('bao://newtab/')` 失败（可合并进现有 `internal-page.test.cjs` 第二条） |

命令：`node scripts/test.cjs smoke newtab`、`node scripts/test.cjs unit`、`npm run typecheck`。

实施顺序（每步可独立跑用例）：

1. `internal-pages.ts`：`bao://newtab` 的 URL/协议/开发态代理（此时页面还是占位也可以）；
2. 标签身份与生命周期：创建/`describe`/`revive`/`rebuild`/`duplicate`/`rememberClosed`；
3. 单例入口：`openInternalSingleton` + 现在的 `Ctrl+,`/齿轮入口改成它；
4. `navigateTab` / `leaveNewTab`（NTP→网页）；
5. 焦点与外壳图标/文案；
6. 先改 `internal-page.test.cjs` 的标签数断言，再补 `newtab.test.cjs`。

### P1 · 页面职责 v1

交付 B13/B14/B23 + §5.5 的页面。退出证据：NTP 页 realbox 回车 → 同标签导航；点设置 → 同标签设置；`baoNtp` 面只有 `read/run/subscribe`；主题切换后 NTP 页面跟着重绘；Flash 缺失时显示导入提示。

### P2 · 数据驱动的 NTP

前置：M2「书签与历史」落地。之后再加「快捷方式」（最近访问 TopSites + 用户固定，SQLite）、搜索（`默认搜索引擎` 设置项）。**在数据源不存在时不画空板块**。

---

## 7. 决策与风险

**推荐基线（本稿的推荐值，待裁决）**：D1 = A；D2 = 按 Chromium（有子页后比较 URL 再导航）；D3 = realbox 只接受 URL；D4 = 保持现状；D5 = 按 Chromium；D6 = P0 不动文案/图标、P1 统一。理由见下。

**D1（必须裁决）NTP 放在哪个会话，以及「Back 回 NTP」怎么办**

| 方案 | 做法 | 得到 | 失去 |
| --- | --- | --- | --- |
| **A（推荐）** | NTP 与设置同在内部会话；NTP→http(s) 换 WebContents | 设置复用完全对齐（就地 + Back 回 NTP）；「内部会话不承载 http(s)」不变量不动 | 从网页 Back 不回 NTP（Chromium 能） |
| B | NTP 放页面会话（`bao` handler 额外绑 `newtab` host）；设置仍在内部会话 | 网页导航保留 NTP 历史 | NTP→设置也要换视图（同样回不到 NTP）；页面会话多一个特权 host 的服务面 |
| C | 把 NTP 视图保活，做成标签内的「视图栈」 | 两边都保真 | 每个离开 NTP 的标签常驻一个渲染进程；标签模型复杂化，与休眠/内存目标冲突 |

推荐 A；「Back 回 NTP」已按「记住来源是 NTP，Back 时重建 NTP 视图 + 记住原 URL 供 Forward 重载」的轻量方案补上（2026-11-24，见报告 §3）；页面状态不保留是它的已知代价。

**D2（推荐：按 Chromium）设置页复用是否重置到根页**：当前设置页无子页路由，复用不导航即等价；等设置页出现子页路由后，按 Chromium 的 `IGNORE_AND_NAVIGATE` 语义「比较 URL，不同则导航到目标子页」。

**D3（推荐：只接受 URL）realbox 的搜索语义**：本期只接受 URL（与地址栏同规则），非 URL 返回 `invalid-address` 的**行内**提示、页面不跳转；搜索依赖「默认搜索引擎」设置项，另立项。

**D4（推荐：保持现状）关闭最后一个标签**：我们补一个新 NTP，Chromium 关窗口。改动会影响现有冒烟与用户预期，不在本期动。

**D5（推荐：按 Chromium）撤销关闭**：纯 NTP 标签不入撤销栈；设置标签照旧可恢复。

**D6（推荐：分两步）文案与图标**：P0 不改地址栏占位「输入网址」、NTP 沿用现有页面图标（避免与行为改动混在一起评审）；P1 有 realbox 后统一为「输入网址或搜索」，NTP 标签改用现有 glyph 拼的专用文档图标，不新增图片资源。

**风险**

| # | 风险 | 处置 |
| --- | --- | --- |
| R1 | `internal-page.test.cjs` 与其它依赖「`Ctrl+,` 必新开标签」的用例失败 | 先改用例再改实现；一次性跑全量 smoke |
| R2 | NTP→网页换视图后，页面事件/焦点/布局出现竞态 | 复用引擎切换已验证的 `swapView` 路径；用例断言标签数/位置/地址 |
| R3 | 内部会话同时承载两个 host，origin 隔离是否按预期 | 用例断言 `location.origin` 为 `bao://newtab`、localStorage 与设置页不互通 |
| R4 | 开发态 Vite 代理写死 `/settings.html` 导致 NTP 打不开 | 同一处按 host 映射，dev + build 两条路径都验 |
| R5 | 打包后 `out/renderer/newtab.html` 未进包 | `electron.vite.config.ts` 加入口；`smoke:packaged` 补一条 NTP 断言 |

---

## 8. 未验证 / 不承诺

1. **会话恢复**未实现（M2 剩余范围）：NTP 恢复为「重新打开 NTP」，历史栈不跨重启。
2. **Chromium 151 与现代 Chrome 的差异**未逐版本核对；结论以本机 142 源码为准，实测仅作旁证。
3. NTP 的 **most visited / 快捷方式**、**搜索**、**个性化（背景/主题）** 依赖数据层与设置项，本期不交付、不承诺时间。
4. **不可信层（untrusted iframe）** 不移植：我们不嵌外部内容。
5. `Ctrl+,` 在 Chromium Windows 上并不存在（仅 macOS），我们沿用产品既有绑定，未做跨平台一致性论证。
6. 「Back 回 NTP」已由 `fromNewTab`/`newTabForwardUrl` + `returnToNewTab` 补上；Back 是「重建 NTP 视图」而不是历史回放，页面状态不保留（见报告 §3）。

---

## 附录 A · Chromium 证据索引

| 主题 | 文件:行 |
| --- | --- |
| NTP 虚拟 URL / host 常量 | `chrome/common/webui_url_constants.h:191,198-199`；`chrome/browser/search/search.cc:368-379,384-400` |
| NTP 两层结构与 CSP | `chrome/browser/ui/webui/new_tab_page/new_tab_page_ui.cc:645-654`；`.../untrusted_source.cc:125-140,299-305`；`webui_ntp_browsertest.cc:114-125` |
| 单例覆盖 NTP | `chrome/browser/ui/singleton_tabs.cc:56-104,106-164`；`chrome/browser/ui/browser_navigator.cc:603-608,668-680,851-902` |
| 设置页入口 | `chrome/browser/ui/chrome_pages.cc:106-119,466-498`；`chrome/browser/ui/browser_command_controller.cc:1027-1029`；`accelerators_cocoa.mm:63-65` |
| 就地导航追加历史 | `chrome/browser/ui/browser_navigator_params.h:328`；`.../browser_navigator_params_utils.cc:31-32` |
| Back 回 NTP | `chrome/browser/ui/search/instant_extended_interactive_uitest.cc:120-144` |
| 初始 entry 替换 | `content/browser/renderer_host/navigation_request.cc:10619-10629`；`navigation_controller_impl.cc:2107-2112` |
| 撤销关闭过滤 NTP | `components/sessions/core/tab_restore_service_helper.cc:1098-1109` |
| 新建/启动/关闭 | `chrome/browser/ui/browser_commands.cc:1034-1054`；`browser_tabstrip.cc:38-44`；`browser.cc:811-817,1758-1763`；`startup_tab_provider.cc:339-346` |
| 焦点 / 地址栏 | `chrome/browser/ui/browser.cc:1864-1873,2363-2399`；`chrome/browser/ui/toolbar/chrome_location_bar_model_delegate.cc:119-131` |
| NTP 失败兜底 | `chrome/browser/ui/search/new_tab_page_navigation_throttle.cc:31-75` |
| 孤儿 NTP | `chrome/browser/ui/browser_navigator.cc:878-900` |

## 附录 B · 本仓库代码索引

| 主题 | 文件:行 |
| --- | --- |
| 占位 NTP | `app/src/main/start-page.ts:5-23` |
| 标签创建/内部页 | `app/src/main/browser-window.ts:618-671` |
| 打开设置 | `app/src/main/browser-window.ts:661-671` |
| 地址栏投影 | `app/src/main/browser-window.ts:295-363` |
| 导航分支 | `app/src/main/browser-window.ts:1266-1312` |
| 撤销/复制/重载 | `app/src/main/browser-window.ts:876-883,956-1027` |
| 内部协议/会话 | `app/src/main/internal-pages.ts:21-185`；`app/src/main/sessions.ts:16-20,138-145` |
| preload 窄桥 | `app/src/preload/internal.ts:13-26` |
| 设置页桥类型 | `app/src/shared/settings.ts:136-207` |
| 构建入口 | `app/electron.vite.config.ts:21-46` |
| 现有用例 | `app/tests/smoke/internal-page.test.cjs:37-67`；`app/tests/unit/internal-address.test.ts` |
