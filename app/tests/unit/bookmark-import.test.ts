import { describe, expect, it } from 'vitest'
import { BOOKMARK_BAR_ROOT } from '../../src/shared/bookmarks'
import {
  IMPORTED_FOLDER_TITLE,
  decodeBookmarkFile,
  decodeEntities,
  isImportableUrl,
  parseBookmarksHtml,
  uniqueFolderTitle
} from '../../src/shared/bookmark-import'
import type { ImportedNode } from '../../src/shared/bookmark-import'
import type { BookmarkNode } from '../../src/shared/bookmarks'

/**
 * 导出书签（Netscape Bookmark File）的解析用例。
 *
 * 这份格式**不是合法 HTML**（`<DT>` 不闭合、`<DL><p>` 成对出现），所以解析只能按行扫——
 * Chromium 也是这么做的（`components/user_data_importer/content/content_bookmark_parser_utils.cc:391-562`）。
 * 用例盯住的是导入里最刺眼的几种结果：书签栏多套一层、实体没反转义、实时书签被当成收藏、
 * 空文件夹丢了、坏行把整棵树带歪。
 */

/** Chrome 的导出（真实格式，含 `<DL><p>` 与 `PERSONAL_TOOLBAR_FOLDER`）。 */
const CHROME_EXPORT = [
  '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
  '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
  '<TITLE>Bookmarks</TITLE>',
  '<H1>Bookmarks</H1>',
  '<DL><p>',
  '    <DT><H3 ADD_DATE="1700000000" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>',
  '    <DL><p>',
  '        <DT><H3>前端</H3>',
  '        <DL><p>',
  '            <DT><A HREF="https://developer.mozilla.org/" ADD_DATE="1">MDN &amp; 文档</A>',
  '            <DT><A HREF="https://vuejs.org/">Vue</A>',
  '        </DL><p>',
  '        <DT><A HREF="https://github.com/">GitHub</A>',
  '    </DL><p>',
  '    <DT><H3>Other bookmarks</H3>',
  '    <DL><p>',
  '        <DT><A HREF="https://example.com/a">示例 A</A>',
  '    </DL><p>',
  '</DL><p>',
  ''
].join('\n')

function titles(nodes: readonly ImportedNode[]): string[] {
  return nodes.map((node) => node.title)
}

function node(partial: Partial<BookmarkNode> & { id: string }): BookmarkNode {
  return {
    parentId: BOOKMARK_BAR_ROOT,
    position: 0,
    kind: 'folder',
    title: partial.id,
    addedAt: 1,
    ...partial
  }
}

describe('parseBookmarksHtml：树形与书签栏', () => {
  it('书签栏的子结构原样保留，但不把「Bookmarks bar」那一层带进来', () => {
    const parsed = parseBookmarksHtml(CHROME_EXPORT)
    expect(parsed.toolbarFolder).toBe(true)
    // 顶层是 bar 的内容，不是 bar 文件夹本身——多套一层是导入最常见的手误。
    expect(titles(parsed.bar)).toEqual(['前端', 'GitHub'])
    expect(parsed.bar[0].children?.map((child) => child.title)).toEqual(['MDN & 文档', 'Vue'])
    // 其余顶层文件夹进 other（导入时会被装进「已导入」容器）。
    // 「Other bookmarks」这层包装按 2026-11-27 的反馈被拆掉，子项直接成为 other 的顶层项。
    expect(titles(parsed.other)).toEqual(['示例 A'])
  })

  it('标题里的 HTML 实体要反转义，否则导出再导入名字就花了', () => {
    const parsed = parseBookmarksHtml(CHROME_EXPORT)
    expect(parsed.bar[0].children?.[0].title).toBe('MDN & 文档')
  })

  it('统计与跳过：非 http(s) 的地址不进库，实时书签整条跳过', () => {
    const html = [
      '<DL><p>',
      '<DT><A HREF="https://ok.example/">正常</A>',
      '<DT><A HREF="javascript:alert(1)">脚本</A>',
      '<DT><A HREF="place:sort=8">标签页</A>',
      '<DT><A HREF="feed://example.com/rss" FEEDURL="feed://example.com/rss">实时书签</A>',
      '<DT><A HREF="https://ok.example/2">正常 2</A>',
      '</DL><p>'
    ].join('\n')
    const parsed = parseBookmarksHtml(html)
    expect(parsed.counts).toEqual({ folders: 0, urls: 2, skipped: 3 })
    // 没有 toolbar 标记时，全部算 other（导入时进「已导入」）。
    expect(titles(parsed.other)).toEqual(['正常', '正常 2'])
    expect(parsed.bar).toEqual([])
    expect(parsed.toolbarFolder).toBe(false)
  })

  it('空文件夹保留（导出里是 <H3> + 空 <DL>）', () => {
    const html = [
      '<DL><p>',
      '<DT><H3 PERSONAL_TOOLBAR_FOLDER="true">收藏夹栏</H3>',
      '<DL><p>',
      '<DT><H3>空的</H3>',
      '<DL><p>',
      '</DL><p>',
      '</DL><p>',
      '</DL><p>'
    ].join('\n')
    const parsed = parseBookmarksHtml(html)
    expect(titles(parsed.bar)).toEqual(['空的'])
    expect(parsed.bar[0].children).toEqual([])
    expect(parsed.counts.folders).toBe(1)
  })

  it('属性缺失时按顶层文件夹名兜底认书签栏（只有顶层生效）', () => {
    const html = [
      '<DL><p>',
      '<DT><H3>收藏夹栏</H3>',
      '<DL><p>',
      '<DT><A HREF="https://a.example/">A</A>',
      '</DL><p>',
      '<DT><H3>别的</H3>',
      '<DL><p>',
      '<DT><A HREF="https://b.example/">B</A>',
      '</DL><p>',
      '</DL><p>'
    ].join('\n')
    const parsed = parseBookmarksHtml(html)
    expect(parsed.toolbarFolder).toBe(true)
    expect(titles(parsed.bar)).toEqual(['A'])
    expect(titles(parsed.other)).toEqual(['别的'])
  })

  it('坏文件（多出来的 </DL>、<HR> 分隔线、<DD> 描述）不会把树带歪', () => {
    const html = [
      '</DL><p>',
      '<HR>',
      '<DL><p>',
      '<DT><H3>组</H3>',
      '<DD>一段描述，不该变成条目',
      '<DL><p>',
      '<DT><A HREF="https://a.example/">A</A>',
      '</DL><p>',
      '</DL><p>',
      '</DL><p>'
    ].join('\n')
    const parsed = parseBookmarksHtml(html)
    expect(titles(parsed.other)).toEqual(['组'])
    expect(parsed.other[0].children?.map((child) => child.title)).toEqual(['A'])
  })

  it('空文件/不是书签文件：一条都不产出（界面据此报「这个文件里没有收藏」）', () => {
    expect(parseBookmarksHtml('').counts).toEqual({ folders: 0, urls: 0, skipped: 0 })
    expect(parseBookmarksHtml('<html><body>hello</body></html>').counts.urls).toBe(0)
  })
})

describe('导入的边角规则', () => {
  it('isImportableUrl 只收 http(s)（与 isBookmarkableAddress 同一条产品规则）', () => {
    expect(isImportableUrl('https://a.example/')).toBe(true)
    expect(isImportableUrl('http://a.example/')).toBe(true)
    expect(isImportableUrl('javascript:alert(1)')).toBe(false)
    expect(isImportableUrl('place:sort=8')).toBe(false)
    expect(isImportableUrl('chrome://settings/')).toBe(false)
    expect(isImportableUrl('')).toBe(false)
  })

  it('decodeEntities 认得命名实体与数字实体', () => {
    expect(decodeEntities('A &amp; B')).toBe('A & B')
    expect(decodeEntities('&lt;tag&gt;')).toBe('<tag>')
    expect(decodeEntities('it&#39;s')).toBe("it's")
    expect(decodeEntities('斜杠&#x2F;')).toBe('斜杠/')
    // 不认识的保持原样，不要吃掉用户的名字。
    expect(decodeEntities('&unknown;')).toBe('&unknown;')
  })

  it('uniqueFolderTitle 冲突时追加序号（Chromium 的「已导入 (1)」）', () => {
    const nodes = [
      node({ id: 'bar', parentId: null }),
      node({ id: 'f1', title: IMPORTED_FOLDER_TITLE }),
      node({ id: 'f2', title: `${IMPORTED_FOLDER_TITLE} (1)` })
    ]
    expect(uniqueFolderTitle(nodes, 'bar', IMPORTED_FOLDER_TITLE)).toBe(`${IMPORTED_FOLDER_TITLE} (2)`)
    expect(uniqueFolderTitle(nodes, 'bar', '别的名字')).toBe('别的名字')
  })
})

describe('导入：其余根包装层的映射（2026-11-27 反馈）', () => {
  /**
   * Chrome / Edge 的导出把「其他收藏夹」也写成一个顶层文件夹。照 Chromium 逐字实现会得到
   * `已导入 / Other bookmarks / …` 这层噪音；这里直接把它铺到 `other`，并要求
   * **只认顶层**——深层的同名文件夹是用户自己建的，不能吞掉。
   */
  it('顶层「Other bookmarks」的子项就地铺到 other，包装层不进树', () => {
    const html = [
      '<DL><p>',
      '<DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>',
      '<DL><p>',
      '<DT><A HREF="https://bar.example/">栏内</A>',
      '</DL><p>',
      '<DT><H3>Other bookmarks</H3>',
      '<DL><p>',
      '<DT><A HREF="https://other.example/">别的 1</A>',
      '<DT><H3>子夹</H3>',
      '<DL><p>',
      '<DT><A HREF="https://other.example/2">别的 2</A>',
      '</DL><p>',
      '</DL><p>',
      '</DL><p>'
    ].join('\n')
    const parsed = parseBookmarksHtml(html)
    expect(parsed.other.map((node) => node.title)).toEqual(['别的 1', '子夹'])
    expect(parsed.other[1].children?.map((node) => node.title)).toEqual(['别的 2'])
    // 包装层不算进统计。
    expect(parsed.counts.folders).toBe(1)
    expect(parsed.counts.urls).toBe(3)
  })

  it('中文「其他收藏夹」同样映射；深层同名的保留', () => {
    const html = [
      '<DL><p>',
      '<DT><H3 PERSONAL_TOOLBAR_FOLDER="true">收藏夹栏</H3>',
      '<DL><p>',
      '<DT><H3>我自己建的其他收藏夹</H3>',
      '<DL><p>',
      '<DT><A HREF="https://x.example/">X</A>',
      '</DL><p>',
      '</DL><p>',
      '<DT><H3>其他收藏夹</H3>',
      '<DL><p>',
      '<DT><A HREF="https://y.example/">Y</A>',
      '</DL><p>',
      '</DL><p>'
    ].join('\n')
    const parsed = parseBookmarksHtml(html)
    // 顶层那个被拆掉，深层那个（名字不同）留在书签栏里。
    expect(parsed.other.map((node) => node.title)).toEqual(['Y'])
    expect(parsed.bar.map((node) => node.title)).toEqual(['我自己建的其他收藏夹'])
  })
})

describe('decodeBookmarkFile：文件字节 → 文本', () => {
  const utf8 = new TextEncoder().encode('<DL><p>')

  it('普通 UTF-8 原样解出', () => {
    expect(decodeBookmarkFile(utf8)).toBe('<DL><p>')
  })

  it('带 BOM 的 UTF-8 去掉 BOM（否则首行会多个不可见字符，第一行就解析不出来）', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8])
    expect(decodeBookmarkFile(withBom)).toBe('<DL><p>')
  })

  it('UTF-16LE / UTF-16BE（Windows 上真的有这种导出）', () => {
    const text = '收藏夹'
    const le = new Uint8Array(2 + text.length * 2)
    le[0] = 0xff; le[1] = 0xfe
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i)
      le[2 + i * 2] = code & 0xff
      le[3 + i * 2] = code >> 8
    }
    expect(decodeBookmarkFile(le)).toBe(text)
  })
})
