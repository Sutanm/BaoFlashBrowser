<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { BOOKMARK_BAR_ROOT, BOOKMARK_OTHER_ROOT, flattenTree } from '../shared/bookmarks'
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

function labelOf(id: string): string {
  const fallback = id === BOOKMARK_BAR_ROOT ? '收藏夹栏' : id === BOOKMARK_OTHER_ROOT ? '其他收藏夹' : '收藏夹'
  return nodes.value.find((node) => node.id === id)?.title || fallback
}

/** 只列**有内容**的根：空根留一个光秃秃的标题、下面什么都没有，看着像渲染坏了。 */
const groups = computed(() => [BOOKMARK_BAR_ROOT, BOOKMARK_OTHER_ROOT]
  .map((id) => ({ id, label: labelOf(id), rows: flattenTree(nodes.value, id) }))
  .filter((group) => group.rows.length > 0))
const total = computed(() => groups.value.reduce((sum, group) => sum + group.rows.length, 0))

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

      <div class="hub-lists" aria-label="收藏列表">
        <p v-if="total === 0" class="overlay-empty">
          还没有收藏。在网页上点地址栏里的星标即可收藏，收藏会出现在这里。
        </p>
        <template v-for="group in groups" :key="group.id">
          <p class="overlay-label">
            <span>{{ group.label }}</span>
            <span class="count">{{ group.rows.length }}</span>
          </p>
          <div
            v-for="row in group.rows"
            :key="row.node.id"
            class="hub-row"
            :style="{ paddingInlineStart: `${8 + row.depth * 14}px` }"
          >
            <span v-if="row.node.kind === 'url'" class="row-icon" aria-hidden="true"><ShellIcon name="page" /></span>
            <span v-else class="row-icon folder" aria-hidden="true"><ShellIcon name="folder" /></span>
            <button
              v-if="row.node.kind === 'url'"
              type="button"
              class="row-title"
              :title="row.node.url"
              :disabled="busy"
              @click="open(row.node)"
            >{{ row.node.title }}</button>
            <!-- 文件夹本轮只展示（缩进 + 图标）：新建/拖动/重命名要等管理页，画成可点就是假 UI。 -->
            <span v-else class="row-title folder-label">{{ row.node.title }}</span>
            <button
              type="button"
              class="row-remove"
              :aria-label="`删除收藏：${row.node.title}`"
              :title="`删除${row.node.title}`"
              :disabled="busy"
              @click="remove(row.node.id)"
            ><ShellIcon name="close" /></button>
          </div>
        </template>
      </div>

      <p v-if="error" class="overlay-error" role="status">{{ error }}</p>
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
  padding: 0 var(--overlay-gutter, 12px) var(--overlay-gutter, 12px);
  display: flex;
  align-items: flex-start;
}
.hub-count { font-size: 11px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }

/* 列表封顶滚动：收藏夹可以是几百条，但飞窗不该长成一整屏（与设置页规则列表同一做法）。 */
.hub-lists { max-height: 340px; overflow-y: auto; scrollbar-gutter: stable; }

/* 树行：与其它飞窗的行同高同圆角（36px / 7px），左边留出图标列。 */
.hub-row {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) 24px;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  padding-inline-end: 4px;
  border-radius: 7px;
}
.hub-row:hover { background: var(--surface-hover); }
.row-icon { display: grid; place-items: center; color: var(--text-secondary); }
.row-icon .shell-icon { width: 13px; height: 13px; }
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
</style>
