import type { BookmarkNode } from './bookmarks'
import type { BrowserFailureCode } from './browser'

/**
 * 收藏夹**管理页**（`bao://favorites`）与主进程之间的窄合同。
 *
 * 为什么是独立内部页而不是飞窗：`chrome://bookmarks` 在 Chromium 里就是一个独立 WebUI
 * （`chrome/browser/ui/webui/bookmarks/bookmarks_ui.cc` 注册 host 与 `WebUIConfig`），
 * 因为它要同时摆下「文件夹树 + 条目列表 + 工具栏」三块；我们的飞窗卡片宽度是 264
 * （`overlay-geometry.ts` 的 `ENGINE_PANEL_CARD_WIDTH`），装不下这三块。
 *
 * 与 `baoSettings` / `baoNtp` 同一套边界：内部页拿不到 `baoBrowser` / `baoOverlay`，
 * 只有「读快照 / 发窄命令 / 订阅」三个动词；每条命令都按**库里的 id** 校验，
 * 页面永远不能直接把一个地址塞进浏览器。
 */
export const favoritesChannels = {
  read: 'favorites:read',
  command: 'favorites:command',
  changed: 'favorites:changed'
} as const

/**
 * 管理页需要的全部状态。
 *
 * `bookmarks` 是全量树（两个永久根 + 所有节点），与外壳那份投影是同一代数据：
 * 管理页自己做树与列表，不再单独开一条"取某个文件夹"的通道——收藏夹规模是几百条，
 * 整份下去比维护分页/失效通知简单得多，也不会出现"左树已更新、列表还是旧的一组子项"。
 */
export interface FavoritesSnapshot {
  bookmarks: BookmarkNode[]
  /** `origin → data URL`（主进程抓好并缓存的站点图标表，与外壳共用）。 */
  favicons: Record<string, string>
  /** 解析后的亮/暗：主题变化时管理页要跟着重绘。 */
  theme: 'light' | 'dark'
  /** 业务库是否可用；不可用时页面只读并给出说明，而不是让按钮看起来能点。 */
  storage: 'ready' | 'unavailable'
}

/**
 * 管理页能做的四件事（第三轮会再加移动与导入，届时各自带自己的校验）。
 *
 * 命名与 Chromium 的 `chrome.bookmarks` 系列保持一致（`create` / `update` / `remove`），
 * 这样看源码时不用做第二次翻译；`open` 对应用户双击一条收藏的行为。
 */
export type FavoritesCommand =
  /**
   * 打开一条收藏。
   *
   * 对齐 Chromium：双击书签**总是在新前台标签页打开**
   * （`chrome/browser/resources/bookmarks/command_manager.ts:556-558` 的
   * `Command.OPEN → openInNewTab(id, {active: true})`），而不是把当前这个管理页顶掉。
   * 地址由主进程按 id 从库里取，页面传不了任意 URL。
   */
  | { type: 'open'; id: string }
  /** 新建文件夹（Edge 的「新建文件夹」）：建完立刻进入改名态，由页面负责聚焦输入框。 */
  | { type: 'create-folder'; title: string; parentId: string }
  /** 改名（书签与文件夹都适用）：空标题由存储层拒绝。 */
  | { type: 'rename'; id: string; title: string }
  /** 删除（文件夹连同子树）：永久根由存储层拒绝。 */
  | { type: 'remove'; id: string }
  /**
   * 移动 / 排序（拖动）。
   *
   * `index` 是**移除被拖项之后**的最终索引，与 `store.moveBookmark()` 的口径一致；
   * 由界面用 `shared/bookmarks.ts` 的 `insertionIndex()` 换算出来，不要在两边各算一遍。
   * 环（拖进自己的子孙）与非法父节点由存储层的 `checkPlacement()` 拒，命令返回
   * `bookmark-placement`，界面据此提示而不用先本地改一遍再回滚。
   */
  | { type: 'move'; id: string; parentId: string; index: number }

export type FavoritesCommandResult =
  | {
    ok: true
    /** 命令执行后的最新快照：页面直接替换，不靠"先改 DOM 再等广播"。 */
    snapshot: FavoritesSnapshot
    /** 新建文件夹返回新节点 id（页面据此进入改名态）。 */
    createdId?: string
  }
  | { ok: false; code: BrowserFailureCode }

export interface FavoritesBridge {
  read(): Promise<FavoritesSnapshot | undefined>
  run(command: FavoritesCommand): Promise<FavoritesCommandResult>
  subscribe(listener: (snapshot: FavoritesSnapshot) => void): () => void
}
