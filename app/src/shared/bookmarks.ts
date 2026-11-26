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
 * 把一串 id 重排成连续的 `position`。
 *
 * 返回「id → 新位置」，交给存储层按序写回。单独一个纯函数是因为**排序位不连续**是最常见的
 * 数据腐坏形态：一次失败的拖拽或删除就能留下空洞，之后所有插入/移动都会算错。
 */
export function compactPositions(ids: readonly string[]): Map<string, number> {
  return new Map(ids.map((id, index) => [id, index]))
}
