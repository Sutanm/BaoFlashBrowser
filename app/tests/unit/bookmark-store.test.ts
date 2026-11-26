import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BOOKMARK_BAR_ROOT,
  BOOKMARK_OTHER_ROOT,
  childrenOf
} from '../../src/shared/bookmarks'
import {
  SCHEMA_VERSION,
  addBookmark,
  clearBookmarks,
  deleteBookmark,
  moveBookmark,
  openStore,
  readBookmarks,
  readSettings,
  renameBookmark
} from '../../src/main/db/store'
import type { OpenedStore } from '../../src/main/db/store'

/**
 * 收藏夹存储层（schema v3）——真 SQLite、真迁移，但不启动 Electron。
 *
 * 这一层要钉住的是**用户数据安全**：迁移不能吃掉旧数据、排序位不能留空洞、
 * 永久根不能被删、环不能被写进库里。这些错误一旦发生，界面上看不出来，只能靠这里。
 */

const opened: Array<{ dir: string; store: OpenedStore }> = []

async function openTemp(): Promise<OpenedStore> {
  const dir = mkdtempSync(join(tmpdir(), 'bao-bookmarks-'))
  const store = await openStore({ userData: dir })
  opened.push({ dir, store })
  return store
}

afterEach(() => {
  while (opened.length > 0) {
    const entry = opened.pop() as { dir: string; store: OpenedStore }
    entry.store.db.close()
    rmSync(entry.dir, { recursive: true, force: true })
  }
})

function barIds(store: OpenedStore): string[] {
  return childrenOf(readBookmarks(store.db), BOOKMARK_BAR_ROOT).map((node) => node.id)
}

function otherIds(store: OpenedStore): string[] {
  return childrenOf(readBookmarks(store.db), BOOKMARK_OTHER_ROOT).map((node) => node.id)
}

describe('schema v3：播种与版本', () => {
  it('新库升到 v3，并种下两个永久根', async () => {
    const store = await openTemp()
    expect(SCHEMA_VERSION).toBe(3)
    const roots = readBookmarks(store.db).filter((node) => node.parentId === null)
    expect(roots.map((node) => node.id)).toEqual([BOOKMARK_BAR_ROOT, BOOKMARK_OTHER_ROOT])
    expect(roots.map((node) => node.title)).toEqual(['收藏夹栏', '其他收藏夹'])
    expect(roots.every((node) => node.kind === 'folder')).toBe(true)
  })

  it('重复打开不会重复播种', async () => {
    const first = await openTemp()
    const dir = opened[opened.length - 1].dir
    first.db.close()
    opened.pop()
    const second = await openStore({ userData: dir })
    opened.push({ dir, store: second })
    expect(readBookmarks(second.db).filter((node) => node.parentId === null)).toHaveLength(2)
  })
})

describe('v2 → v3 迁移', () => {
  it('旧库升级后旧数据还在，且收藏夹表可用', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bao-bookmarks-v2-'))
    const file = join(dir, 'db', 'browser.sqlite3')
    // 手工造一个 v2 库（v1 的 settings + v2 的 session），模拟真实老用户。
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(dir, 'db'), { recursive: true })
    const legacy = new DatabaseSync(file)
    legacy.exec(`
      CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE engine_rules(host TEXT PRIMARY KEY, engine TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE session(id INTEGER PRIMARY KEY CHECK (id = 0), payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      PRAGMA user_version = 2;
      INSERT INTO settings(key, value, updated_at) VALUES('theme.mode', 'dark', 1);
    `)
    legacy.close()

    const store = await openStore({ userData: dir })
    opened.push({ dir, store })
    const version = Number(store.db.pragma<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0)
    expect(version).toBe(3)
    expect(store.previousVersion).toBe(2)
    expect(readSettings(store.db).themeMode).toBe('dark')
    expect(readBookmarks(store.db).filter((node) => node.parentId === null)).toHaveLength(2)
  })
})

describe('新增与排序', () => {
  it('按加入顺序排队，标题为空时回落到 host', async () => {
    const store = await openTemp()
    const first = addBookmark(store.db, { parentId: BOOKMARK_BAR_ROOT, kind: 'url', title: '4399', url: 'https://www.4399.com/' })
    const second = addBookmark(store.db, { parentId: BOOKMARK_BAR_ROOT, kind: 'url', url: 'https://www.mole.com/game' })
    expect(barIds(store)).toEqual([first.id, second.id])
    expect(second.title).toBe('www.mole.com')
    expect(childrenOf(readBookmarks(store.db), BOOKMARK_BAR_ROOT).map((node) => node.position)).toEqual([0, 1])
  })

  it('文件夹里可以再放书签', async () => {
    const store = await openTemp()
    const folder = addBookmark(store.db, { parentId: BOOKMARK_BAR_ROOT, kind: 'folder', title: '常用站点' })
    const inside = addBookmark(store.db, { parentId: folder.id, kind: 'url', title: '淘米', url: 'https://www.61.com/' })
    expect(childrenOf(readBookmarks(store.db), folder.id).map((node) => node.id)).toEqual([inside.id])
  })

  it('网址书签必须带地址，文件夹不能带地址', async () => {
    const store = await openTemp()
    expect(() => addBookmark(store.db, { parentId: BOOKMARK_BAR_ROOT, kind: 'url', title: 'x' })).toThrow()
    expect(() => addBookmark(store.db, { parentId: BOOKMARK_BAR_ROOT, kind: 'folder', title: 'x', url: 'https://a.com/' })).toThrow()
  })

  it('父节点不存在或不是文件夹时拒绝', async () => {
    const store = await openTemp()
    const leaf = addBookmark(store.db, { parentId: BOOKMARK_BAR_ROOT, kind: 'url', title: 'a', url: 'https://a.com/' })
    expect(() => addBookmark(store.db, { parentId: 'ghost', kind: 'url', title: 'b', url: 'https://b.com/' })).toThrow()
    expect(() => addBookmark(store.db, { parentId: leaf.id, kind: 'url', title: 'b', url: 'https://b.com/' })).toThrow()
  })
})

describe('移动', () => {
  it('同父内重排后序号连续', async () => {
    const store = await openTemp()
    const a = addBookmark(store.db, { parentId: BOOKMARK_BAR_ROOT, kind: 'url', title: 'a', url: 'https://a.com/' })
    const b = addBookmark(store.db, { parentId: BOOKMARK_BAR_ROOT, kind: 'url', title: 'b', url: 'https://b.com/' })
    const c = addBookmark(store.db, { parentId: BOOKMARK_BAR_ROOT, kind: 'url', title: 'c', url: 'https://c.com/' })
    moveBookmark(store.db, c.id, BOOKMARK_BAR_ROOT, 0)
    expect(barIds(store)).toEqual([c.id, a.id, b.id])
    expect(childrenOf(readBookmarks(store.db), BOOKMARK_BAR_ROOT).map((node) => node.position)).toEqual([0, 1, 2])
  })

  it('跨父移动：源与目标两侧的序号都重排', async () => {
    const store = await openTemp()
    const a = addBookmark(store.db, { parentId: BOOKMARK_BAR_ROOT, kind: 'url', title: 'a', url: 'https://a.com/' })
    const b = addBookmark(store.db, { parentId: BOOKMARK_BAR_ROOT, kind: 'url', title: 'b', url: 'https://b.com/' })
    moveBookmark(store.db, a.id, BOOKMARK_OTHER_ROOT, 0)
    expect(barIds(store)).toEqual([b.id])
    expect(otherIds(store)).toEqual([a.id])
    expect(childrenOf(readBookmarks(store.db), BOOKMARK_BAR_ROOT).map((node) => node.position)).toEqual([0])
  })

  it('不能把文件夹移进自己的子孙，也不能动永久根', async () => {
    const store = await openTemp()
    const folder = addBookmark(store.db, { parentId: BOOKMARK_BAR_ROOT, kind: 'folder', title: 'f' })
    const inner = addBookmark(store.db, { parentId: folder.id, kind: 'folder', title: 'inner' })
    expect(() => moveBookmark(store.db, folder.id, inner.id, 0)).toThrow(/into-descendant/)
    expect(() => moveBookmark(store.db, BOOKMARK_BAR_ROOT, BOOKMARK_OTHER_ROOT, 0)).toThrow(/permanent-root/)
  })
})

describe('删除与清理', () => {
  it('删除文件夹会级联删除子项，并重排同级', async () => {
    const store = await openTemp()
    const folder = addBookmark(store.db, { parentId: BOOKMARK_BAR_ROOT, kind: 'folder', title: 'f' })
    const inner = addBookmark(store.db, { parentId: folder.id, kind: 'url', title: 'x', url: 'https://x.com/' })
    const tail = addBookmark(store.db, { parentId: BOOKMARK_BAR_ROOT, kind: 'url', title: 'tail', url: 'https://t.com/' })
    deleteBookmark(store.db, folder.id)
    const ids = readBookmarks(store.db).map((node) => node.id)
    expect(ids).not.toContain(folder.id)
    expect(ids).not.toContain(inner.id)
    expect(barIds(store)).toEqual([tail.id])
    expect(childrenOf(readBookmarks(store.db), BOOKMARK_BAR_ROOT)[0].position).toBe(0)
  })

  it('永久根不能删除', async () => {
    const store = await openTemp()
    expect(() => deleteBookmark(store.db, BOOKMARK_BAR_ROOT)).toThrow(/永久根/)
  })

  it('clearBookmarks 只清内容，保留两个根', async () => {
    const store = await openTemp()
    addBookmark(store.db, { parentId: BOOKMARK_BAR_ROOT, kind: 'url', title: 'a', url: 'https://a.com/' })
    addBookmark(store.db, { parentId: BOOKMARK_OTHER_ROOT, kind: 'folder', title: 'f' })
    clearBookmarks(store.db)
    expect(readBookmarks(store.db).map((node) => node.id)).toEqual([BOOKMARK_BAR_ROOT, BOOKMARK_OTHER_ROOT])
  })
})

describe('改名', () => {
  it('可以改标题，空标题被拒', async () => {
    const store = await openTemp()
    const node = addBookmark(store.db, { parentId: BOOKMARK_BAR_ROOT, kind: 'url', title: 'a', url: 'https://a.com/' })
    renameBookmark(store.db, node.id, '新名字')
    expect(readBookmarks(store.db).find((entry) => entry.id === node.id)?.title).toBe('新名字')
    expect(() => renameBookmark(store.db, node.id, '   ')).toThrow()
  })
})
