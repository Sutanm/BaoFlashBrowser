<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { BOOKMARK_BAR_ROOT, BOOKMARK_OTHER_ROOT, flattenTree } from '../shared/bookmarks'
import type { BookmarkNode } from '../shared/bookmarks'
import ShellIcon from './ShellIcon.vue'
import { applyShellTheme, initialShellTheme } from './theme'
import { useBrowserStore } from './stores/browser'

/**
 * 收藏夹飞窗（M2「书签与历史」第一轮）= Edge 工具栏那颗「收藏夹」按钮打开的树。
 *
 * 它与**地址栏星标**是两件事（对照 Chromium 源码确认过）：
 * - 星标在最前面那层（`StarView` + `BookmarkBubbleView`）：管"这一页收藏了没有"；
 * - 这里是"我的收藏都在哪"的浏览面（Edge 的 bookmarks hub）：树、打开、删除。
 *
 * 与快捷设置共用同一个视图与渲染进程（`shared/overlay.ts` 的 `QuickView`）：
 * 换页只是宿主里 `v-show` 切换，不重新挂载、不重新预热。
 *
 * 本轮边界：只做浏览/打开/删除。新建文件夹、拖动排序、搜索、导入要等 `bao://favorites`
 * 管理页——画出来点不动就是假 UI。
 */
const props = defineProps<{ paused?: boolean }>()

/** 与 App.vue 的 `resize-quick` 口径一致：视图与面板同尺寸，不为投影留白。 */
const GUTTER_TOP = 0
const GUTTER_BOTTOM = 0

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

/**
 * 内容尺寸变了就告诉主进程（主进程再按窗口夹取，超出部分由本面板滚动）。
 *
 * 与快捷设置同一套口径：用 `scrollHeight`（内容高度）而不是盒子高度，否则
 * 「测量 → 缩小视图 → 再测量」会形成收缩反馈，最后塌成一条。
 */
function measure(): void {
  const element = panel.value
  if (!element) return
  const contentHeight = element.scrollHeight
  if (contentHeight < 40) return
  const next = contentHeight + GUTTER_TOP + GUTTER_BOTTOM + 2
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
  <div class="bookmarks-frame" @keydown="onKeydown">
    <section id="bookmarks-panel" ref="panel" class="quick bookmarks" role="dialog" aria-label="收藏夹">
      <header class="hub-head">
        <h2>收藏夹</h2>
        <span v-if="total" class="hub-count">{{ total }}</span>
      </header>
      <div class="divider" role="presentation"></div>

      <div class="lists" aria-label="收藏列表">
        <p v-if="total === 0" class="empty">
          还没有收藏。在网页上点地址栏里的星标即可收藏，收藏会出现在这里。
        </p>
        <template v-for="group in groups" :key="group.id">
          <p class="group-label">
            <span>{{ group.label }}</span>
            <span class="count">{{ group.rows.length }}</span>
          </p>
          <div
            v-for="row in group.rows"
            :key="row.node.id"
            class="row-wrap"
            :style="{ paddingInlineStart: `${row.depth * 14}px` }"
          >
            <span v-if="row.node.kind === 'url'" class="item-icon" aria-hidden="true"><ShellIcon name="page" /></span>
            <span v-else class="item-icon folder" aria-hidden="true"><ShellIcon name="folder" /></span>
            <button
              v-if="row.node.kind === 'url'"
              type="button"
              class="item"
              :title="row.node.url"
              :disabled="busy"
              @click="open(row.node)"
            >{{ row.node.title }}</button>
            <!-- 文件夹本轮只展示（缩进 + 图标）：新建/拖动/重命名要等管理页，画成可点就是假 UI。 -->
            <span v-else class="item folder-label">{{ row.node.title }}</span>
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

      <p v-if="error" class="error" role="status">{{ error }}</p>
    </section>
  </div>
</template>

<style>
/* 与快捷设置一致：单文档、无滚动条跳动，外层只负责铺满视图。 */
.bookmarks-frame { box-sizing: border-box; width: 100%; height: 100vh; display: flex; align-items: flex-start; }

/*
 * 圆角 12、无外边框（与快捷设置/引擎面板同一套分层：inset 1px 描边，不投影——
 * 视图与面板同尺寸，投影只会变成一层被裁掉的「光影」）。
 */
.bookmarks {
  box-sizing: border-box;
  width: 100%;
  max-height: 100vh;
  overflow: auto;
  padding: 6px;
  border: 0;
  border-radius: 12px;
  box-shadow: inset 0 0 0 1px var(--stroke-divider);
  background: var(--surface-toolbar);
  font: var(--size-body)/1.4 var(--shell-font);
  color: var(--text-primary);
  scrollbar-gutter: stable;
}
.bookmarks *, .bookmarks *::before, .bookmarks *::after { box-sizing: border-box; }
.bookmarks :where(button) { font: inherit; color: inherit; border: 0; background: none; cursor: pointer; }
.bookmarks button:disabled { cursor: default; opacity: .55; }
.bookmarks button:focus-visible { outline: none; background: var(--surface-hover); }
.bookmarks button:focus:not(:focus-visible) { outline: none; }

.hub-head { display: flex; align-items: center; gap: 8px; padding: 2px 9px 2px; }
.hub-head h2 { margin: 0; font-size: 12px; font-weight: 600; }
.hub-count { font-size: 11px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.divider { height: 1px; margin: 5px 4px; background: var(--stroke-divider); }

.group-label {
  display: flex; align-items: center; gap: 6px;
  margin: 0; padding: 6px 9px 2px; font-size: 11px; color: var(--text-secondary);
}
.group-label .count { margin-inline-start: auto; font-variant-numeric: tabular-nums; }

/* 列表封顶滚动：收藏夹可以是几百条，但飞窗不该长成一整屏（与设置页规则列表同一做法）。 */
.lists { max-height: 340px; overflow-y: auto; scrollbar-gutter: stable; }
.empty { margin: 0; padding: 4px 9px 6px; font-size: 11px; line-height: 1.6; color: var(--text-secondary); }

.row-wrap {
  display: grid; grid-template-columns: 16px minmax(0, 1fr) 24px;
  align-items: center; gap: 6px;
  min-height: 28px; padding-inline: 9px 4px; border-radius: 7px;
}
.row-wrap:hover { background: var(--surface-hover); }
.item-icon { display: grid; place-items: center; color: var(--text-secondary); }
.item-icon .shell-icon { width: 13px; height: 13px; }
.item {
  min-width: 0; text-align: start; font-size: 12px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.folder-label { font-size: 12px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 行上的删除：平时淡出，悬停/键盘聚焦才亮起来（与标签关闭按钮同一手法）。 */
.bookmarks .row-remove {
  display: grid; place-items: center; width: 24px; height: 24px; padding: 0;
  border-radius: 5px; color: var(--text-secondary); opacity: 0;
}
.row-wrap:hover .row-remove, .bookmarks .row-remove:focus-visible { opacity: 1; }
.bookmarks .row-remove:hover:not(:disabled) { color: var(--text-primary); background: var(--surface-pressed); }
.bookmarks .row-remove .shell-icon { width: 13px; height: 13px; }
@media (forced-colors: active) { .bookmarks .row-remove { opacity: 1; } }

.error { margin: 6px 9px 2px; font-size: 11px; color: var(--text-error); }
</style>
