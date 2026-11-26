import { describe, expect, it } from 'vitest'
import { BOOKMARK_BAR_ROOT } from '../../src/shared/bookmarks'
import {
  IMPORTED_FOLDER_TITLE,
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
    expect(titles(parsed.other)).toEqual(['Other bookmarks'])
    expect(parsed.other[0].children?.map((child) => child.title)).toEqual(['示例 A'])
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
