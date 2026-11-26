import { describe, expect, it } from 'vitest'
import {
  BOOKMARK_BAR_ROOT,
  BOOKMARK_OTHER_ROOT,
  bookmarkForAddress,
  checkPlacement,
  childrenOf,
  compactPositions,
  descendantIds,
  expandedIds,
  flattenTree,
  folderMenuOf,
  insertionIndex,
  isBookmarkBarMode,
  isBookmarkableAddress,
  isPermanentRoot,
  matchesQuery,
  nextPosition,
  showsBookmarkBar,
  suggestedTitle,
  titleFor,
  treeOf
} from '../../src/shared/bookmarks'
import type { BookmarkNode } from '../../src/shared/bookmarks'

/**
 * 收藏夹树（M2「书签与历史」）的纯逻辑用例。
 *
 * 树操作里最容易错的两件事——**环**（把文件夹拖进自己的子孙）与**排序位空洞**——
 * 在界面上都只表现为「东西不见了」，靠点界面很难查。这里用几百毫秒把它们穷举掉。
 * 存储层（真 SQLite）在 `tests/unit/bookmark-store.test.ts`。
 */

function node(partial: Partial<BookmarkNode> & { id: string }): BookmarkNode {
  return {
    parentId: BOOKMARK_BAR_ROOT,
    position: 0,
    kind: 'url',
    title: partial.id,
    url: 'https://example.com/',
    addedAt: 1,
    ...partial
  }
}

const roots = [
  node({ id: BOOKMARK_BAR_ROOT, parentId: null, kind: 'folder', title: '收藏夹栏', url: undefined }),
  node({ id: BOOKMARK_OTHER_ROOT, parentId: null, position: 1, kind: 'folder', title: '其他收藏夹', url: undefined })
]

describe('childrenOf / treeOf', () => {
  it('按 position 排序，而不是按插入顺序', () => {
    const nodes = [...roots, node({ id: 'b', position: 2 }), node({ id: 'a', position: 0 })]
    expect(childrenOf(nodes, BOOKMARK_BAR_ROOT).map((entry) => entry.id)).toEqual(['a', 'b'])
  })

  it('树从两个永久根开始，深层折叠成 children', () => {
    const nodes = [
      ...roots,
      node({ id: 'folder', kind: 'folder', title: '常用站点', url: undefined, position: 0 }),
      node({ id: 'child', parentId: 'folder', position: 0 })
    ]
    const tree = treeOf(nodes)
    expect(tree.map((entry) => entry.id)).toEqual([BOOKMARK_BAR_ROOT, BOOKMARK_OTHER_ROOT])
    expect(tree[0].children.map((entry) => entry.id)).toEqual(['folder'])
    expect(tree[0].children[0].children.map((entry) => entry.id)).toEqual(['child'])
  })

  it('数据里真的出现环时不会无限递归', () => {
    const nodes = [node({ id: 'a', kind: 'folder', url: undefined, parentId: 'b' }), node({ id: 'b', kind: 'folder', url: undefined, parentId: 'a' })]
    expect(() => treeOf(nodes)).not.toThrow()
  })
})

describe('descendantIds', () => {
  it('返回整棵子树的 id（不含自身）', () => {
    const nodes = [
      ...roots,
      node({ id: 'f1', kind: 'folder', url: undefined }),
      node({ id: 'f2', kind: 'folder', parentId: 'f1', url: undefined }),
      node({ id: 'leaf', parentId: 'f2' })
    ]
    expect(descendantIds(nodes, 'f1').sort()).toEqual(['f2', 'leaf'])
    expect(descendantIds(nodes, 'leaf')).toEqual([])
  })
})

describe('checkPlacement：五种拒绝', () => {
  const nodes = [
    ...roots,
    node({ id: 'folder', kind: 'folder', url: undefined }),
    node({ id: 'inner', kind: 'folder', parentId: 'folder', url: undefined }),
    node({ id: 'leaf', parentId: 'folder' })
  ]

  it('节点不存在', () => {
    expect(checkPlacement(nodes, 'ghost', BOOKMARK_BAR_ROOT)).toEqual({ ok: false, reason: 'unknown-node' })
  })

  it('永久根不能移动', () => {
    expect(checkPlacement(nodes, BOOKMARK_BAR_ROOT, BOOKMARK_OTHER_ROOT)).toEqual({ ok: false, reason: 'permanent-root' })
  })

  it('不能移到自己下面', () => {
    expect(checkPlacement(nodes, 'folder', 'folder')).toEqual({ ok: false, reason: 'into-itself' })
  })

  it('父节点不存在', () => {
    expect(checkPlacement(nodes, 'leaf', 'ghost')).toEqual({ ok: false, reason: 'unknown-parent' })
  })

  it('父节点不是文件夹（不能把东西塞进书签下面）', () => {
    expect(checkPlacement(nodes, 'leaf', 'inner')).toEqual({ ok: true })
    expect(checkPlacement(nodes, 'inner', 'leaf')).toEqual({ ok: false, reason: 'parent-not-folder' })
  })

  it('不能把文件夹移进自己的子孙（环）', () => {
    expect(checkPlacement(nodes, 'folder', 'inner')).toEqual({ ok: false, reason: 'into-descendant' })
  })

  it('正常移动允许', () => {
    expect(checkPlacement(nodes, 'leaf', BOOKMARK_OTHER_ROOT)).toEqual({ ok: true })
  })
})

describe('position 与标题', () => {
  it('nextPosition 取同级最大位置 +1，空列表从 0 开始', () => {
    expect(nextPosition([...roots], BOOKMARK_BAR_ROOT)).toBe(0)
    expect(nextPosition([...roots, node({ id: 'a', position: 0 }), node({ id: 'b', position: 3 })], BOOKMARK_BAR_ROOT)).toBe(4)
  })

  it('compactPositions 把空洞压成连续序号', () => {
    expect([...compactPositions(['a', 'b']).entries()]).toEqual([['a', 0], ['b', 1]])
  })

  it('标题为空时回落到 host，再回落到完整地址', () => {
    expect(titleFor('  ', 'https://example.com/a/b')).toBe('example.com')
    expect(titleFor('  ', 'bao://favorites/')).toBe('bao://favorites/')
    expect(titleFor('我的站点', 'https://example.com/')).toBe('我的站点')
  })

  it('isPermanentRoot 只认两个根', () => {
    expect(isPermanentRoot(BOOKMARK_BAR_ROOT)).toBe(true)
    expect(isPermanentRoot(BOOKMARK_OTHER_ROOT)).toBe(true)
    expect(isPermanentRoot('whatever')).toBe(false)
  })
})

describe('面板搜索', () => {
  it('标题、地址都参与，大小写不敏感，空查询全通过', () => {
    const entry = node({ id: 'x', title: '4399 小游戏', url: 'https://www.4399.com/' })
    expect(matchesQuery(entry, '')).toBe(true)
    expect(matchesQuery(entry, '4399')).toBe(true)
    expect(matchesQuery(entry, 'WWW.4399')).toBe(true)
    expect(matchesQuery(entry, '摩尔')).toBe(false)
  })
})

describe('当前页与工具栏星标', () => {
  /** 星标可不可点 = 主进程愿不愿意接收，两侧共用同一个判定。 */
  it('只有 http(s) 可收藏，内部页与非法输入一律不行', () => {
    expect(isBookmarkableAddress('https://www.4399.com/')).toBe(true)
    expect(isBookmarkableAddress('  http://127.0.0.1:8080/a  ')).toBe(true)
    expect(isBookmarkableAddress('bao://settings/')).toBe(false)
    expect(isBookmarkableAddress('javascript:alert(1)')).toBe(false)
    expect(isBookmarkableAddress('')).toBe(false)
    expect(isBookmarkableAddress('不是地址')).toBe(false)
  })

  it('地址完全相等才算已收藏（不做归一化：锚点/尾斜杠不同就是两条）', () => {
    const nodes = [
      ...roots,
      node({ id: 'a', url: 'https://example.com/page' }),
      node({ id: 'folder', kind: 'folder', url: undefined, title: '文件夹' })
    ]
    expect(bookmarkForAddress(nodes, 'https://example.com/page')?.id).toBe('a')
    expect(bookmarkForAddress(nodes, ' https://example.com/page ')?.id).toBe('a')
    expect(bookmarkForAddress(nodes, 'https://example.com/page#top')).toBeUndefined()
    expect(bookmarkForAddress(nodes, 'https://example.com/page/')).toBeUndefined()
    expect(bookmarkForAddress(nodes, '')).toBeUndefined()
    // 文件夹没有地址，永远不可能是"当前页"。
    expect(bookmarkForAddress(nodes, '文件夹')).toBeUndefined()
  })

  it('默认标题：页面标题优先，占位标题（等于地址）回落到 host', () => {
    expect(suggestedTitle('4399 小游戏', 'https://www.4399.com/')).toBe('4399 小游戏')
    expect(suggestedTitle('   ', 'https://www.4399.com/game')).toBe('www.4399.com')
    // Chromium 在文档还没有 <title> 时把标题当地址：直接拿来当收藏名就是一条长 URL。
    expect(suggestedTitle('https://www.4399.com/game', 'https://www.4399.com/game')).toBe('www.4399.com')
  })
})

describe('flattenTree：面板按树序平铺', () => {  it('先序展开，深度用于缩进，子节点排在父节点后面', () => {
    const nodes = [
      ...roots,
      node({ id: 'a', position: 0, url: 'https://a.com/' }),
      node({ id: 'folder', position: 1, kind: 'folder', title: '常用', url: undefined }),
      node({ id: 'inside', parentId: 'folder', position: 0, url: 'https://b.com/' }),
      node({ id: 'deep', parentId: 'folder', position: 1, kind: 'folder', title: '更深', url: undefined }),
      node({ id: 'leaf', parentId: 'deep', position: 0, url: 'https://c.com/' })
    ]
    expect(flattenTree(nodes, BOOKMARK_BAR_ROOT).map((row) => [row.node.id, row.depth])).toEqual([
      ['a', 0],
      ['folder', 0],
      ['inside', 1],
      ['deep', 1],
      ['leaf', 2]
    ])
    // 另一个根互不串台。
    expect(flattenTree(nodes, BOOKMARK_OTHER_ROOT)).toEqual([])
  })

  it('数据里出现环时不会无限递归', () => {
    const nodes = [
      node({ id: 'x', kind: 'folder', parentId: 'y', url: undefined }),
      node({ id: 'y', kind: 'folder', parentId: 'x', url: undefined })
    ]
    expect(() => flattenTree(nodes, 'x')).not.toThrow()
  })
})

describe('收藏夹横条的显示规则', () => {
  /**
   * 这条规则由**主进程**（页面视图的 y 坐标）与**外壳**（画不画那一行）共用：
   * 两处各写一遍就是"条画出来了、页面却压在下面一截"，所以它必须是纯函数 + 用例。
   */
  it('仅新标签页：只有 NTP 显示，设置页与普通网页都不显示', () => {
    expect(showsBookmarkBar('ntp', 'newtab')).toBe(true)
    expect(showsBookmarkBar('ntp', 'settings')).toBe(false)
    expect(showsBookmarkBar('ntp', undefined)).toBe(false)
  })

  it('始终显示：内部页与网页一律显示', () => {
    expect(showsBookmarkBar('always', 'newtab')).toBe(true)
    expect(showsBookmarkBar('always', 'settings')).toBe(true)
    expect(showsBookmarkBar('always', undefined)).toBe(true)
  })

  it('从不显示：连新标签页也不显示', () => {
    expect(showsBookmarkBar('never', 'newtab')).toBe(false)
    expect(showsBookmarkBar('never', undefined)).toBe(false)
  })

  it('取值域只有三档（Chromium 的两个布尔 pref 不是合法取值）', () => {
    expect(isBookmarkBarMode('ntp')).toBe(true)
    expect(isBookmarkBarMode('always')).toBe(true)
    expect(isBookmarkBarMode('never')).toBe(true)
    expect(isBookmarkBarMode('show_on_all_tabs')).toBe(false)
    expect(isBookmarkBarMode(true)).toBe(false)
    expect(isBookmarkBarMode(undefined)).toBe(false)
  })
})

describe('insertionIndex：拖拽落点 → moveBookmark 的 index', () => {
  /**
   * `moveBookmark(db, id, parentId, index)` 里的 index 是**移除被拖项之后**的最终位置
   * （存储层先把自己从同级剔除，再按 index 插入）；界面算落点时被拖项还在列表里。
   * 这两者差一位的表现是"向右拖永远偏一格"，只有像素级观察才看得出来，
   * 所以换算必须是纯函数 + 用例。
   */
  const tree = [
    ...roots,
    node({ id: 'a', position: 0 }),
    node({ id: 'b', position: 1 }),
    node({ id: 'c', position: 2 })
  ]

  it('插到某个兄弟之前：位置按"排除自己之后"的列表算', () => {
    // 同父内：c 拖到 a 前面。含 c 的列表是 [a,b,c]，排除 c 后是 [a,b] → a 的下标 0。
    expect(insertionIndex(tree, BOOKMARK_BAR_ROOT, 'a', 'c')).toBe(0)
    // a 拖到 c 前面（含 a 的列表 [a,b,c] 里 c 是 2；排除 a 后 [b,c] → c 的下标 1）。
    expect(insertionIndex(tree, BOOKMARK_BAR_ROOT, 'c', 'a')).toBe(1)
    // 跨父移动（被拖项不在目标同级里）：下标就是普通位置。
    expect(insertionIndex(tree, BOOKMARK_BAR_ROOT, 'b', 'elsewhere')).toBe(1)
  })

  it('追加到末尾：null 表示"同级最后一位"', () => {
    expect(insertionIndex(tree, BOOKMARK_BAR_ROOT, null, 'a')).toBe(2)
    expect(insertionIndex(tree, BOOKMARK_BAR_ROOT, null)).toBe(3)
    // 空文件夹里追加 = 0（新建的第一个）。
    expect(insertionIndex(tree, 'empty-folder', null, 'a')).toBe(0)
  })

  it('落点不存在（已被删/换了父节点）时退回追加，而不是算出负数下标', () => {
    expect(insertionIndex(tree, BOOKMARK_BAR_ROOT, 'gone', 'a')).toBe(2)
  })

  it('拖到自己身上是非法落点：checkPlacement 拒', () => {
    expect(checkPlacement(tree, 'a', 'a')).toEqual({ ok: false, reason: 'into-itself' })
  })
})

describe('folderMenuOf：横条文件夹下拉的内容', () => {
  /**
   * 横条上的文件夹现在弹**原生菜单**（`Menu.popup`），自动化里点不到，
   * 所以"菜单里有什么"只能在纯函数这一层钉住：直接子项、子文件夹套子菜单、空文件夹给占位、
   * 深度有上限。原生菜单那几十行只是把这个结构翻译成 `MenuItem`。
   */
  const tree = [
    ...roots,
    node({ id: 'f', kind: 'folder', title: '常用', position: 0, url: undefined }),
    node({ id: 'u1', parentId: 'f', title: '文档', url: 'https://doc.example/', position: 0 }),
    node({ id: 'sub', parentId: 'f', kind: 'folder', title: '子', position: 1, url: undefined }),
    node({ id: 'u2', parentId: 'sub', title: '更深', url: 'https://deep.example/', position: 0 }),
    node({ id: 'empty', parentId: 'f', kind: 'folder', title: '空的', position: 2, url: undefined })
  ]

  it('直接子项按 position 排，子文件夹带 children，网址带 url', () => {
    const menu = folderMenuOf(tree, 'f')
    expect(menu.map((item) => item.title)).toEqual(['文档', '子', '空的'])
    expect(menu[0].url).toBe('https://doc.example/')
    expect(menu[0].children).toBeUndefined()
    expect(menu[1].children?.map((item) => item.title)).toEqual(['更深'])
    expect(menu[2].children).toEqual([])
  })

  it('空文件夹返回空数组（调用方翻译成"（空文件夹）"禁用项）', () => {
    expect(folderMenuOf(tree, 'empty')).toEqual([])
    expect(folderMenuOf(tree, 'ghost')).toEqual([])
  })

  it('菜单嵌套有上限：真出现环时不会递归到栈溢出', () => {
    const loop = [
      node({ id: 'x', kind: 'folder', title: 'x', parentId: 'y', url: undefined }),
      node({ id: 'y', kind: 'folder', title: 'y', parentId: 'x', url: undefined })
    ]
    expect(() => folderMenuOf(loop, 'x')).not.toThrow()
  })
})

describe('expandedIds：展开状态的落库形态', () => {
  it('只保留真实存在的 id，并排好序（存库结果稳定，不会每次写都换顺序）', () => {
    const nodes = [...roots, node({ id: 'keep', kind: 'folder', title: 'k', url: undefined })]
    expect(expandedIds(new Set(['keep', 'gone', BOOKMARK_BAR_ROOT]), nodes))
      .toEqual([BOOKMARK_BAR_ROOT, 'keep'].sort())
  })

  it('全空就是空数组（不是 undefined：那是"从来没记录过"）', () => {
    expect(expandedIds(new Set(), roots)).toEqual([])
  })
})
