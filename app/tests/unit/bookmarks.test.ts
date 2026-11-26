import { describe, expect, it } from 'vitest'
import {
  BOOKMARK_BAR_ROOT,
  BOOKMARK_OTHER_ROOT,
  checkPlacement,
  childrenOf,
  compactPositions,
  descendantIds,
  isPermanentRoot,
  matchesQuery,
  nextPosition,
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
