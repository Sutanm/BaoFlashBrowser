/**
 * 收藏夹（书签）的**数据合同**与纯逻辑：树、排序、可放置性判定。
 *
 * 术语：UI 上叫「收藏夹」（Edge 习惯），代码与库里叫 `bookmark`（Chromium 习惯）——
 * 两者是同一个东西，不要在不同层各起一个名字。
 *
 * 形态按 [C5-S3 裁决](../../docs/discussions/2026-11-21-bfb-next-architecture.md) 一步到位做
 * **文件夹树**：两个永久根（收藏夹栏 / 其他收藏夹），其余节点都挂在某个根或文件夹下面。
 * UI 首版只画根层（横条平铺）+ 面板里展开文件夹，但数据层不返工。
 *
 * 为什么这里是一堆纯函数：树操作最容易错的是**环**（把文件夹拖进自己的子孙）和**排序位**，
 * 这两种错误在界面上表现为"东西不见了"，靠点界面很难查；纯函数 + 用例几百毫秒就能穷举。
 * 本文件不 import electron 与 sqlite。
 */

export type BookmarkKind = 'folder' | 'url'

/** 永久根：横条渲染 `bar` 的子节点；面板里两个根都展示。 */
export const BOOKMARK_BAR_ROOT = 'bar'
export const BOOKMARK_OTHER_ROOT = 'other'
export const BOOKMARK_ROOTS = [BOOKMARK_BAR_ROOT, BOOKMARK_OTHER_ROOT] as const
export type BookmarkRootId = (typeof BOOKMARK_ROOTS)[number]

export interface BookmarkNode {
  id: string
  /** 永久根为 `null`；其余节点必须指向一个文件夹。 */
  parentId: string | null
  /** 同级排序位，从 0 开始连续。 */
  position: number
  kind: BookmarkKind
  title: string
  /** 只有 `kind === 'url'` 有值。 */
  url?: string
  addedAt: number
}

export interface BookmarkTreeNode extends BookmarkNode {
  children: BookmarkTreeNode[]
}

/**
 * 收藏夹横条的显示模式（工具栏下面那第三行）。
 *
 * 这是 **Edge「显示收藏夹栏」的三档**，不是 Chromium 那两个布尔：Chromium 用
 * `kShowBookmarkBar` + `kShowBookmarkBarOnNtp` 两个 pref 拼出同样的三档
 * （`chrome/browser/ui/bookmarks/bookmark_bar_controller.cc:141` 的
 * `ShouldShowBookmarkBar()`），拆成两个布尔会让「从不显示」和「仅新标签页」在
 * 设置页里没有名字。一档一个值，UI 与布局共用同一份取值域。
 *
 * 数组顺序 = 界面顺序：**默认档排第一**（「仅在新标签页上显示 / 始终显示 / 从不显示」）。
 * 默认档放第一位是因为它就是"什么都不用做"的那一档——用户打开设置页第一眼看到的应该是
 * 自己当前的状态，而不是某个需要理解的选项（2026-11-26 反馈）。
 */
export const BOOKMARK_BAR_MODES = ['ntp', 'always', 'never'] as const
export type BookmarkBarMode = (typeof BOOKMARK_BAR_MODES)[number]

export function isBookmarkBarMode(value: unknown): value is BookmarkBarMode {
  return typeof value === 'string' && (BOOKMARK_BAR_MODES as readonly string[]).includes(value)
}

/**
 * 横条此刻该不该占位置。
 *
 * **主进程与外壳共用这一个判定**：主进程按它决定页面视图的 y 坐标，外壳按它决定画不画那一行。
 * 两处各写一遍是这类「固定高度条」最典型的错位来源——条画出来了、页面却压在下面一截。
 *
 * `internal` 只收内部页种类（`'newtab'` / `'settings'` / 普通网页的 `undefined`）：
 * 用 `string` 是为了不把 `shared/browser.ts` 的类型引进来（那边 import 本文件）。
 */
export function showsBookmarkBar(mode: BookmarkBarMode, internal: string | undefined): boolean {
  if (mode === 'never') return false
  if (mode === 'always') return true
  return internal === 'newtab'
}

export function isPermanentRoot(id: string): id is BookmarkRootId {
  return (BOOKMARK_ROOTS as readonly string[]).includes(id)
}

/** 某父节点下的子节点，按 `position` 升序（同位置时按 id 兜底，保证顺序确定）。 */
export function childrenOf(nodes: readonly BookmarkNode[], parentId: string): BookmarkNode[] {
  return nodes
    .filter((node) => node.parentId === parentId)
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id))
}

/** 递归成树；`parentId === null` 时从两个永久根开始。 */
export function treeOf(
  nodes: readonly BookmarkNode[],
  parentId: string | null = null,
  depth = 0
): BookmarkTreeNode[] {
  // 深度上限只是防御：真出现环时宁可少画一层，也不要让 UI 递归到栈溢出。
  if (depth > 32) return []
  const level = parentId === null
    ? nodes
        .filter((node) => node.parentId === null && isPermanentRoot(node.id))
        .sort((left, right) => left.position - right.position)
    : childrenOf(nodes, parentId)
  return level.map((node) => ({ ...node, children: treeOf(nodes, node.id, depth + 1) }))
}

/** 子孙 id（不含自身），用于递归删除与环检测。 */
export function descendantIds(nodes: readonly BookmarkNode[], id: string): string[] {
  const result: string[] = []
  const queue = [id]
  const seen = new Set<string>([id])
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const node of nodes) {
      if (node.parentId !== current || seen.has(node.id)) continue
      seen.add(node.id)
      result.push(node.id)
      queue.push(node.id)
    }
  }
  return result
}

/** 某父节点下一个可用的排序位。 */
export function nextPosition(nodes: readonly BookmarkNode[], parentId: string): number {
  const siblings = childrenOf(nodes, parentId)
  return siblings.length === 0 ? 0 : siblings[siblings.length - 1].position + 1
}

export type PlacementRefusal =
  | 'unknown-node'
  | 'permanent-root'
  | 'unknown-parent'
  | 'parent-not-folder'
  | 'into-itself'
  | 'into-descendant'

/**
 * 能不能把 `id` 放到 `parentId` 下面。
 *
 * 拒绝的五种情况都在 UI 上真的会发生（拖拽、菜单「移动到」、导入 Chrome 书签），
 * 而且都必须**在执行前**挡住：拖出环以后再修数据，成本比拒绝高两个数量级。
 */
export function checkPlacement(
  nodes: readonly BookmarkNode[],
  id: string,
  parentId: string
): { ok: true } | { ok: false; reason: PlacementRefusal } {
  const node = nodes.find((entry) => entry.id === id)
  if (!node) return { ok: false, reason: 'unknown-node' }
  if (isPermanentRoot(id)) return { ok: false, reason: 'permanent-root' }
  if (id === parentId) return { ok: false, reason: 'into-itself' }
  const parent = nodes.find((entry) => entry.id === parentId)
  if (!parent) return { ok: false, reason: 'unknown-parent' }
  if (parent.kind !== 'folder') return { ok: false, reason: 'parent-not-folder' }
  if (descendantIds(nodes, id).includes(parentId)) return { ok: false, reason: 'into-descendant' }
  return { ok: true }
}

/**
 * 标题回落：Chromium 里书签标题为空时显示地址。
 *
 * 我们按 host 显示（`example.com`），因为横条上像素有限、而且用户认的是站点而不是长 URL；
 * host 取不出来（如 `bao://favorites/`）时退回完整地址。
 */
export function titleFor(rawTitle: string, url: string): string {
  const title = rawTitle.trim()
  if (title) return title
  try {
    const parsed = new URL(url)
    // 只对 http(s) 取 host：内部页（`bao://favorites/`）的 host 是 `favorites`，
    // 显示成那样反而认不出来，不如显示完整地址。
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return url
    return parsed.host || url
  } catch {
    return url
  }
}

/**
 * 能不能收藏这个地址。
 *
 * 只认 http(s)：内部页（`bao://settings`、`bao://newtab`）不进收藏夹——它们不是"站点"，
 * 收藏下来只有一条永远等于当前页的条目；工具栏星标在内部页也是禁用态，两侧判定必须一致。
 * 判定放在这里而不是各调用点：主进程要用它拒绝非法地址，界面要用它决定星标可不可点。
 */
export function isBookmarkableAddress(address: string): boolean {
  try {
    const parsed = new URL(address.trim())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 当前地址对应的收藏条目（没有就 `undefined`）。
 *
 * 按**完整地址**比对，和 Chromium 一致：不做去尾斜杠/去 fragment 之类的归一化——
 * 归一化会让「同一篇文章的两个锚点」互相顶掉，用户看到的是星标莫名亮起。
 */
export function bookmarkForAddress(nodes: readonly BookmarkNode[], address: string): BookmarkNode | undefined {
  const url = address.trim()
  if (!url) return undefined
  return nodes.find((node) => node.kind === 'url' && node.url === url)
}

/** 收藏时给输入框的默认标题：标题为空、或标题就是地址本身（Chromium 的占位标题）时回落到 host。 */
export function suggestedTitle(pageTitle: string, url: string): string {
  const title = pageTitle.trim()
  if (title && title !== url.trim()) return title
  return titleFor('', url)
}

/**
 * 把某个根（或文件夹）下的子树**平铺**成「行 + 深度」，给面板按树序渲染。
 *
 * 为什么不用递归组件：面板里的树最多三层、行样式一致，递归组件换来的只是多一个文件；
 * 深度交给一个数字，缩进就是一行 CSS。真要做拖拽/折叠再回头拆。
 */
export function flattenTree(
  nodes: readonly BookmarkNode[],
  parentId: string,
  depth = 0
): Array<{ node: BookmarkNode; depth: number }> {
  const rows: Array<{ node: BookmarkNode; depth: number }> = []
  // 与 `treeOf` 同一个深度上限：数据里真出现环时宁可少画一层，也不要栈溢出。
  if (depth > 32) return rows
  for (const node of childrenOf(nodes, parentId)) {
    rows.push({ node, depth })
    if (node.kind === 'folder') rows.push(...flattenTree(nodes, node.id, depth + 1))
  }
  return rows
}

/** 一个可选的收藏位置（气泡/编辑器的"文件夹"下拉里的一行）。 */
export interface FolderOption {
  id: string
  title: string
  /** 缩进层级：两个永久根是 0，它们下面的文件夹依次 +1。 */
  depth: number
}

/**
 * 所有**文件夹**的平铺列表（两个永久根在前，其余按树序缩进）。
 *
 * 收藏位置只能是文件夹：网址节点是 `parent-not-folder`，存储层会拒。界面拿这份列表做
 * 下拉/树，和 `checkPlacement` 的规则天然一致（同一张节点表算出来的）。
 */
export function folderOptions(nodes: readonly BookmarkNode[]): FolderOption[] {
  const options: FolderOption[] = []
  const walk = (parentId: string, depth: number): void => {
    if (depth > 32) return
    for (const node of childrenOf(nodes, parentId)) {
      if (node.kind !== 'folder') continue
      options.push({ id: node.id, title: node.title || titleFor('', parentId), depth })
      walk(node.id, depth + 1)
    }
  }
  for (const root of BOOKMARK_ROOTS) {
    const node = nodes.find((entry) => entry.id === root)
    options.push({ id: root, title: node?.title || (root === BOOKMARK_BAR_ROOT ? '收藏夹栏' : '其他收藏夹'), depth: 0 })
    walk(root, 1)
  }
  return options
}

/** 面板搜索：标题、地址、文件夹名都参与，大小写不敏感。 */
export function matchesQuery(node: BookmarkNode, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return node.title.toLowerCase().includes(needle) || (node.url ?? '').toLowerCase().includes(needle)
}

/**
 * 展开状态（`Set` → 存库用的数组）。
 *
 * 两个消费者（收藏夹飞窗、`bao://favorites` 管理页）共用一套持久化：用户在一处展开的文件夹，
 * 另一处也是展开的——"上次点开了哪个文件夹"是他对收藏夹的心智模型，不该按界面各存一份。
 *
 * 写入前**按现有节点过滤**：文件夹被删掉以后，残留的 id 留在库里只会越攒越多，
 * 而且以后万一有新节点复用了同一个 id（导入时不会，但规则上不该赌）就会莫名其妙地展开。
 */
export function expandedIds(expanded: ReadonlySet<string>, nodes: readonly BookmarkNode[]): string[] {
  const alive = new Set(nodes.map((node) => node.id))
  return [...expanded].filter((id) => alive.has(id)).sort()
}

/**
 * 把一串 id 重排成连续的 `position`。
 *
 * 返回「id → 新位置」，交给存储层按序写回。单独一个纯函数是因为**排序位不连续**是最常见的
 * 数据腐坏形态：一次失败的拖拽或删除就能留下空洞，之后所有插入/移动都会算错。
 */
export function compactPositions(ids: readonly string[]): Map<string, number> {
  return new Map(ids.map((id, index) => [id, index]))
}

/**
 * 拖拽落点 → `moveBookmark()` 需要的插入位。
 *
 * 为什么要一个纯函数：`moveBookmark(db, id, parentId, index)` 的 `index` 是
 * **移除被拖项之后**的最终索引（存储层先把自己从同级里剔除，再按 index 插入）。
 * 而界面上算落点用的是"当前含被拖项"的列表——这两者差一位，向右拖永远偏一格。
 * 这条换算在两个地方要一致（同父内排序、跨文件夹移动），所以只写一次，用用例钉住。
 *
 * @param beforeId 落点插入到哪个兄弟**之前**；`null` = 追加到末尾。
 * @param draggedId 被拖的节点 id（同父内移动时它还在同级列表里，必须先排除）。
 */
export function insertionIndex(
  nodes: readonly BookmarkNode[],
  parentId: string,
  beforeId: string | null,
  draggedId?: string
): number {
  const siblings = childrenOf(nodes, parentId)
    .map((node) => node.id)
    .filter((id) => id !== draggedId)
  if (beforeId === null) return siblings.length
  const at = siblings.indexOf(beforeId)
  return at < 0 ? siblings.length : at
}
