# 外壳 chrome 尺寸对齐 Chrome + 站点图标

2026-11-26 · 对应 [收藏夹横条](./2026-11-26-bookmark-bar.md)、
[C5-S3 裁决](../discussions/2026-11-21-bfb-next-architecture.md)。

2026-11-26 反馈（四窗口对照截图，左上我们 / 右上 Chrome / 下面两个 Edge）：
"标签页宽度似乎不如正常浏览器宽、地址栏/工具栏高度差几像素、前进后退刷新的间距也有问题、
常驻按钮太小气、怎么没有 favicon"。前四条是**尺寸**，第五条是**功能**。

## 1. 尺寸：照抄 Chromium 142 的布局常量

唯一来源是 `shared/browser.ts` 的三个常量（页面视图的 y 偏移由它们算出来）与
`renderer/tokens.css` 的控件尺寸。依据全部是 Chromium 142（非触摸档）：

| 项 | 之前 | 现在 | 依据 |
| --- | --- | --- | --- |
| 标签栏高 | 40 | **41** | `TAB_STRIP_HEIGHT` = `TAB_HEIGHT(34) + TABSTRIP_TOOLBAR_OVERLAP(1)` + `TAB_STRIP_PADDING(6)`（`layout_constants.cc:113`） |
| 工具栏高 | 44 | **46** | `max(location_bar 34, back 34) + TOOLBAR_INTERIOR_MARGIN.vertical()(6×2)`（`toolbar_view.cc:765`） |
| 收藏夹横条 | 32 | **34** | `BOOKMARK_BAR_BUTTON_HEIGHT(28) + 6`（居中留白） |
| 标签宽 | 180 | **256**（可缩到 88） | `kTabWidth(232) + 2×底角(12)`（`tab_style.cc:31`） |
| 标签高 | 34 | **35** | `TAB_HEIGHT` |
| 标签圆角 | 8 / 6 | **10 / 12** | `TabStyle::GetTopCornerRadius/GetBottomCornerRadius` |
| 标题内距 | 12 / 4 | **8 / 4** | `TAB_PRE_TITLE_PADDING` / `TAB_AFTER_TITLE_PADDING` |
| 工具栏按钮 | 32×32 | **34×34** | `TOOLBAR_BUTTON_HEIGHT` |
| 地址栏高 | 32 | **34** | `LOCATION_BAR_HEIGHT` |
| 工具栏左右内距 | 8 | **5** | `TOOLBAR_INTERIOR_MARGIN` 水平 5 |
| 元素间距 | 4 | 4 ✓ | `TOOLBAR_ELEMENT_PADDING` |

页面视图的 y 因此从 **84** 变成 **87**（带收藏夹横条 121）。

**没有对齐的一项**：网页区域的四角圆角（Edge 的行为，`ContentsRoundedCorner`）。这是
产品裁决——**不对齐**（2026-11-26 反馈："那个是 edge 行为，不用对齐也可以"）。

## 2. 站点图标

链路（Chromium 的 `FaviconTabHelper` 语义，`FaviconService` 的简化版）：

```
渲染进程 page-favicon-updated(候选 URL[])
  → 主进程 applyFavicon()：按**图标 URL** 去重 → pageSession.fetch（5 s 超时 / 64 KB 上限 / 只收 image/*）
  → 内联 data: URL → BrowserTab.favicon → 外壳 <img class="favicon">（16×16，2px 圆角）
```

四个真实约束（都有用例或注释兜住）：

1. **缓存键是图标 URL，不是 origin**。同站点不同页面可以用不同图标（`<link rel=icon>` 指到
   别处），按 origin 缓存会把 A 页的图标画到 B 页上——第一版就是这么错的，`/with-icon` 的
   图标挂在了 `/no-icon` 上。
2. **新文档提交时先清图标**（`did-navigate`）。不清的话从"有图标"的页面走到同站点"没有
   图标"的页面，会一直挂着上一个页面的图标。清空后同站点的图标会在下一次
   `page-favicon-updated` 里从缓存瞬间补上。
3. **失败也缓存**（`undefined`）。没有图标的站点（大量内网页、极简页）否则每次导航都发一次
   注定失败的请求。
4. **异步回来时校验标签还在不在那个 origin 上**，否则后到的图标会画到已经导航走的新页面上。

没有图标时退回通用页形（`<span class="glyph page">`），**不画占位方块**。

### 2.1 "抓不到"的两个真原因（2026-11-26 下午）

1. **协议相对地址**。大量站点写的是 `//s1.hdslb.com/bfs/.../favicon.ico`（bilibili 就是），
   或站内相对路径 `/static/icon.png`。第一版直接拿它当绝对地址，`new URL()` 抛错就整个
   丢掉——**候选必须先按页面地址解析**（`new URL(candidate, pageUrl)`）。
2. **不信 `Content-Type`**。老站点（以及一堆 404 兜底页）把 `favicon.ico` 发成
   `text/plain` / `application/octet-stream` / `text/html`，按响应头一票否决就永远拿不到。
   现在读回字节**按魔数**认（PNG/JPEG/GIF/ICO/BMP/WEBP/SVG），认不出的**一律丢弃**——
   宁可没有图标，也不要往 `<img>` 里塞 HTML 或半张损坏的位图。

老项目（`BaoFlashBrowser/src/main/modules/tabs.ts:595`）是直接把图标 URL 塞给渲染进程的
`<img src>`：没有大小上限、没有类型判断、也没有 referrer 处理，所以"老站点抓着抓着就崩"
（多尺寸大 ICO + 404 兜底页）。本实现把**抓取放在主进程**、内联成 `data:` URL 再给渲染
进程，并加了 64 KB 上限与魔数白名单——渲染进程永远只拿到一张已经认过型的位图。

### 2.2 加载转圈（Chromium 的 throbber）

标签图标在**加载中**显示转圈，加载完换回站点图标（Chromium 的 `TabIcon`：三者互斥）。
数值照抄 `ui/gfx/paint_throbber.cc`：弧最大 **270°**、伸长期 **667 ms**（两次关键帧
1333 ms 一轮）、整圈 **1568 ms**、描边 **2dp**、缓动 `cubic-bezier(.4, 0, .2, 1)`
（`FAST_OUT_SLOW_IN`）。实现是 50 的 viewBox 里一个 `<circle>` + 两条 CSS 动画
（`throbber-rotate` + `throbber-dash`），`prefers-reduced-motion` 下退化成静止的 3/4 弧。

### 2.3 一个被截图抓到的坑：CSP 拦掉了 `data:`

第一次跑通链路后截图，标签上是一张**破图**：`<img src="data:image/png;base64,…">` 有值，
但浏览器没画出来。原因是外壳文档的 CSP 只有 `default-src 'self'`，而 `img-src` 会回落到
`default-src`——`data:` 被拒。

两处都改了：`renderer/index.html` 的 meta 加 `img-src 'self' data:`；用例改成断言
**`naturalWidth`**（真的解码出来了）而不只是 `src`——只看 `src` 的话，这张破图能一路通过。

### 2.4 搜索引擎下拉：宽度按最宽的引擎名撑开
**触发按钮的宽度 = 下拉的宽度**，两者都按"最宽的引擎名"撑开（Edge 的做法）。
为什么不能纯 CSS：撑宽层若参与布局会顶高按钮，用 `position: absolute` 又不参与宽度计算——
两边都不成立。所以用一个**绝对定位的隐形副本**量出文字宽度，写到 `min-width` 上，
下拉再取同一个值。

还要一个**下限**（`ENGINE_TRIGGER_MIN_WIDTH = 168`）：字体还在加载时量出来偏窄，标签会被
截成"Go…"（2026-11-26 连续两次截图都是这个现象）。用例除了断言"下拉与按钮同宽"，还断言
**标签没被截断**（`scrollWidth <= clientWidth`）且量到的宽度**大于 0**——只断言同宽的话，
两边都是 0 也能过。


### 2.5 收藏夹面板：文件夹可展开可关闭

面板里两个永久根原来画成"分组标题 + 分隔线"，看起来像两个死标题、也没法收起。
现在它们是**行**（带箭头，点一下铺开子项、再点收起），默认全收起（和 Edge 打开收藏夹时
一样）：先看到两个文件夹，点开才铺内容。没有子项的文件夹不画箭头（点了也不会有东西
展开，那就是假控件）。展开状态只在本组件里，不做持久化——"上次点开了哪个文件夹"不是
需要记住的偏好。

**未做**：横条上的文件夹下拉（点横条里的文件夹直接打开面板，而不是在条下弹一层菜单）——
那需要一只独立的弹出层；面板里的图标已经按书签地址抓好了（§2.2）。

### 2.6 横条项的尺寸与 chrome 的鼠标指针

**横条项**（2026-11-26 反馈："会不会太宽、高度矮了几px"）此前是 24 高 / 200 上限 / 8 内距 /
4 间距，全部偏离 Chromium 的 `BookmarkButtonBase`：

| 项 | 改前 | 现在 | 依据 |
| --- | --- | --- | --- |
| 高度 | 24 | **28** | `BOOKMARK_BAR_BUTTON_HEIGHT`（横条 34 = 28 + 上下各 3） |
| 最大宽度 | 200 | **150** | `bookmark_button_util.h` 的 `kMaxButtonWidth`（超了标签省略） |
| 左右内距 | 8 | **6** | `INSETS_BOOKMARKS_BAR_BUTTON`（全 6） |
| 图标-文字间距 | 4 | **6** | `BOOKMARK_BAR_BUTTON_IMAGE_LABEL_PADDING` |
| 图标 | 13 | **16** | 横条的图标列是 16 |

宽度是**内容驱动**的（没有固定值）：标题多长按钮就多宽，到 150 开始省略，放不下的项由
overflow 收进「»」。

**鼠标指针**：外壳 chrome 里的按钮（标签页 × / +、工具栏、横条项）统一用**默认箭头**。
它们悬停时已经有底色变化，"可点"由样式承担；手型是网页链接的约定，出现在 chrome 上像网页
元素（Chromium 的 Views 控件同样不用手型）。规则只有一条：`.shell button { cursor: default }`。

## 3. 验证

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run test:unit` | **361/361** |
| 隐藏冒烟（全量，4 并发） | **34 个文件 0 失败**，117.0 s |
| `favicon.test.cjs` | 3 条：有图标页面（**且真的解码出来**）、无图标页面退回页形、**加载中转圈**、横条按书签地址补图标（含从没打开过的站点） |
| `bookmark-bar.test.cjs` | 4 条：显示规则/页面让位/点击导航/文件夹锚定、导航途中按住、**横条项尺寸（28/150/6/6）**、**chrome 按钮用默认箭头**、档位跨重启 |
| `settings-search-engine.test.cjs` | 1 条：搜索引擎是下拉框、当前项排第一行、**下拉与按钮同宽且标签不截断**、说明文字已去掉、Esc 收起 |

### 3.1 一处自查发现的问题

冒烟套件的文件清单是 `scripts/test.cjs` 里**硬编码**的：新加的 `bookmark-bar.test.cjs`
与 `favicon.test.cjs` 一开始都没进全量跑——"31 个文件 0 失败"其实是**没跑到它们**。
两处都已补上（清单 + `test-map.cjs` 的 `--changed` 映射），全量现在是 **34 个文件**。
