# M2 / 收藏夹（第四轮）：`bao://favorites` 管理页

2026-11-27 · 承接 [`2026-11-26-bookmarks-store.md`](./2026-11-26-bookmarks-store.md)（v3 树）、
[`2026-11-26-bookmark-bar.md`](./2026-11-26-bookmark-bar.md)（横条）、
[`2026-11-26-chrome-metrics-favicon.md`](./2026-11-26-chrome-metrics-favicon.md)（尺寸与图标管道）。

三个提交：`413750d` 页面与增删改 → `26bc005` 拖动排序 → `917dcea` 导入。
第四个提交（`设置 → 浏览数据 → 收藏`，即分类清理的收藏档）单独一笔，见 §7。

## 1. 范围与入口

收藏夹这条线的最后一块：拖动排序、重命名/删除文件夹、导入 Chrome/Edge 导出的书签。

| 入口 | 位置 | 说明 |
| --- | --- | --- |
| 横条空态「立即管理收藏夹」 | `App.vue` 的 `.bar-hint-action` | 原来打开的是飞窗，用户还得多点一次才能整理 |
| 横条右键菜单「管理收藏夹…」 | `browser-window.ts` 的 `showBookmarkBarMenu()` | Chromium 的横条组织菜单里同样有 `Manage bookmarks…` |
| 收藏夹飞窗底部「管理收藏夹」 | `BookmarksPanel.vue` `.hub-manage` | 面板只做浏览，整理在管理页 |

打开后是一个**普通标签**，地址栏显示 `bao://favorites/`，标签标题「收藏夹」，
关掉再开是单例（已有就切过去、当前是 NTP 就地覆盖、否则新开）。

## 2. 为什么是整页，而不是第四只飞窗

- `chrome/browser/ui/webui/bookmarks/bookmarks_ui.cc` 把 `chrome://bookmarks` 注册成独立
  WebUI（host + `WebUIConfig`），就因为它要同时摆下「文件夹树 + 条目列表 + 工具栏」；
- 我们的飞窗卡片宽 264（`shared/overlay-geometry.ts` 的 `ENGINE_PANEL_CARD_WIDTH`，
  `BOOKMARKS_WIDTH` 也是 320），装不下这三块；硬塞就是满屏滚动条。

所以它是**第三种内部页**：`InternalKind = 'newtab' | 'settings' | 'favorites'`。

## 3. 接线（一处定义，四处消费）

```
main/internal-pages.ts     InternalKind + internalUrls + ENTRY_FILES + internalTitles + isFavoritesUrl()
        ├─ server:   bao://favorites/ → out/renderer/favorites.html（含首帧注入）
        ├─ main/browser-window.ts:
        │     favoritesSender()    本窗口标签 ∧ 主帧 ∧ 文档 URL ∈ bao://favorites/*
        │     favoritesSnapshot()  全量收藏树 + 站点图标 + 主题 + 存储状态
        │     runFavorites()       六条命令的统一入口
        │     openSingletonInternal(kind)  单例页（设置与收藏夹各有各的，互不顶掉）
        └─ preload/internal.ts     window.baoFavorites（read / run / subscribe）
```

三条约束与设置页完全同构，都是前面几轮踩出来的：

1. **三种内部页共用一个 preload**：同一个 WebContents 会在内部文档之间就地导航，
   按 kind 换 preload 会让导航后的文档拿不到桥；
2. **发送者身份由主进程判**，不信任何页面传的东西：网页拿不到这条通道，NTP 与设置页也拿不到
   （它们的 `tab.internal` 不是 `favorites`）；
3. **首帧注入**（`shared/internal-bootstrap.ts`）：`bao://` 的响应在返回 HTML 前把主题变量与
   `FavoritesSnapshot` 塞进 `<head>`，所以第一帧就是真的树与列表，没有"空列表 → 内容"的跳变。

`internalTitles` 放进 `internal-pages.ts` 而不是各处写三元表达式：标题只有一处定义，
建标签与就地切换共用——否则会重现"从 NTP 变成设置页，标签却还写着新标签页"那个老问题
（`placeholderTitle()` 的注释里记着）。

收藏夹标签**不进会话恢复**（与设置页同一条）：它是随时可重开的内部页，恢复出来只是多一个标签。

## 4. 命令面

| 命令 | 语义 | 拒绝码 |
| --- | --- | --- |
| `open {id}` | **新前台标签**打开（地址由主进程按 id 从库里取） | `bookmark-missing` |
| `create-folder {title, parentId}` | 新建文件夹，返回 `createdId`（页面据此进入改名态） | `bookmark-save-failed` |
| `rename {id, title}` | 改名（书签与文件夹通用） | `invalid-command` / `bookmark-save-failed` |
| `remove {id}` | 删除（文件夹连同子树） | `bookmark-save-failed` |
| `move {id, parentId, index}` | 拖动排序 / 换文件夹 | `bookmark-placement` / `storage-unavailable` |
| `import-html {html}` | 导入导出文件 | `invalid-command`（含 `reason: unreadable \| empty`）/ `storage-unavailable` |

`open` 的语义照 `chrome/browser/resources/bookmarks/command_manager.ts:556-558`：
`Command.OPEN → openInNewTab(id, {active: true})`。双击才打开、单击只选中；管理页留在原标签
（Chromium 同样保留）。

`move` 的 `index` 是**移除被拖项之后**的位置（`store.moveBookmark()` 的口径），换算只走一个
纯函数 `shared/bookmarks.ts` 的 `insertionIndex()`——两边各算一遍就是"向右拖永远偏一格"，
而这种错只有像素级观察才看得出来，所以用 6 条单元用例钉住。

`bookmark-placement` 是**新加的一句独立的话**：环（把文件夹拖进自己的子孙）与目标不是文件夹
由存储层的 `checkPlacement()` 拒，界面提示「不能把文件夹移到它自己或它的子文件夹里」，
而不是笼统的"没保存"。拖拽不做乐观更新：非法落点在 dragover 阶段就不给落点反馈
（画了指示线就代表松手会成功）。

## 5. 交互

| 操作 | 行为 | 依据 |
| --- | --- | --- |
| 单击 | 选中（列表行选中条目，树行选中文件夹并切内容区） | Chromium 的 `selectItem` |
| 双击 | 打开：网址 → 新前台标签；文件夹 → 进目录 | `command_manager.ts:556-558` |
| F2 / 「重命名」 | 行内输入框（Enter/失焦提交、Esc 取消） | Chromium 用对话框，我们没那个对话框 |
| Delete / 「删除」 | 删除；**带子项的文件夹先弹页内确认** | 我们没有 Ctrl+Z，删掉整棵子树找不回来 |
| 拖动 | 上 1/4 插前、下 1/4 插后、中间 1/2 放进文件夹（仅文件夹行）；树里只做"放进" | `dnd_manager.ts` 三段式 |
| 搜索 | 标题与地址都参与；结果跨文件夹平铺，右侧显示所属路径 | `matchesQuery()` |

删除确认用**页内**一条而不是原生 `dialog.showMessageBox`：原生模态会让冒烟用例卡在对话框上，
而"删整棵子树不可撤销"这件事本身用一行文案说清楚就够了。

禁用而不是隐藏：永久根不能删时「删除」按钮置灰（点不了但占位，工具栏宽度不跳）；
存储不可用时全部写操作置灰。

## 6. 导入

解析 `shared/bookmark-import.ts`（纯逻辑，10 条单测 + 4 条存储层用例）。这份格式**不是合法
HTML**（`<DT>` 不闭合、`<DL><p>` 乱标签对），只能按行扫——Chromium 也是：
`components/user_data_importer/content/content_bookmark_parser_utils.cc:391-562`。

从源码抄来的语义（每一条都对应一个"导入后会很难看"的结果）：

| 规则 | 依据 |
| --- | --- |
| `PERSONAL_TOOLBAR_FOLDER="true"` 标出书签栏；**它那一层不进树**，子结构原样保留 | `profile_writer.cc:189-194` |
| `FEEDURL`（Firefox 实时书签）整条跳过 | `parser_utils.cc:279-283` |
| 只收 http(s) | `bookmarks_file_importer.cc:31-77`；与 `isBookmarkableAddress` 同一条产品规则 |
| 标题反转义 HTML 实体 | 否则导出再导入一次名字就花了 |
| 空文件夹保留（`<H3>` + 空 `<DL>`） | 导入最容易丢的就是空目录 |
| 属性缺失时按顶层文件夹名兜底认书签栏 | **我们自己的补充**：手工整理的导出不一定带属性，而"书签栏被当成普通文件夹塞进其他收藏夹"最刺眼 |

合并规则逐条对齐 `ProfileWriter::AddBookmarks()`（`profile_writer.cc:122-226`）：

1. 收藏夹栏**空着** → 书签栏那批直接铺进栏里，其余进新的「已导入」容器；
2. 收藏夹栏**已有内容** → 整份进「已导入」，不冲掉用户现有排布（结构保留在容器里）；
3. 目标父节点下**同名文件夹复用不重建**；容器重名按 `已导入 (n)` 递增（`:49-71`）；
4. 全部写入在**一个事务**里，失败回滚，不落半份。

命令**只收文本**、页面自己用 `<input type="file">` + `File.text()` 读文件：主进程完全不碰
文件路径（少一条"页面诱导主进程读任意文件"的通路），也让冒烟能在不弹原生对话框的情况下
走完整条链路。上限 8 MB（IPC 载荷不该无界）。

**已知代价**（照 Chromium）：Chrome 自己的导出里「Other bookmarks」是一个顶层文件夹，
导入后它作为文件夹落在「已导入」里面，所以会出现 `已导入 / Other bookmarks / …` 这一层。
Chromium 导入自己的导出也是这样；把顶层「其他书签/Other bookmarks」直接映射到 `other` 根
是一个可选的产品改良，本轮没做（会多一条特判与一组用例）。

## 7. 分类清理的「收藏」档

`设置 → 隐私、搜索和服务 → 浏览数据` 的同一张卡里，与「已保存的会话」并列。
`clearBookmarks()` 只清内容、保留两个永久根（`bar` / `other`）与它们的位置：连根删掉的话，
横条与面板会变成"收藏夹栏不见了"，而不是"清空了"。

清除是**进程级**操作，所以走新加的 `controller.refreshBookmarks()`（= `publish()` +
`broadcastFavorites()`），由 handle 自己遍历所有窗口。不能复用 `publishBookmarks()`
（那个是给"某一条收藏变了"用的，会补图标、还会再遍历一次其它窗口）。
用例断言了这条链：管理页开在后台 → 设置页里清 → 管理页 DOM 自己变空、状态区没有错误。

## 8. 踩过的坑

1. **`html, body` 没有归零**：`tokens.css` 只定义变量、不重置盒模型。第一版管理页带着浏览器
   默认的 8px 外边距，`height: 100vh` 再叠上去就长出一条整页滚动条（截图上右侧那道竖条）。
   内部页要自己写 `html, body { margin: 0; height: 100% }`。
2. **`box-shadow: inset` 画插线会被圆角切出弧形端头**：看起来像胶囊，不是直线。改成绝对定位
   的 `::before/::after` 2px 直线（截图对比后换的）。行需要 `position: relative`。
3. **行上的 `drop` 会冒泡到列表容器的 "追加到末尾"**：同一次拖拽发两条 `move`，第二条覆盖
   第一条。行上必须 `stopPropagation()`。
4. **落点反馈是 Vue 下一帧才写进 class 的**：用例里 `dragover` 之后立刻读 `className` 会读到
   旧值（表现为"插线没画出来"）。要过一帧（`requestAnimationFrame`）再读——不是放宽断言。
5. **导出的书签栏包装层**：解析时如果把 `<H3 PERSONAL_TOOLBAR_FOLDER>` 那个文件夹也 push 进
   树，导入后就永远多一层「收藏夹栏 / 收藏夹栏」，而且统计会把包装层算成一个文件夹
   （单测里先红过一次）。
6. **树的展开状态影响用例**：新建在「技术」里的子文件夹在树上默认折叠，`querySelector` 找不到
   那一行。要么按 id 点列表行，要么先展开——不要以为是数据没进去。
7. **`scripts/build.cjs` 的产物检查**：原来只查 `index.html` / `settings.html`，新增页面时会
   出现"产物缺文件、构建却判定为最新"，那个页面就永远 404。现在四个内部页都在检查表里。

## 9. 验证

- `npm run typecheck` 通过；
- `npx vitest run`：**379** 条通过（本轮 +18：`insertionIndex` 6、导入解析 10、存储合并 4，另
  2 条为既有用例扩写）；
- 新冒烟 `tests/smoke/favorites.test.cjs`：**5** 条通过（页面与只读边界 / 增删改与确认条 /
  双击与搜索与飞窗入口 / 拖动排序 / 导入），已登记到 `scripts/test.cjs` 与 `scripts/test-map.cjs`；
- `data-cleanup.test.cjs` 新增「清除收藏」1 条，全文件 4 条通过；
- 全量冒烟跑过一遍（见提交信息里的结果）。

量出来的数值（`capturePage` + DOM 断言）：

| 项 | 实测 |
| --- | --- |
| 管理页视图 | `y = 87`（标签栏 41 + 工具栏 46）、`x = 0`、宽度占满 |
| 工具栏 | 高 48 |
| 左树 | 宽 232；内容区紧贴其右 |
| 列表行 | 高 40 |
| 桥 | `window.baoBrowser === undefined`、`window.baoOverlay === undefined`、`baoFavorites` 是对象 |
| 拖拽 | `dragover` 时 `drop-before` / `drop-after` / `drop-inside` 三种反馈都真的出现；落库后排序位仍是 `0..n-1` |
| 导入 | 状态行「已导入 5 条收藏、4 个文件夹（跳过 3 条非网页地址）」；库里 `javascript:` / `place:` / `feed:` 一条没有 |

截图（`C:\Users\95470\AppData\Local\Temp\bao-shot\`）：`favorites-light.png`、
`favorites-dark.png`、`favorites-drag.png`、`favorites-drag-inside.png`、
`favorites-import.png`、`favorites-import-tree.png`、`settings-privacy.png`。

## 10. 已知边界（下一步）

1. **横条上的文件夹下拉**（任务 #2）：已交付，见 §11.5。
2. **多选 / 剪切粘贴 / 撤销**：Chromium 的书签管理器有，本版没有（所以删除才加了确认）。
3. **历史**（任务 #3）：`urls` + `visits` 双表，C5-S2 已裁决，尚未开工。

---

# 11. 2026-11-27 验收反馈与修正

一轮验收提了五条，逐条对应：

| 反馈 | 根因 / 裁决 | 修正 |
| --- | --- | --- |
| 导入时出现「此网站已被禁止使用动态传感器和光传感器。(*.shtml;*.html;…)」 | **不是我们的文案**：`<input type="file">` 的"文件类型"标签由系统按 HTML 的**友好名称**拼出来，这台机器上 `HKCR\htmlfile\FriendlyTypeName` = `@C:\WINDOWS\system32\ieframe.dll,-912`，而该资源位在中文 Windows 上是那条 IE 传感器通知串 | 见 §11.1 |
| 设置面板没有进收藏夹管理页的入口 | 确实缺——设置里只有"显示不显示"三档 | 见 §11.2 |
| 展开状态没持久化 | 原先刻意不做（注释里写着"不是需要记住的偏好"），用户否决 | 见 §11.3 |
| 导入后的 `已导入 / Other bookmarks / …` 这一层 | Chromium 的行为，但用户判定是噪音 | 见 §11.4 |
| 横条文件夹下拉（任务 #2） | 原先点文件夹打开的是收藏夹飞窗 | 见 §11.5 |

## 11.1 导入的文件选择框：改用主进程对话框

复现方式（可审计）：用**真实鼠标事件**点「导入…」（`executeJavaScript` 里的 `click()` 没有用户激活，
文件框会被 Chromium 拦掉），截屏 → 对话框标题「打开」，右下角"文件类型"下拉显示的就是那句警告，
后面跟着 `(*.shtml;*.html;*.ehtml;*.shtm;*.htm;*.html;*.htm)`——一个**文件过滤器**模式串。

也就是说：系统把 `text/html` 的过滤器描述解析成了那条 IE 资源串。我们无法修注册表，
能做的是**不依赖系统的类型名**：改成主进程 `dialog.showOpenDialog({ filters: [{ name: '书签文件（HTML）', … }] })`，
过滤器名由我们自己给。实测截图（`import-dialog.png`）：标题「导入收藏夹」、按钮「导入」、
类型「书签文件（HTML） (*.html;*.htm)」——警告消失。

两条入口并存，都是真的：

- 「导入…」→ `import-file`：主进程开框、主进程读文件（`decodeBookmarkFile()` 认 BOM，UTF-16 也能进）；
- **拖放**文件到管理页 → 页面读字节 → `import-html`：dragover 时整页给「松开以导入」的虚线提示。
  这条也是冒烟能跑通的那条（原生对话框在自动化里点不了）。

## 11.2 设置页的入口

`设置 → 外观 → 收藏夹栏` 那张卡里，三档下面加一行「整理收藏 / 管理收藏夹」。
走新通道 `settings:open-favorites`：设置页只说"打开"，目标地址由主进程写死；
`setImmediate` 后再切页（动作会让发送方文档所在的标签被顶掉，先回 IPC 结果再切，与 NTP 的
`open-settings` 同一手法）。

## 11.3 展开状态持久化

存 `meta` 表（键 `bookmarks.expanded`），不进 `settings`：它不是偏好设置，而 `settings` 表每个键
都要在 `sanitizeSetting()` 里有一个受控取值域，塞 JSON 数组进去会把那张表变成杂物间。

```
db(meta) → storage.setBookmarksExpanded() → BrowserState.bookmarksExpanded ─┬─ 收藏夹飞窗（点箭头写回）
                                          → FavoritesSnapshot.expanded   ──┘─ bao://favorites 管理页
```

- `undefined` = **从来没记录过**：各界面用自己的默认（飞窗全收起、管理页展开两个根）；
  空数组 = 用户把所有文件夹都收起了（界面照做）。这两者不能混。
- 投影时按**现有节点**过滤（`expandedIds()`）：删掉的文件夹残留 id 不会再被任何界面用到。
- 写入路径两条（外壳的 `set-bookmarks-expanded` 与管理页的 `set-expanded`）落的是同一份数据，
  用例覆盖：管理页收起「收藏夹栏」→ 飞窗里也只有两个根 → **重启后仍是收起的**。

## 11.4 拆掉「其他收藏夹」包装层

解析完再拆：顶层文件夹名命中 `其他收藏夹 / 其他书签 / Other bookmarks / Other favorites …`
（`FALLBACK_OTHER_TITLES`）时，它的子项**就地铺到 `other`**、包装层不进树、也不计进统计。
**只认顶层**——深层的同名文件夹是用户自己建的，不能吞掉（用例覆盖两种）。

这与 Chromium 不同（Chromium 会保留那层），是用户明确要求的偏差，记在这里以免以后又"对齐"回去。

## 11.5 横条文件夹下拉

原生菜单（`Menu.popup`）：横条在外壳文档里，而页面视图盖在内容区**上方**，HTML 下拉一旦伸进
页面区就会被压住（飞窗整套视图就是为绕开这一点存在的）。Chromium 的横条文件夹菜单同样是原生
（`bookmark_bar_view.cc` 的 `ShowFolderMenu` → `BookmarkMenuDelegate`）。

- 内容：`shared/bookmarks.ts` 的 `folderMenuOf()`（纯函数）→ 主进程翻译成 `MenuItem`，
  子文件夹递归成子菜单，深度上限 8；空文件夹给一条**禁用**的「（空文件夹）」（弹个空菜单
  等于点了没反应）。
- 位置：界面只传**内容区**坐标（按钮右下角），主进程换算成窗口坐标——界面不碰屏幕坐标，
  多屏/缩放下不会错位。
- 打开：菜单项走 `open-bookmark` 的同一个语义（当前标签导航，地址取自库里）。
- 用例只能钉住"不再打开飞窗 + 命令被接受"，菜单内容由 `folderMenuOf()` 的单测钉住
  （原生菜单在自动化里点不到）。截图 `bar-folder-menu.png` 是人工证据。

## 11.6 本轮验证
- `npm run typecheck` 通过；
- `npx vitest run`：**389** 条通过（本轮 +10：`folderMenuOf` 3、`expandedIds` 2、
  `decodeBookmarkFile` 3、包装层映射 2）；
- 冒烟：`favorites` 6 条（新增"展开状态持久化 + 设置页入口"）、`bookmark-bar` 4 条
  （文件夹项改成断言原生菜单）、`bookmarks` 3、`internal-page` 5、`data-cleanup` 4、
  `quick-settings` 3、`newtab` 7、`isolation` 1——全绿；
- 截图：`bar-folder-menu.png` / `bar-folder-menu-dark.png`（原生菜单，子菜单箭头；深色主题下
  菜单**也是深的**——视图菜单跟 `nativeTheme` 走，"深色页面弹出浅色菜单"那个坑不存在）、
  `import-dialog.png`（「书签文件（HTML） (*.html;*.htm)」）、`settings-appearance.png`
  （外观 → 收藏夹栏卡里的「整理收藏 / 管理收藏夹」）。

## 11.7 横条文件夹下拉：从系统菜单改回飞窗（2026-11-27 第二次修正）

上一版用了原生 `Menu.popup`（§11.5）。验收时用户直接指出来："这个下拉实现方法不是和设置按钮
展开一个实现方式吗"——对，而且系统菜单还带来两个实测问题：

1. **会浮在别的应用之上**：它是独立顶层窗口，失去激活也不收（Windows 的 `TrackPopupMenu` 语义），
   于是"切到别的应用它还挂着"；
2. 主题、打开动画、点外部收起、键盘可达全都得另说一套，而飞窗这套（`QuickView` + `flyoutBounds`
   + 栅格边距转发 + 主题广播）已经为四页飞窗解决过同样的问题。

改法：加第五个 `QuickView` = `bookmark-folder`。

- `quick-opened` 事件新增 `target`（被点开的文件夹 id）。它**也参与 `sync()` 的"内容变了"判定**，
  否则"换一个文件夹再点"时视图是亮着的、内容还是上一个（`shownTarget` 与 `shownQuick` 同级）。
- `BookmarkFolderMenu.vue`：标题（文件夹名 + 项数）+ 分隔线 + 菜单行；子文件夹给右指箭头，
  点击**进入**（顶部出现返回箭头）而不是悬停展开；空文件夹写"这个文件夹是空的"。
- 打开一条走 `open-bookmark`（地址取自库里、导航当前标签），随后收起；同一条横条项再点 = 收起；
  点外部收起（`barFolderAnchor` 那套临时锚点回归）。
- 尺寸：宽 280（菜单行只有图标 + 标题）、高度按内容收敛（`resizeQuick`）。

**与 Chromium 的差别**：原生菜单用悬停子菜单，这里用「进入 / 返回」——一只飞窗只画一层，
悬停子菜单要么再叠一层卡片，要么让卡片越拉越长；文件夹通常只有一两层，进入再返回更稳。

一并删掉：`bookmark-folder-menu` 命令、主进程的 `showBookmarkFolderMenu()` / `bookmarkMenuTemplate()`、
`shared/bookmarks.ts` 的 `folderMenuOf()` 及其单测——它们只为系统菜单存在，留着就是死代码。

验证：typecheck 通过；`vitest run` **386** 条通过（少了 folderMenuOf 的 3 条，它们随实现一起删）；
冒烟 `bookmark-bar` 4 条（文件夹项现在断言：飞窗打开、顶边锚在按钮下沿、宽 280 + 两侧 6px 边距、
菜单里是这个文件夹的直接子项、点条目导航并收起、再点同一项收起、空文件夹给空状态、点外部收起）、
`favorites` 6、`bookmarks` 3、`quick-settings` 3、`overlay-prewarm-hidden/policy` 全绿。
截图（抓叠加层 WebContents，不涉桌面）：`folder-menu-1.png`（标题 + 行 + 子文件夹箭头）、
`folder-menu-2.png`（进入子文件夹后的返回箭头 + "这个文件夹是空的"）。
