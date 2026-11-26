<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  BOOKMARK_BAR_ROOT, BOOKMARK_OTHER_ROOT, BOOKMARK_ROOTS, checkPlacement, childrenOf, descendantIds,
  insertionIndex, isPermanentRoot, matchesQuery
} from '../shared/bookmarks'
import type { BookmarkNode } from '../shared/bookmarks'
import type { FavoritesCommand, FavoritesCommandResult, FavoritesSnapshot } from '../shared/favorites'
import ShellIcon from './ShellIcon.vue'
import { applyShellTheme } from './theme'

/**
 * 收藏夹管理页（`bao://favorites`）——收藏夹这条线的最后一块。
 *
 * 形态对齐 `edge://favorites` / `chrome://bookmarks`（`chrome/browser/resources/bookmarks/`）：
 * 左边是文件夹树、右边是当前文件夹的条目列表、上面一条工具栏。为什么不做成飞窗：
 * 飞窗卡片 264 宽（`shared/overlay-geometry.ts`），三块内容摆不下；Chromium 也把它当
 * 独立 WebUI（`chrome/browser/ui/webui/bookmarks/bookmarks_ui.cc`）。
 *
 * 交互口径（都能从源码对上）：
 * - **双击**一条收藏 = 在新前台标签页打开（`command_manager.ts:556-558` 的
 *   `Command.OPEN → openInNewTab(id, {active: true})`）；单击只选中，不导航；
 * - 改名是**行内输入框**（Chromium 用对话框）：Enter/失焦提交、Esc 取消，
 *   提交走主进程的 `rename`，界面不自己改本地列表；
 * - 删除带子项的文件夹**先问一句**：我们没有 Ctrl+Z 撤销，删掉整棵子树就找不回来了
 *   （Chromium 不确认，是因为它有 undo，见 `command_manager.ts` 的 `Command.UNDO`）。
 */
const props = defineProps<{ bootstrap?: FavoritesSnapshot }>()

const page = ref<HTMLElement>()
const snapshot = ref<FavoritesSnapshot | undefined>(props.bootstrap)
const nodes = computed<BookmarkNode[]>(() => snapshot.value?.bookmarks ?? [])
const storageReady = computed(() => snapshot.value?.storage === 'ready')

/** 哪个文件夹的内容正显示在右边。默认「收藏夹栏」（Edge 打开管理页也是先停在收藏夹栏）。 */
const currentFolderId = ref<string>(BOOKMARK_BAR_ROOT)
/** 当前选中项：要么是树里的文件夹，要么是列表里的一行。 */
const selectedId = ref<string>(BOOKMARK_BAR_ROOT)
const expanded = ref(new Set<string>([BOOKMARK_BAR_ROOT, BOOKMARK_OTHER_ROOT]))
const query = ref('')
/** 正在改名的节点（行内输入框）。 */
const editingId = ref<string>()
const editingTitle = ref('')
/** 等待确认的删除（只用于「带子项的文件夹」）。 */
const pendingRemove = ref<BookmarkNode>()
const status = ref('')
/** 状态行的语气：成功是普通文字色，失败才用错误色（一句绿色提示也被染红会像出错）。 */
const statusKind = ref<'ok' | 'error'>('error')
const busy = ref(false)
const importing = ref(false)
const fileField = ref<HTMLInputElement>()

const failureText: Record<string, string> = {
  'forbidden-sender': '当前页面无权修改收藏夹',
  'invalid-command': '这个操作不被允许',
  'bookmark-save-failed': '收藏夹没有保存成功，原有内容未更改',
  'bookmark-missing': '这条收藏已经不存在了',
  'storage-unavailable': '收藏夹存储不可用，本次无法保存',
  'bookmark-placement': '不能把文件夹移到它自己或它的子文件夹里'
}

const searching = computed(() => query.value.trim().length > 0)

function byId(id: string): BookmarkNode | undefined {
  return nodes.value.find((node) => node.id === id)
}

function titleOf(id: string): string {
  const fallback = id === BOOKMARK_BAR_ROOT ? '收藏夹栏' : id === BOOKMARK_OTHER_ROOT ? '其他收藏夹' : '收藏夹'
  return byId(id)?.title || fallback
}

function childCount(id: string): number {
  return childrenOf(nodes.value, id).length
}

function faviconOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return snapshot.value?.favicons?.[new URL(url).origin]
  } catch {
    return undefined
  }
}

/* ---------------------------------------------------------------- *
 * 树（左栏）
 * ---------------------------------------------------------------- */

interface TreeRow {
  node: BookmarkNode
  depth: number
  hasChildren: boolean
}

function rowsUnder(parentId: string, depth: number): TreeRow[] {
  const rows: TreeRow[] = []
  for (const node of childrenOf(nodes.value, parentId)) {
    if (node.kind !== 'folder') continue
    const children = childCount(node.id)
    rows.push({ node, depth, hasChildren: children > 0 })
    if (children > 0 && expanded.value.has(node.id)) rows.push(...rowsUnder(node.id, depth + 1))
  }
  return rows
}

/** 两个永久根永远在树里（空根也画，否则用户不知道收藏夹栏存在）。 */
const treeRows = computed<TreeRow[]>(() => BOOKMARK_ROOTS.flatMap((id) => {
  const root = byId(id)
  if (!root) return []
  const head: TreeRow = { node: root, depth: 0, hasChildren: childCount(root.id) > 0 }
  return expanded.value.has(root.id) ? [head, ...rowsUnder(root.id, 1)] : [head]
}))

function toggleFolder(id: string): void {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

/** 选中某个文件夹：展开它的祖先链（否则选中的行藏在折叠的父节点里，页面上看不到）。 */
function revealParent(id: string): void {
  const next = new Set(expanded.value)
  let parentId = byId(id)?.parentId
  while (parentId) {
    next.add(parentId)
    parentId = byId(parentId)?.parentId
  }
  expanded.value = next
}

function selectFolder(id: string): void {
  currentFolderId.value = id
  selectedId.value = id
  revealParent(id)
}

/* ---------------------------------------------------------------- *
 * 列表（右栏）
 * ---------------------------------------------------------------- */

interface ListRow {
  node: BookmarkNode
  /** 搜索态下显示所属文件夹路径；普通浏览态为空。 */
  path: string
}

/** 祖先链 → 「收藏夹栏 / 前端 / 工具」，与 Chromium 搜索结果里的路径提示同一用途。 */
function pathOf(id: string): string {
  const parts: string[] = []
  let parentId = byId(id)?.parentId
  while (parentId) {
    parts.unshift(titleOf(parentId))
    parentId = byId(parentId)?.parentId
  }
  return parts.join(' / ')
}

/** 整棵树按树序摊平（搜索用）：两个根的子节点各自展开，不含根本身。 */
function allNodes(): BookmarkNode[] {
  const rows: BookmarkNode[] = []
  const walk = (parentId: string): void => {
    for (const node of childrenOf(nodes.value, parentId)) {
      rows.push(node)
      if (node.kind === 'folder') walk(node.id)
    }
  }
  for (const root of BOOKMARK_ROOTS) walk(root)
  return rows
}

const listRows = computed<ListRow[]>(() => {
  if (searching.value) {
    return allNodes()
      .filter((node) => matchesQuery(node, query.value))
      .map((node) => ({ node, path: pathOf(node.id) }))
  }
  return childrenOf(nodes.value, currentFolderId.value).map((node) => ({ node, path: '' }))
})

const headingTitle = computed(() => searching.value
  ? `搜索「${query.value.trim()}」`
  : titleOf(currentFolderId.value))

const selectedNode = computed(() => byId(selectedId.value))
const canModify = computed(() => storageReady.value && !busy.value)
const canRename = computed(() => canModify.value && Boolean(selectedNode.value))
const canRemove = computed(() => canRename.value && !isPermanentRoot(selectedId.value))

/* ---------------------------------------------------------------- *
 * 命令
 * ---------------------------------------------------------------- */

/**
 * 所有写操作都走这一个入口：命令成功时用主进程返回的快照**整体替换**本地状态。
 *
 * 为什么不乐观更新：收藏夹是树，删一条会让整段顺序变化，本地先改再等广播等于把树的规则
 * 在界面上写第二遍；而主进程的返回值与广播是同一代数据，替换一次就够了。
 */
async function applyCommand(command: FavoritesCommand): Promise<FavoritesCommandResult> {
  busy.value = true
  status.value = ''
  try {
    const result = await window.baoFavorites.run(command)
    if (result.ok) {
      snapshot.value = result.snapshot
      return result
    }
    statusKind.value = 'error'
    status.value = failureText[result.code] ?? '这个操作没有完成'
    return result
  } catch {
    statusKind.value = 'error'
    status.value = '收藏夹操作失败'
    return { ok: false, code: 'storage-unavailable' }
  } finally {
    busy.value = false
  }
}

/** 名字没变、或节点已经不在了，就不发命令（空标题由存储层拒，这里先挡一层免报错）。 */
function syncSelection(): void {
  if (!byId(currentFolderId.value)) currentFolderId.value = BOOKMARK_BAR_ROOT
  if (!byId(selectedId.value)) selectedId.value = currentFolderId.value
}

async function createFolder(): Promise<void> {
  if (!canModify.value) return
  const parentId = currentFolderId.value
  const result = await applyCommand({ type: 'create-folder', title: '新建文件夹', parentId })
  if (!result.ok || !result.createdId) return
  selectedId.value = result.createdId
  startRename(result.createdId)
}

/** 进入改名态：输入框预填当前名字并全选（Edge/Chrome 的改名框同样是全选）。 */
function startRename(id: string): void {
  const node = byId(id)
  if (!node) return
  editingId.value = id
  editingTitle.value = node.title
  void nextTick(() => {
    // 改名框在树与列表里各有一份（只是位置不同），所以按 DOM 找当前那一个。
    const input = page.value?.querySelector<HTMLInputElement>('.tree-input, .row-input')
    input?.focus()
    input?.select()
  })
}

function cancelRename(): void {
  editingId.value = undefined
  editingTitle.value = ''
}

async function commitRename(): Promise<void> {
  const id = editingId.value
  if (!id) return
  const title = editingTitle.value.trim()
  const node = byId(id)
  cancelRename()
  if (!node || !title || title === node.title) return
  await applyCommand({ type: 'rename', id, title })
}

function removeSelected(): void {
  const node = selectedNode.value
  if (!node || !canRemove.value) return
  // 带子项的文件夹：删的是整棵子树，先问一句（没有撤销）。
  if (node.kind === 'folder' && childCount(node.id) > 0) {
    pendingRemove.value = node
    return
  }
  void applyRemove(node.id)
}

async function applyRemove(id: string): Promise<void> {
  // 删掉的是正在浏览的文件夹时回到它的父节点，而不是跳回收藏夹栏（少一次"东西去哪了"）。
  const parentId = byId(id)?.parentId
  pendingRemove.value = undefined
  const result = await applyCommand({ type: 'remove', id })
  if (!result.ok) return
  if (currentFolderId.value === id || !byId(currentFolderId.value)) {
    currentFolderId.value = parentId ?? BOOKMARK_BAR_ROOT
  }
  syncSelection()
}

async function confirmRemove(): Promise<void> {
  const node = pendingRemove.value
  if (!node) return
  await applyRemove(node.id)
}

async function openNode(node: BookmarkNode): Promise<void> {
  if (node.kind === 'folder') {
    selectFolder(node.id)
    return
  }
  await applyCommand({ type: 'open', id: node.id })
}

function selectRow(node: BookmarkNode): void {
  selectedId.value = node.id
}

/* ---------------------------------------------------------------- *
 * 导入（浏览器的「导出书签」HTML）
 *
 * 为什么是页面读文件：命令只收文本，主进程不碰文件路径（少一条"页面诱导主进程读任意文件"
 * 的通路）；`<input type="file">` 的对话框是系统的，选中的 `File` 由本页 `text()` 读出来。
 * ---------------------------------------------------------------- */

function chooseFile(): void {
  if (!canModify.value || importing.value) return
  fileField.value?.click()
}

async function onFilePicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // 选完就清空：不清的话，同一个文件第二次选不会触发 change（"再导一次没反应"）。
  input.value = ''
  if (!file) return
  importing.value = true
  status.value = ''
  try {
    const html = await file.text()
    const result = await window.baoFavorites.run({ type: 'import-html', html })
    if (!result.ok) {
      statusKind.value = 'error'
      status.value = result.reason === 'empty'
        ? '这个文件里没有可导入的收藏（导出 HTML 里一条都没解析出来）'
        : result.reason === 'unreadable'
          ? '读不懂这个文件，请确认它是浏览器「导出书签」得到的 HTML'
          : failureText[result.code] ?? '导入没有完成'
      return
    }
    snapshot.value = result.snapshot
    const counts = result.imported
    statusKind.value = 'ok'
    status.value = counts
      ? `已导入 ${counts.urls} 条收藏、${counts.folders} 个文件夹` +
        (counts.skipped > 0 ? `（跳过 ${counts.skipped} 条非网页地址）` : '') +
        (counts.toolbarFolder ? '' : '（文件里没有标出书签栏，全部放进了「已导入」）')
      : '导入完成'
  } catch {
    statusKind.value = 'error'
    status.value = '读取文件失败，请换一个文件再试'
  } finally {
    importing.value = false
  }
}

/* ---------------------------------------------------------------- *
 * 拖动排序 / 换文件夹
 *
 * 落点算法照 `chrome/browser/resources/bookmarks/dnd_manager.ts`：一行分三段——
 * 上 1/4 = 插到它前面、下 1/4 = 插到它后面、中间 1/2 = 放进这个文件夹（只有文件夹才给）。
 * 树里只做"放进文件夹"（树的顺序就是库里的顺序，在树里排序会与右侧列表打架）。
 *
 * 换算成 `(parentId, index)` 只走一个纯函数 `insertionIndex()`：`moveBookmark()` 的 index 是
 * **移除被拖项之后**的位置，界面算落点时被拖项还在列表里，差一位就会整体偏移。
 * ---------------------------------------------------------------- */

type DropMode = 'before' | 'after' | 'inside'

interface DropTarget {
  id: string
  mode: DropMode
}

const dragging = ref<string>()
const dropTarget = ref<DropTarget>()

function canDrag(node: BookmarkNode): boolean {
  // 永久根不能移动（存储层同样拒绝），改名中的行也不拖——否则会把输入框一起拖走。
  return storageReady.value && !busy.value && !isPermanentRoot(node.id) && editingId.value !== node.id
}

function startDrag(node: BookmarkNode, event: DragEvent): void {
  if (!canDrag(node)) {
    event.preventDefault()
    return
  }
  dragging.value = node.id
  dropTarget.value = undefined
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    // 载荷只是"看起来像拖拽"，真正的身份以 dragging 为准（页面不消费外部拖入的数据）。
    event.dataTransfer.setData('text/plain', node.id)
  }
}

/** 行 + 落点 → (parentId, index)；**放不下**时返回 undefined（界面就不给指示线）。 */
function placementFor(node: BookmarkNode, mode: DropMode): { parentId: string; index: number } | undefined {
  const draggedId = dragging.value
  if (!draggedId || draggedId === node.id) return undefined
  if (mode === 'inside') {
    if (node.kind !== 'folder') return undefined
    if (!checkPlacement(nodes.value, draggedId, node.id).ok) return undefined
    return { parentId: node.id, index: insertionIndex(nodes.value, node.id, null, draggedId) }
  }
  const parentId = node.parentId
  if (!parentId) return undefined
  if (!checkPlacement(nodes.value, draggedId, parentId).ok) return undefined
  const beforeId = mode === 'before' ? node.id : nextSiblingId(node)
  return { parentId, index: insertionIndex(nodes.value, parentId, beforeId, draggedId) }
}

function nextSiblingId(node: BookmarkNode): string | null {
  const parentId = node.parentId
  if (!parentId) return null
  const siblings = childrenOf(nodes.value, parentId)
  const at = siblings.findIndex((item) => item.id === node.id)
  return at >= 0 && at + 1 < siblings.length ? siblings[at + 1].id : null
}

/** 列表行：三段式。 */
function dragOverRow(node: BookmarkNode, event: DragEvent): void {
  const draggedId = dragging.value
  if (!draggedId || draggedId === node.id) return
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const ratio = (event.clientY - rect.top) / Math.max(rect.height, 1)
  const mode: DropMode = node.kind === 'folder' && ratio > 0.25 && ratio < 0.75
    ? 'inside'
    : ratio < 0.5 ? 'before' : 'after'
  acceptDrop(node, mode, event)
}

/** 树行：只接受「放进这个文件夹」。 */
function dragOverTree(node: BookmarkNode, event: DragEvent): void {
  if (node.kind !== 'folder') return
  acceptDrop(node, 'inside', event)
}

function acceptDrop(node: BookmarkNode, mode: DropMode, event: DragEvent): void {
  if (!placementFor(node, mode)) {
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
    if (dropTarget.value?.id === node.id) dropTarget.value = undefined
    return
  }
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  if (dropTarget.value?.id !== node.id || dropTarget.value.mode !== mode) {
    dropTarget.value = { id: node.id, mode }
  }
}

function dragLeave(node: BookmarkNode): void {
  if (dropTarget.value?.id === node.id) dropTarget.value = undefined
}

async function dropOnRow(node: BookmarkNode, event: DragEvent): Promise<void> {
  event.preventDefault()
  // 行上的 drop 不能冒泡到列表容器：那会把「插到这一行」又执行一次「追加到本文件夹末尾」，
  // 于是同一次拖拽发两条 move 命令（第二次覆盖第一次）。
  event.stopPropagation()
  const id = dragging.value
  const target = dropTarget.value?.id === node.id ? placementFor(node, dropTarget.value.mode) : undefined
  endDrag()
  if (!id || !target) return
  await applyCommand({ type: 'move', id, parentId: target.parentId, index: target.index })
  selectedId.value = id
}

/** 拖到列表空白处：追加到当前文件夹末尾（把条目拖进空文件夹不用非得瞄准树）。 */
async function dropOnList(event: DragEvent): Promise<void> {
  const id = dragging.value
  const parentId = currentFolderId.value
  const allowed = id ? checkPlacement(nodes.value, id, parentId).ok : false
  endDrag()
  if (!id || !allowed) return
  await applyCommand({
    type: 'move',
    id,
    parentId,
    index: insertionIndex(nodes.value, parentId, null, id)
  })
  selectedId.value = id
}

function endDrag(): void {
  dragging.value = undefined
  dropTarget.value = undefined
}

/** 行上的落点样式（插线 / 放进高亮）。 */
function dropClass(node: BookmarkNode): string {
  if (dropTarget.value?.id !== node.id) return ''
  return `drop-${dropTarget.value.mode}`
}

/* ---------------------------------------------------------------- *
 * 键盘
 * ---------------------------------------------------------------- */

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  return element?.tagName === 'INPUT' || element?.tagName === 'TEXTAREA'
}

function onKeydown(event: KeyboardEvent): void {
  // 焦点在输入框里时只处理 Esc（改名框的 Enter/Esc 由输入框自己处理）。
  if (isTyping(event.target)) {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (editingId.value) cancelRename()
      pendingRemove.value = undefined
    }
    return
  }
  if (event.key === 'F2' && canRename.value) {
    event.preventDefault()
    startRename(selectedId.value)
    return
  }
  if (event.key === 'Delete' && canRemove.value) {
    event.preventDefault()
    removeSelected()
    return
  }
  if (event.key === 'Escape') {
    if (pendingRemove.value) pendingRemove.value = undefined
    else if (searching.value) query.value = ''
  }
}

/* ---------------------------------------------------------------- *
 * 生命周期
 * ---------------------------------------------------------------- */

function apply(next: FavoritesSnapshot): void {
  snapshot.value = next
  applyShellTheme(next.theme)
}

let detach: (() => void) | undefined

onMounted(async () => {
  detach = window.baoFavorites.subscribe(apply)
  // 快捷键挂在 window 上：页面刚打开时焦点可能还在文档上，挂在根元素上会收不到。
  window.addEventListener('keydown', onKeydown)
  // 注入的只是首帧副本：运行时以主进程为准（别的窗口改了收藏、系统主题变了）。
  const initial = await window.baoFavorites.read()
  if (initial) apply(initial)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  detach?.()
})

// 树被外部改短时，选中项可能已经不在：落回一个真实存在的节点（不做静默的"空选中"）。
watch(nodes, syncSelection)
</script>

<template>
  <div ref="page" class="fav-page">
    <header class="fav-toolbar">
      <button
        type="button"
        class="fav-action fav-new-folder"
        :disabled="!canModify"
        @click="createFolder"
      >新建文件夹</button>
      <button
        type="button"
        class="fav-action fav-rename"
        :disabled="!canRename"
        @click="startRename(selectedId)"
      >重命名</button>
      <button
        type="button"
        class="fav-action fav-remove"
        :disabled="!canRemove"
        @click="removeSelected"
      >删除</button>
      <button
        type="button"
        class="fav-action fav-import"
        :disabled="!canModify || importing"
        @click="chooseFile"
      >{{ importing ? '正在导入…' : '导入…' }}</button>
      <!-- 真正的文件选择器：系统对话框，页面只拿到 File（见 onFilePicked）。 -->
      <input
        ref="fileField"
        type="file"
        class="fav-file"
        accept=".html,.htm,text/html"
        aria-hidden="true"
        tabindex="-1"
        @change="onFilePicked"
      >
      <div class="fav-search">
        <ShellIcon name="search" />
        <input
          v-model="query"
          type="search"
          class="fav-search-input"
          placeholder="搜索收藏夹"
          aria-label="搜索收藏夹"
        >
      </div>
    </header>

    <!-- 删除确认条：占工具栏下方一行，不遮挡列表，也不弹原生对话框（冒烟里会卡住）。 -->
    <div v-if="pendingRemove" class="fav-confirm" role="alertdialog" aria-live="polite">
      <span class="fav-confirm-text">
        删除「{{ pendingRemove.title }}」及其中 {{ descendantIds(nodes, pendingRemove.id).length }} 项？此操作无法撤销。
      </span>
      <button type="button" class="fav-confirm-yes" @click="confirmRemove">删除</button>
      <button type="button" class="fav-confirm-no" @click="pendingRemove = undefined">取消</button>
    </div>

    <div class="fav-body">
      <nav class="fav-tree" aria-label="收藏夹文件夹">
        <div
          v-for="row in treeRows"
          :key="row.node.id"
          class="tree-row"
          :class="[{ selected: row.node.id === currentFolderId, root: row.depth === 0 }, dropClass(row.node)]"
          :data-bookmark-id="row.node.id"
          :style="{ paddingInlineStart: `${6 + row.depth * 14}px` }"
          :draggable="canDrag(row.node)"
          @click="selectFolder(row.node.id)"
          @dblclick="row.hasChildren && toggleFolder(row.node.id)"
          @dragstart="startDrag(row.node, $event)"
          @dragover="dragOverTree(row.node, $event)"
          @dragleave="dragLeave(row.node)"
          @drop="dropOnRow(row.node, $event)"
          @dragend="endDrag"
        >
          <button
            v-if="row.hasChildren"
            type="button"
            class="tree-chevron"
            :class="{ expanded: expanded.has(row.node.id) }"
            :aria-expanded="expanded.has(row.node.id)"
            :aria-label="`${expanded.has(row.node.id) ? '收起' : '展开'}${row.node.title}`"
            @click.stop="toggleFolder(row.node.id)"
          ><ShellIcon name="chevron" /></button>
          <span v-else class="tree-chevron-spacer" aria-hidden="true"></span>
          <span class="tree-icon" aria-hidden="true"><ShellIcon name="folder" /></span>
          <input
            v-if="editingId === row.node.id"
            v-model="editingTitle"
            type="text"
            class="tree-input"
            :aria-label="`重命名${row.node.title}`"
            @keydown.enter.prevent="commitRename"
            @keydown.esc.prevent="cancelRename"
            @blur="commitRename"
          >
          <span v-else class="tree-label">{{ row.node.title }}</span>
        </div>
      </nav>

      <section class="fav-list" aria-label="收藏内容">
        <h1 class="fav-heading">
          <span>{{ headingTitle }}</span>
          <span class="fav-count">{{ listRows.length }}</span>
        </h1>

        <div
          v-if="listRows.length > 0"
          class="fav-rows"
          @dragover.prevent
          @drop="dropOnList"
        >
          <div
            v-for="row in listRows"
            :key="row.node.id"
            class="fav-row"
            :class="[
              { selected: row.node.id === selectedId, folder: row.node.kind === 'folder' },
              dropClass(row.node)
            ]"
            :data-bookmark-id="row.node.id"
            :data-kind="row.node.kind"
            :draggable="canDrag(row.node)"
            @click="selectRow(row.node)"
            @dblclick="openNode(row.node)"
            @dragstart="startDrag(row.node, $event)"
            @dragover="dragOverRow(row.node, $event)"
            @dragleave="dragLeave(row.node)"
            @drop="dropOnRow(row.node, $event)"
            @dragend="endDrag"
          >
            <span class="row-icon" aria-hidden="true">
              <img v-if="faviconOf(row.node.url)" class="favicon" :src="faviconOf(row.node.url)" alt="">
              <ShellIcon v-else :name="row.node.kind === 'folder' ? 'folder' : 'page'" />
            </span>
            <input
              v-if="editingId === row.node.id"
              v-model="editingTitle"
              type="text"
              class="row-input"
              :aria-label="`重命名${row.node.title}`"
              @keydown.enter.prevent="commitRename"
              @keydown.esc.prevent="cancelRename"
              @blur="commitRename"
            >
            <template v-else>
              <span class="row-title" :title="row.node.url ?? row.node.title">{{ row.node.title }}</span>
              <span class="row-meta">{{ row.path || row.node.url || `${childCount(row.node.id)} 项` }}</span>
            </template>
          </div>
        </div>
        <p v-else class="fav-empty">
          {{ searching ? '没有匹配的收藏' : '这个文件夹里还没有收藏。在网页上点地址栏的星标即可收藏。' }}
        </p>
      </section>
    </div>

    <p class="fav-status" :class="{ ok: statusKind === 'ok' }" role="status">{{ status }}</p>
  </div>
</template>

<style>
/*
 * 视觉基线对齐 Edge 的收藏夹管理页：一条工具栏 + 左树 232 + 右侧列表，
 * 行高与按钮尺寸全部取 `tokens.css` 里的同一套变量（不引入第二种控件尺寸）。
 *
 * `html, body` 的归零必须写在这里：`tokens.css` 只定义变量，不重置盒模型；
 * 少了它页面会带浏览器默认的 8px 外边距，`height: 100vh` 再叠上这个边距就会长出一条
 * 整页滚动条（2026-11-26 截图实测，管理页第一版就是这样）。
 */
html, body { margin: 0; height: 100%; overflow: hidden; }

.fav-page {
  box-sizing: border-box;
  /* 文件选择框用绝对定位藏起来，锚在这里（不要让它逃到文档根上）。 */
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--surface-page);
  color: var(--text-primary);
  font: var(--size-body, 14px) / 1.4 var(--shell-font);
}
.fav-page *, .fav-page *::before, .fav-page *::after { box-sizing: border-box; }

.fav-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
  height: 48px;
  padding: 0 12px;
  background: var(--surface-toolbar);
  border-bottom: var(--shell-stroke) solid var(--stroke-divider);
}
.fav-action {
  height: 32px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.fav-action:hover:not(:disabled) { background: var(--surface-hover); }
.fav-action:active:not(:disabled) { background: var(--surface-pressed); }
/* 禁用而不是隐藏：工具栏宽度不跳动，且"现在不能点"比"按钮消失"更清楚。 */
.fav-action:disabled { color: var(--text-disabled); cursor: default; }
.fav-action:focus-visible { outline: 2px solid var(--stroke-focus-ring); outline-offset: 1px; }

.fav-search {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-inline-start: auto;
  width: 240px;
  height: 32px;
  padding: 0 10px;
  border: var(--shell-stroke) solid var(--stroke-control);
  border-radius: var(--radius-pill);
  color: var(--text-secondary);
  background: var(--surface-page);
}
.fav-search:focus-within { border-color: var(--accent); }
.fav-search .shell-icon { width: 14px; height: 14px; flex: none; }
.fav-search-input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  outline: none;
}
.fav-search-input::-webkit-search-cancel-button { cursor: pointer; }

.fav-confirm {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  min-height: 44px;
  padding: 6px 12px;
  background: var(--surface-toolbar);
  border-bottom: var(--shell-stroke) solid var(--stroke-divider);
}
.fav-confirm-text { flex: 1; min-width: 0; font-size: var(--size-caption, 12px); }
.fav-confirm button {
  height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.fav-confirm-yes { background: var(--accent); color: #fff; }
.fav-confirm-yes:hover { background: var(--accent-strong); }
.fav-confirm-no:hover { background: var(--surface-hover); }

.fav-body { display: flex; flex: 1; min-height: 0; }

.fav-tree {
  flex: none;
  width: 232px;
  padding: 8px 8px 16px;
  overflow-y: auto;
  border-inline-end: var(--shell-stroke) solid var(--stroke-divider);
  /* 左树比内容区暗半档（Edge 的收藏夹管理页就是这个关系：工具栏与内容是同一张白面，
     只有左导航退到页面底色）。反过来（白树 + 灰内容）看起来像"内容区被禁用"。 */
  background: var(--surface-page);
}
.tree-row {
  display: grid;
  grid-template-columns: 16px 16px minmax(0, 1fr);
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding-inline-end: 8px;
  border-radius: 6px;
  cursor: default;
  user-select: none;
}
.tree-row:hover { background: var(--surface-hover); }
.tree-row.selected { background: var(--surface-selected); }
.tree-row.root .tree-label { font-weight: 600; }
.tree-chevron, .tree-chevron-spacer { width: 16px; height: 16px; }
.tree-chevron {
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.tree-chevron .shell-icon { width: 12px; height: 12px; transition: transform var(--motion-fast) ease; }
.tree-chevron.expanded .shell-icon { transform: rotate(180deg); }
.tree-chevron:hover { color: var(--text-primary); }
.tree-icon { display: grid; place-items: center; color: var(--text-secondary); }
.tree-icon .shell-icon { width: 14px; height: 14px; }
.tree-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tree-input, .row-input {
  min-width: 0;
  height: 24px;
  padding: 0 6px;
  border: var(--shell-stroke) solid var(--accent);
  border-radius: 5px;
  background: var(--surface-toolbar);
  color: var(--text-primary);
  font: inherit;
  outline: none;
}

.fav-list { flex: 1; min-width: 0; padding: 8px 16px 24px; overflow-y: auto; background: var(--surface-toolbar); }
.fav-heading {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 4px 0 8px;
  font-size: 15px;
  font-weight: 600;
}
.fav-count { font-size: var(--size-caption, 12px); font-weight: 400; color: var(--text-secondary); font-variant-numeric: tabular-nums; }

.fav-row {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) minmax(0, 240px);
  align-items: center;
  gap: 10px;
  min-height: 40px;
  padding: 0 8px;
  border-radius: 6px;
  cursor: default;
}
.fav-row:hover { background: var(--surface-hover); }
.fav-row.selected { background: var(--surface-selected); }
.fav-row .row-icon { display: grid; place-items: center; color: var(--text-secondary); }
.fav-row .row-icon .shell-icon { width: 15px; height: 15px; }
.fav-row .favicon { width: 16px; height: 16px; }
.fav-row .row-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fav-row .row-meta {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: end;
  font-size: var(--size-caption, 12px);
  color: var(--text-secondary);
}
.fav-row.folder .row-title { font-weight: 600; }

/*
 * 拖拽反馈：插到行间是 2px 的强调色直线（不占布局、不推行高），
 * 放进文件夹是整行铺中性选中面 + 一圈细描边。两种都刻意不用光晕。
 *
 * 直线用绝对定位的伪元素而不是 `box-shadow: inset`：后者会被行的 6px 圆角切出弧形端头，
 * 看起来像一条"胶囊"，而 Chromium 的插入线是直的（2026-11-26 截图对比）。
 */
.fav-row, .tree-row { position: relative; }
.fav-row.drop-before::before, .tree-row.drop-before::before,
.fav-row.drop-after::after, .tree-row.drop-after::after {
  content: '';
  position: absolute;
  inset-inline: 0;
  height: 2px;
  background: var(--accent);
  border-radius: 1px;
  pointer-events: none;
}
.fav-row.drop-before::before, .tree-row.drop-before::before { top: -1px; }
.fav-row.drop-after::after, .tree-row.drop-after::after { bottom: -1px; }
.fav-row.drop-inside, .tree-row.drop-inside {
  background: var(--surface-selected);
  outline: 1px solid var(--accent);
  outline-offset: -1px;
}

.fav-empty { margin: 24px 8px; color: var(--text-secondary); }
.fav-status { flex: none; min-height: 20px; margin: 0; padding: 0 12px 4px; font-size: var(--size-caption, 12px); color: var(--text-error); }
/* 成功的提示用正文字色，不染红也不染绿：这一行只是"说发生了什么"。 */
.fav-status.ok { color: var(--text-secondary); }
/* 文件选择框是触发器，不参与布局（用按钮代理点击）。 */
.fav-file { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
</style>
