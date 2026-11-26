<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import {
  BOOKMARK_BAR_ROOT, BOOKMARK_OTHER_ROOT, BOOKMARK_ROOTS, childrenOf, isPermanentRoot
} from '../shared/bookmarks'
import type { BookmarkNode } from '../shared/bookmarks'
import ShellIcon from './ShellIcon.vue'
import { applyShellTheme, initialShellTheme } from './theme'
import { useBrowserStore } from './stores/browser'
import './overlay-panel.css'

/**
 * 收藏夹飞窗（M2「书签与历史」第一轮）= Edge 工具栏那颗「收藏夹」按钮打开的树。
 *
 * 它与**地址栏星标**是两件事（对照 Chromium 源码确认过）：
 * - 星标在地址栏里（`StarView` + `BookmarkBubbleView`）：管"这一页收藏了没有"；
 * - 这里是"我的收藏都在哪"的浏览面（Edge 的 bookmarks hub）：树、打开、删除。
 *
 * 与快捷设置/引擎面板共用同一份卡片与行样式（`overlay-panel.css`），也共用同一个飞窗视图：
 * 换页只是宿主里 `v-show` 切换，不重新挂载、不重新预热。
 *
 * 本轮边界：只做浏览/打开/删除。新建文件夹、拖动排序、搜索、导入要等 `bao://favorites`
 * 管理页——画出来点不动就是假 UI。
 */
const props = defineProps<{ paused?: boolean }>()

const store = useBrowserStore()
const { snapshot } = storeToRefs(store)
const panel = ref<HTMLElement>()
const busy = ref(false)
const error = ref('')

const nodes = computed<BookmarkNode[]>(() => snapshot.value?.bookmarks ?? [])

/** 站点图标（主进程按 origin 抓好的那张表）：查不到就画通用页形，不画占位方块。 */
function faviconOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return snapshot.value?.favicons?.[new URL(url).origin]
  } catch {
    return undefined
  }
}

function labelOf(id: string): string {
  const fallback = id === BOOKMARK_BAR_ROOT ? '收藏夹栏' : id === BOOKMARK_OTHER_ROOT ? '其他收藏夹' : '收藏夹'
  return nodes.value.find((node) => node.id === id)?.title || fallback
}

/**
 * 展开状态（2026-11-26 反馈：收藏夹是**可展开可关闭**的，不是"分组标题 + 分隔线"）。
 *
 * 默认全收起——和 Edge 打开收藏夹时一样，先看到两个文件夹，点开才铺内容。
 * 状态只在本组件里（飞窗关掉再打开就复位），不做持久化：收藏夹的形状是库里的事，
 * "上次点开了哪个文件夹"不是需要记住的偏好。
 */
const expanded = ref(new Set<string>())

function toggleFolder(id: string): void {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
  // 高度会变：折叠/展开后立刻重量一次（否则视图留一截空白）。
  void nextTick(measure)
}

interface PanelRow {
  node: BookmarkNode
  depth: number
  /** 有子项才画箭头；没有就是普通行（Edge 同样如此）。 */
  hasChildren: boolean
}

/** 按展开状态摊平：折叠的文件夹不展开子项。 */
function rowsUnder(parentId: string, depth: number): PanelRow[] {
  const rows: PanelRow[] = []
  for (const node of childrenOf(nodes.value, parentId)) {
    const children = node.kind === 'folder' ? childrenOf(nodes.value, node.id) : []
    rows.push({ node, depth, hasChildren: children.length > 0 })
    if (children.length > 0 && expanded.value.has(node.id)) rows.push(...rowsUnder(node.id, depth + 1))
  }
  return rows
}

/** 两个永久根 + 各自展开出来的行。根一定是文件夹，所以两行都在（空根也画）。 */
const rows = computed<PanelRow[]>(() => BOOKMARK_ROOTS.flatMap((id) => {
  const root = nodes.value.find((node) => node.id === id)
  if (!root) return []
  const children = childrenOf(nodes.value, root.id)
  const head: PanelRow = { node: root, depth: 0, hasChildren: children.length > 0 }
  return expanded.value.has(root.id) ? [head, ...rowsUnder(root.id, 1)] : [head]
}))

const total = computed(() => nodes.value.filter((node) => !isPermanentRoot(node.id)).length)

let detach: (() => void) | undefined
let observer: ResizeObserver | undefined
let lastSentHeight = 0

/** 与其它飞窗同一套高度上报（内容高度，去重后才发，避免「测量 ↔ 设 bounds」正反馈）。 */
function measure(): void {
  const element = panel.value
  if (!element) return
  const contentHeight = element.scrollHeight
  if (contentHeight < 40) return
  const next = contentHeight + 2
  if (Math.abs(next - lastSentHeight) < 1) return
  lastSentHeight = next
  void window.baoOverlay.resizeQuick(next)
}

async function remove(id: string): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    if (!await store.run({ type: 'remove-bookmark', id })) error.value = store.message || '未能删除这条收藏'
    await nextTick()
    measure()
  } finally {
    busy.value = false
  }
}

async function open(node: BookmarkNode): Promise<void> {
  if (node.kind !== 'url' || busy.value) return
  busy.value = true
  error.value = ''
  try {
    // 地址由主进程按 id 从库里取（面板拿不到任意导航能力）。
    if (!await store.run({ type: 'open-bookmark', id: node.id })) {
      error.value = store.message || '无法打开这条收藏'
      return
    }
    await window.baoOverlay.closeQuick(true)
  } finally {
    busy.value = false
  }
}

/**
 * 打开管理页（`bao://favorites`）并收起本飞窗。
 *
 * 为什么先关飞窗再切标签：管理页是**另一个标签**，飞窗挂在工具栏按钮下、属于外壳；
 * 留着它会盖在新页面的上方（视图在最上层），看起来像"点了没反应"。
 */
async function manage(): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    if (!await store.run({ type: 'open-favorites' })) {
      error.value = store.message || '无法打开收藏夹管理页'
      return
    }
    await window.baoOverlay.closeQuick(true)
  } finally {
    busy.value = false
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  void window.baoOverlay.closeQuick(true)
}

onMounted(() => {
  detach = window.baoOverlay.subscribe((event) => {
    if (event.type === 'quick-opened' && event.view === 'bookmarks') {
      applyShellTheme(event.theme)
      // 外壳给的初始高度只是猜测：每次打开/换页都必须重新上报一次。去重值要一起清掉，
      // 否则第二次打开会留下一截空白视图——那截空白会把页面上的点击吃掉。
      lastSentHeight = 0
      void nextTick(measure)
    }
  })
  observer = new ResizeObserver(measure)
  if (panel.value) observer.observe(panel.value)
  store.connect()
  void nextTick(measure)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  detach?.()
  store.disconnect()
})

watch([() => props.paused, nodes], () => { void nextTick(measure) })
watch(() => snapshot.value?.settings, () => { void nextTick(measure) })

applyShellTheme(initialShellTheme())
watch(() => snapshot.value?.theme, (theme) => { if (theme) applyShellTheme(theme) })
</script>

<template>
  <div class="hub-frame" @keydown="onKeydown">
    <section id="bookmarks-panel" ref="panel" class="quick overlay-card hub" role="dialog" aria-label="收藏夹">
      <h2 class="overlay-title">
        <span>收藏夹</span>
        <span v-if="total" class="hub-count">{{ total }}</span>
      </h2>
      <div class="overlay-divider" role="presentation"></div>

      <div v-if="total > 0" class="hub-lists" aria-label="收藏列表">
        <!--
          文件夹是**可展开可关闭**的行（2026-11-26 反馈）：箭头转 180°，点一下铺开子项。
          之前是"分组标题 + 分隔线"，看起来像两个死标题，也没法收起。
        -->
        <div
          v-for="row in rows"
          :key="row.node.id"
          class="hub-row"
          :class="{ root: row.depth === 0 }"
          :style="{ paddingInlineStart: `${4 + row.depth * 14}px` }"
        >
          <button
            v-if="row.node.kind === 'folder' && row.hasChildren"
            type="button"
            class="row-chevron"
            :class="{ expanded: expanded.has(row.node.id) }"
            :aria-expanded="expanded.has(row.node.id)"
            :aria-label="`${expanded.has(row.node.id) ? '收起' : '展开'}${row.node.title}`"
            @click="toggleFolder(row.node.id)"
          ><ShellIcon name="chevron" /></button>
          <!-- 没有子项的文件夹不画箭头：点了也不会有东西展开，那就是假控件。 -->
          <span v-else class="row-chevron-spacer" aria-hidden="true"></span>
          <span v-if="row.node.kind === 'url'" class="row-icon" aria-hidden="true">
            <img v-if="faviconOf(row.node.url)" class="favicon" :src="faviconOf(row.node.url)" alt="">
            <ShellIcon v-else name="page" />
          </span>
          <span v-else class="row-icon folder" aria-hidden="true"><ShellIcon name="folder" /></span>
          <button
            v-if="row.node.kind === 'url'"
            type="button"
            class="row-title"
            :title="row.node.url"
            :disabled="busy"
            @click="open(row.node)"
          >{{ row.node.title }}</button>
          <!-- 文件夹行本身不导航（新建/拖动/重命名要等管理页），只负责展开收起。 -->
          <button
            v-else
            type="button"
            class="row-title folder-label"
            :disabled="!row.hasChildren"
            @click="row.hasChildren && toggleFolder(row.node.id)"
          >{{ row.node.title }}</button>
          <!-- 计数去掉了（2026-11-26 反馈：它压在行里、挡着点击）。 -->
          <button
            v-if="row.depth > 0"
            type="button"
            class="row-remove"
            :aria-label="`删除收藏：${row.node.title}`"
            :title="`删除${row.node.title}`"
            :disabled="busy"
            @click="remove(row.node.id)"
          ><ShellIcon name="close" /></button>
        </div>
      </div>
      <p v-else class="overlay-empty">
        还没有收藏。在网页上点地址栏里的星标即可收藏，收藏会出现在这里。
      </p>

      <p v-if="error" class="overlay-error" role="status">{{ error }}</p>

      <!--
        管理页入口（Edge 的收藏夹 hub 底部同样有「管理收藏夹」）：
        面板只做快速浏览/打开，整理（拖动排序、改名、导入）在 `bao://favorites` 里做。
      -->
      <div class="overlay-divider" role="presentation"></div>
      <button type="button" class="hub-manage" :disabled="busy" @click="manage">管理收藏夹</button>
    </section>
  </div>
</template>

<style>
/* 卡片/标题/分组标签/分隔线/空状态全部取 `overlay-panel.css`；这里只留树行的排布。 */
.hub-frame {
  box-sizing: border-box;
  width: 100%;
  height: 100vh;
  /* 视图比卡片大一圈：四周（除顶边）留透明边距画投影。数值来自 OVERLAY_GUTTER，
     由 OverlayHost 写成 CSS 变量；透明边距里的鼠标由主进程转发给页面（见 shell-overlays.ts）。 */
  padding: 0 var(--overlay-gutter-x, 12px) var(--overlay-gutter-bottom, 20px);
  display: flex;
  align-items: flex-start;
}
.hub-count { font-size: 11px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }

/* 列表封顶滚动：收藏夹可以是几百条，但飞窗不该长成一整屏（与设置页规则列表同一做法）。 */
.hub-lists { max-height: 340px; overflow-y: auto; scrollbar-gutter: stable; }

/* 树行：与其它飞窗的行同高同圆角（36px / 7px），左边留出箭头 + 图标列。 */
.hub-row {
  display: grid;
  grid-template-columns: 16px 16px minmax(0, 1fr) 24px;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  padding-inline-end: 4px;
  border-radius: 7px;
}
.hub-row:hover { background: var(--surface-hover); }
/* 两个永久根是"文件夹行"：加粗一点，和里面的条目区分开。 */
.hub-row.root .row-title { font-weight: 600; }
.row-chevron {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border-radius: 4px;
  color: var(--text-secondary);
}
.row-chevron .shell-icon { width: 12px; height: 12px; transition: transform var(--motion-fast) ease; }
.row-chevron.expanded .shell-icon { transform: rotate(180deg); }
.row-chevron:hover { color: var(--text-primary); }
.row-chevron-spacer { width: 16px; height: 16px; }
.row-icon { display: grid; place-items: center; color: var(--text-secondary); }
.row-icon .shell-icon { width: 13px; height: 13px; }
/* 站点图标 16px（Chromium 的收藏夹行图标同样 16）。 */
.row-icon .favicon { width: 16px; height: 16px; }
.row-title {
  min-width: 0;
  text-align: start;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hub-row .row-title:focus-visible { outline: none; color: var(--accent-strong); }
.folder-label { color: var(--text-secondary); }
/* 行上的删除：平时淡出，悬停/键盘聚焦才亮起来（与标签关闭按钮同一手法）。 */
.hub-row .row-remove {
  display: grid; place-items: center; width: 24px; height: 24px; padding: 0;
  border-radius: 5px; color: var(--text-secondary); opacity: 0;
}
.hub-row:hover .row-remove, .hub-row .row-remove:focus-visible { opacity: 1; }
.hub-row .row-remove:hover:not(:disabled) { color: var(--text-primary); background: var(--surface-pressed); }
.hub-row .row-remove .shell-icon { width: 13px; height: 13px; }
@media (forced-colors: active) { .hub-row .row-remove { opacity: 1; } }

/* 底部「管理收藏夹」：与其它飞窗的行按钮同高同圆角，整行宽，悬停才铺底色。 */
.hub-manage {
  display: block;
  width: 100%;
  min-height: 34px;
  padding: 0 8px;
  border-radius: 7px;
  text-align: start;
  font-size: 12px;
  color: var(--accent-strong);
}
.hub-manage:hover:not(:disabled) { background: var(--surface-hover); }
.hub-manage:disabled { color: var(--text-disabled); }
</style>
