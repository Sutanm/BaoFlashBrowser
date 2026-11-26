import type { BookmarkNode } from './bookmarks'

/**
 * 从**浏览器导出的书签 HTML** 里解析出树（纯逻辑，不碰 fs/electron/sqlite）。
 *
 * 为什么要有这么一个文件：导入是"一次性、不可重来"的动作——用户点一下，几百条收藏就该
 * 原样搬进来，包括书签栏里的文件夹层级。这套 HTML 是个 Netscape Bookmark File，**不是
 * 合法 HTML**（`<DT>` 不闭合、`<DL><p>` 一对乱标签），所以不能丢给 HTML 解析器当文档读，
 * 只能按行扫——Chromium 自己也是这么做的：
 * `components/user_data_importer/content/content_bookmark_parser_utils.cc:391-562`。
 *
 * 与 Chromium 对齐的几条（踩过的坑都在这里）：
 * - `<H3 PERSONAL_TOOLBAR_FOLDER="true">` 标出**书签栏**，它的**子结构原样保留**，但它自己
 *   那一层不进树（否则会多出一层"Bookmarks bar/收藏夹栏"的套娃），见
 *   `chrome/browser/importer/profile_writer.cc:189-194`；
 * - `FEEDURL`（Firefox 的实时书签）整条跳过——那是一个会变的订阅，不是一条收藏；
 * - 只收 http(s)：Chromium 也过滤不支持的 scheme（`bookmarks_file_importer.cc:31-77`），
 *   而我们的数据模型本来也只收藏 http(s)（`shared/bookmarks.ts` 的 `isBookmarkableAddress`）；
 * - 标题要反转义 HTML 实体（`&amp;` 之类），否则导出再导入一次名字就花了。
 *
 * **与 Chromium 的刻意差别**：属性缺失时按标题兜底认书签栏（`FALLBACK_TOOLBAR_TITLES`）。
 * Chromium 只认属性；但手工整理的导出文件不一定带它，而"书签栏被当成普通文件夹塞进其他收藏夹"
 * 是导入里最刺眼的一种结果，值得留一条兜底。这条兜底只在**顶层文件夹**上生效。
 */

/** 解析出来的节点（比 `BookmarkNode` 少 id/position/时间戳：那些由存储层生成）。 */
export interface ImportedNode {
  kind: 'folder' | 'url'
  title: string
  url?: string
  /** 只有 `kind === 'folder'` 有。 */
  children?: ImportedNode[]
}

export interface ParsedBookmarks {
  /** 书签栏里的内容（顶层就是它下面的文件夹/网址，不含书签栏那一层）。 */
  bar: ImportedNode[]
  /** 其余内容（导入时通常会被装进一个「已导入」文件夹）。 */
  other: ImportedNode[]
  counts: {
    folders: number
    urls: number
    /** 被跳过的条目（非 http(s)、实时书签、解析不出的行）。 */
    skipped: number
  }
  /** 文件里是否认出了书签栏（属性或标题兜底）。诊断与测试用。 */
  toolbarFolder: boolean
}

/** 属性缺失时用来认书签栏的顶层文件夹名（Chrome / Edge / Firefox 的中英文导出都能命中）。 */
const FALLBACK_TOOLBAR_TITLES = [
  '收藏夹栏', '书签栏', '收藏夹工具栏',
  'bookmarks bar', 'bookmarks toolbar', 'favorites bar', 'favourites bar', 'favorites toolbar'
]

/**
 * 顶层文件夹里**代表"其他收藏夹"根**的那几个名字。
 *
 * 这是**我们自己的**补充（Chromium 没有）：Chrome / Edge 的导出让两个根各是一个顶层文件夹，
 * 照 `ProfileWriter::AddBookmarks()` 逐字实现的话，导入后会多出一层
 * `已导入 / Other bookmarks / …`。用户实测反馈这一层是噪音（2026-11-27），
 * 而目标根就在库里，直接把它的子项铺到 `other` 更符合"导入的是我的收藏，不是我的目录结构"。
 * 只认**顶层**：深层的同名文件夹是用户自己建的，不能吞掉。
 */
const FALLBACK_OTHER_TITLES = [
  '其他收藏夹', '其他书签', '其他书签夹', '书签工具栏',
  'other bookmarks', 'other favorites', 'other favourites', 'bookmarks toolbar'
]

/** 文件字节 → 文本：认 BOM（UTF-16 的导出在 Windows 上真的存在），否则按 UTF-8。 */
export function decodeBookmarkFile(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3))
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  }
  return new TextDecoder('utf-8').decode(bytes)
}

/** HTML 实体反转义：书签标题里 `&amp;` / `&#39;` / `&#x2F;` 都真实出现过。 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    const named: Record<string, string> = {
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'"
    }
    return named[entity.toLowerCase()] ?? whole
  })
}

/** 取标签里的某个属性（大小写不敏感，值必须带引号——导出文件里都是带引号的）。 */
function attribute(attributes: string, name: string): string | undefined {
  const pattern = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i')
  const match = pattern.exec(attributes)
  if (!match) return undefined
  return match[2] ?? match[3] ?? ''
}

/** 能不能作为一条收藏导入：只要 http(s)（与 `isBookmarkableAddress` 同一条规则）。 */
export function isImportableUrl(url: string): boolean {
  try {
    const parsed = new URL(url.trim())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** 行首的 `<DT>` / 多个 `<HR>` / 空白：Chromium 就是这样剥的（`parser_utils.cc:57-66`、`:412-420`）。 */
function cleanLine(raw: string): string {
  let line = raw.trim()
  for (;;) {
    const before = line
    line = line.replace(/^<hr\b[^>]*>/i, '').replace(/^<dt\b[^>]*>/i, '').trim()
    if (line === before) return line
  }
}

/** `<H3 ...>标题</H3>` → 文件夹；返回 `undefined` 表示这行不是文件夹。 */
function folderFromLine(line: string): { title: string; toolbar: boolean } | undefined {
  if (!/^<h3\b/i.test(line)) return undefined
  const close = line.search(/<\/h3>/i)
  if (close < 0) return undefined
  const tagEnd = line.lastIndexOf('>', close) + 1
  if (tagEnd <= 0) return undefined
  const attributes = line.slice(4, tagEnd - 1)
  const title = decodeEntities(line.slice(tagEnd, close)).replace(/\s+/g, ' ').trim()
  const toolbar = (attribute(attributes, 'PERSONAL_TOOLBAR_FOLDER') ?? '').toLowerCase() === 'true'
  return { title, toolbar }
}

/** `<A ...>标题</A>` → 网址条目；返回 `undefined` 表示这行不是条目（或被跳过）。 */
export function urlFromLine(line: string): { title: string; url: string; skipped: boolean } | undefined {
  if (!/^<a\b/i.test(line)) return undefined
  const close = line.search(/<\/a>/i)
  const tagEnd = line.indexOf('>')
  if (tagEnd < 0) return undefined
  const attributes = line.slice(3, tagEnd)
  // 实时书签（RSS）不是收藏：内容会变，导入进来只会是一条永远打不开的条目。
  if (attribute(attributes, 'FEEDURL') !== undefined) return { title: '', url: '', skipped: true }
  const href = attribute(attributes, 'HREF') ?? attribute(attributes, 'href')
  const end = close < 0 ? line.length : close
  const title = decodeEntities(line.slice(tagEnd + 1, end)).replace(/\s+/g, ' ').trim()
  if (!href) return { title, url: '', skipped: true }
  const url = decodeEntities(href).trim()
  if (!isImportableUrl(url)) return { title, url, skipped: true }
  return { title, url, skipped: false }
}

function walk(nodes: readonly ImportedNode[], visit: (node: ImportedNode) => void): void {
  for (const node of nodes) {
    visit(node)
    if (node.kind === 'folder' && node.children) walk(node.children, visit)
  }
}

/**
 * 解析导出文件。
 *
 * 逐行状态机：`levels` 是当前打开的层级，每层记住自己的 children 数组；`pending` 是刚读到、
 * 还没遇到它 `<DL>` 的文件夹。不成对的 `<DL><p>` 在导出文件里很常见，所以虚拟层（`real: false`）
 * 只指向**同一个** children 数组——来回压弹都不会改动树，也不会把父层弹掉。
 */
export function parseBookmarksHtml(html: string): ParsedBookmarks {
  const roots: ImportedNode[] = []
  interface Level {
    children: ImportedNode[]
    /** 由文件夹压进来的真实层；false = 容错用的虚拟层（指向父层同一个数组）。 */
    real: boolean
  }
  const levels: Level[] = [{ children: roots, real: true }]
  let pending: { node: ImportedNode; toolbar: boolean } | undefined
  let barContainer: ImportedNode[] | undefined
  let skipped = 0

  const current = (): ImportedNode[] => levels[levels.length - 1].children

  for (const raw of html.split(/\r?\n/)) {
    const line = cleanLine(raw)
    if (!line) continue

    const folder = folderFromLine(line)
    if (folder) {
      pending = {
        node: { kind: 'folder', title: folder.title, children: [] },
        toolbar: folder.toolbar
      }
      continue
    }

    const entry = urlFromLine(line)
    if (entry) {
      if (entry.skipped) {
        skipped += 1
        continue
      }
      current().push({ kind: 'url', title: entry.title, url: entry.url })
      continue
    }

    if (/^<dl\b/i.test(line)) {
      if (pending) {
        const node = pending.node
        const children = node.children as ImportedNode[]
        if (pending.toolbar) {
          // 书签栏**自己那一层不进树**（Chromium 用 `in_toolbar` 标记同样跳过
          // `profile_writer.cc:189-194`）：它的内容单独归入 `bar`，否则导入后会多一层
          // 「Bookmarks bar / 收藏夹栏」的套娃。
          barContainer = children
        } else {
          current().push(node)
        }
        levels.push({ children, real: true })
        pending = undefined
      } else {
        levels.push({ children: current(), real: false })
      }
      continue
    }

    if (/^<\/dl>/i.test(line)) {
      // 根层永远不弹：多出来的 </DL> 只是坏文件，不该把已经读到的内容挪走。
      if (levels.length > 1) levels.pop()
      continue
    }
    // 其余（<DD> 描述、<TITLE>、注释…）一律忽略。
  }

  // 没等到 <DL> 的文件夹也要收（文件被截断，或空文件夹只有 <H3>）。
  if (pending) {
    if (pending.toolbar) {
      barContainer = barContainer ?? (pending.node.children as ImportedNode[])
    } else {
      current().push(pending.node)
    }
  }

  // 兜底：属性缺失时按标题认书签栏（只在顶层文件夹上认）。
  let bar = barContainer
  if (!bar) {
    const index = roots.findIndex((node) =>
      node.kind === 'folder' && FALLBACK_TOOLBAR_TITLES.includes(node.title.trim().toLowerCase()))
    if (index >= 0) {
      bar = roots[index].children ?? []
      roots.splice(index, 1)
    }
  }

  /**
   * 「其他收藏夹」的包装层同样拆掉（见 `FALLBACK_OTHER_TITLES`）：它的子项就地铺到 `other`
   * 的同一位置上，顺序不变。包装层自己不算进统计。
   */
  const otherIndex = roots.findIndex((node) =>
    node.kind === 'folder' && FALLBACK_OTHER_TITLES.includes(node.title.trim().toLowerCase()))
  if (otherIndex >= 0) {
    const wrapper = roots[otherIndex]
    roots.splice(otherIndex, 1, ...(wrapper.children ?? []))
  }

  const counts = { folders: 0, urls: 0, skipped }
  const tally = (nodes: readonly ImportedNode[]): void => {
    walk(nodes, (node) => { if (node.kind === 'folder') counts.folders += 1; else counts.urls += 1 })
  }
  tally(bar ?? [])
  tally(roots)

  return { bar: bar ?? [], other: roots, counts, toolbarFolder: Boolean(bar) }
}

/**
 * 导入时新建的容器名（Chromium 的 `IDS_BOOKMARK_GROUP` =
 * `chrome/app/bookmarks_strings.grdp:21-23`，中文资源里是「已导入」）。
 *
 * 为什么需要它：用户收藏夹里**已经有东西**时，直接往收藏夹栏末尾铺几百条会把原有的排布
 * 冲掉；Chromium 的做法是建一个容器（`profile_writer.cc:172-182`），我们照做。
 */
export const IMPORTED_FOLDER_TITLE = '已导入'

/** 同级里取一个不重名的文件夹名：`已导入` → `已导入 (1)`（`profile_writer.cc:49-71`）。 */
export function uniqueFolderTitle(nodes: readonly BookmarkNode[], parentId: string, title: string): string {
  const taken = new Set(
    nodes
      .filter((node) => node.parentId === parentId && node.kind === 'folder')
      .map((node) => node.title.trim())
  )
  if (!taken.has(title)) return title
  for (let index = 1; index <= taken.size; index += 1) {
    const candidate = `${title} (${index})`
    if (!taken.has(candidate)) return candidate
  }
  return `${title} (${taken.size + 1})`
}
