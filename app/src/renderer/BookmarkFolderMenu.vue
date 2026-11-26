<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { BOOKMARK_BAR_ROOT, childrenOf } from '../shared/bookmarks'
import type { BookmarkNode } from '../shared/bookmarks'
import ShellIcon from './ShellIcon.vue'
import { applyShellTheme, initialShellTheme } from './theme'
import { useBrowserStore } from './stores/browser'
import './overlay-panel.css'

/**
 * 收藏夹横条上**文件夹**的下拉菜单（Chromium 的 `BookmarkBarView::ShowFolderMenu`）。
 *
 * 为什么是飞窗而不是系统菜单：本机实测 `Menu.popup` 的系统菜单会**浮在别的应用之上**
 * （它是独立顶层窗口，失去激活也不收），而且主题/动画/点击外部收起都得另说一套。
 * 飞窗这套视图本来就是为"下拉伸进页面区会被页面视图压住"而存在的（见 `shared/overlay.ts`
 * 的 `QUICK_VIEWS` 说明），横条下拉用它才对得上既有做法（2026-11-27 反馈）。
 *
 * 与 Chromium 的一处**刻意差别**：原生菜单用悬停子菜单，这里用「进入 / 返回」——
 * 一只飞窗只画一层，悬停子菜单要么再叠一层卡片（几何/命中判定全得重做），要么让卡片越拉越长。
 * 文件夹通常只一两层，进入再返回是更稳的交互；返回行在顶部，位置固定。
 *
 * 打开的那一条走向与横条上的网址项一致：`open-bookmark`（地址取自库里、导航当前标签）。
 */
const props = defineProps<{ paused?: boolean }>()

const store = useBrowserStore()
const { snapshot } = storeToRefs(store)
const panel = ref<HTMLElement>()
const busy = ref(false)
const error = ref('')
/**
 * 进入子文件夹的路径；栈顶是当前显示的文件夹。
 *
 * 为什么用栈而不是单个 id：菜单允许一层层往下看（`进入 / 返回`），退回去要回到上一层，
 * 而不是回到横条上被点开的那个文件夹。
 */
const path = ref<string[]>([])
/** 横条上被点开的文件夹（`quick-opened.target` 带过来）。没有它就不该显示任何内容。 */
const rootId = ref<string>()

const nodes = computed<BookmarkNode[]>(() => snapshot.value?.bookmarks ?? [])
const currentId = computed(() => path.value[path.value.length - 1] ?? rootId.value ?? BOOKMARK_BAR_ROOT)
const currentNode = computed(() => nodes.value.find((node) => node.id === currentId.value))
const currentTitle = computed(() => currentNode.value?.title || '收藏夹')
const rows = computed<BookmarkNode[]>(() => childrenOf(nodes.value, currentId.value))
const canGoBack = computed(() => path.value.length > 1)

function faviconOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return snapshot.value?.favicons?.[new URL(url).origin]
  } catch {
    return undefined
  }
}

function openEntry(node: BookmarkNode): void {
  path.value = [...path.value, node.id]
  error.value = ''
  void nextTick(measure)
}

function goBack(): void {
  if (!canGoBack.value) return
  path.value = path.value.slice(0, -1)
  error.value = ''
  void nextTick(measure)
}

async function activate(node: BookmarkNode): Promise<void> {
  if (node.kind === 'folder') {
    openEntry(node)
    return
  }
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    // 地址由主进程按 id 从库里取（菜单拿不到任意导航能力）。
    if (!await store.run({ type: 'open-bookmark', id: node.id })) {
      error.value = store.message || '无法打开这条收藏'
      return
    }
    await window.baoOverlay.closeQuick(true)
  } finally {
    busy.value = false
  }
}

/* ---------------------------------------------------------------- *
 * 高度上报（与其它飞窗同一套：内容高度 + 去重，避免测量 ↔ 设 bounds 正反馈）
 * ---------------------------------------------------------------- */
let detach: (() => void) | undefined
let observer: ResizeObserver | undefined
let lastSentHeight = 0

function measure(): void {
  const element = panel.value
  if (!element) return
  const contentHeight = element.scrollHeight
  if (contentHeight < 24) return
  const next = contentHeight + 2
  if (Math.abs(next - lastSentHeight) < 1) return
  lastSentHeight = next
  void window.baoOverlay.resizeQuick(next)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    void window.baoOverlay.closeQuick(true)
  }
}

onMounted(() => {
  detach = window.baoOverlay.subscribe((event) => {
    if (event.type !== 'quick-opened' || event.view !== 'bookmark-folder') return
    applyShellTheme(event.theme)
    // 每次打开都从被点开的那个文件夹开始：同一条横条项重复点开时，上一次钻进去的层级要清掉。
    rootId.value = event.target
    path.value = event.target ? [event.target] : []
    lastSentHeight = 0
    void nextTick(measure)
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

// 内容变了（打开/进入/返回、别的窗口改了收藏）都要重测：视图高度按内容收敛。
watch([() => props.paused, rows, currentId], () => { void nextTick(measure) })
watch(() => snapshot.value?.theme, (theme) => { if (theme) applyShellTheme(theme) })

applyShellTheme(initialShellTheme())
</script>

<template>
  <div class="folder-frame" @keydown="onKeydown">
    <section
      id="bookmark-folder-menu"
      ref="panel"
      class="quick overlay-card folder-menu"
      role="menu"
      :aria-label="`${currentTitle} 里的收藏`"
    >
      <h2 class="overlay-title folder-head">
        <button
          v-if="canGoBack"
          type="button"
          class="folder-back"
          aria-label="返回上一级"
          @click="goBack"
        ><ShellIcon name="chevron" /></button>
        <span class="folder-title">{{ currentTitle }}</span>
        <span v-if="rows.length" class="folder-count">{{ rows.length }}</span>
      </h2>
      <div class="overlay-divider" role="presentation"></div>

      <button
        v-for="row in rows"
        :key="row.id"
        type="button"
        class="overlay-row folder-row"
        role="menuitem"
        :title="row.kind === 'folder' ? row.title : (row.url ?? row.title)"
        :disabled="busy"
        @click="activate(row)"
      >
        <span class="row-icon" aria-hidden="true">
          <img v-if="faviconOf(row.url)" class="favicon" :src="faviconOf(row.url)" alt="">
          <ShellIcon v-else :name="row.kind === 'folder' ? 'folder' : 'page'" />
        </span>
        <span class="row-title">{{ row.title }}</span>
        <ShellIcon v-if="row.kind === 'folder'" name="chevron" class="row-chevron" />
      </button>

      <p v-if="rows.length === 0" class="overlay-empty">这个文件夹是空的。</p>
      <p v-if="error" class="overlay-error" role="status">{{ error }}</p>
    </section>
  </div>
</template>

<style>
/* 视图比卡片大一圈（四周留透明边距画投影）：数值来自 OVERLAY_GUTTER，由宿主写成 CSS 变量。 */
.folder-frame {
  box-sizing: border-box;
  width: 100%;
  height: 100vh;
  padding: 0 var(--overlay-gutter-x, 12px) var(--overlay-gutter-bottom, 20px);
  display: flex;
  align-items: flex-start;
}
/* 菜单封顶滚动：一屏装不下的收藏再点进去，也比整条菜单长出窗口好。 */
.folder-menu { max-height: 420px; }

.folder-head { min-height: 22px; }
.folder-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.folder-count { margin-inline-start: auto; font-size: 11px; font-weight: 400; font-variant-numeric: tabular-nums; }
/* 返回按钮：与行同高同圆角，箭头转 90° 指向左（菜单的"上一级"方向）。 */
.folder-back {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border-radius: 4px;
  color: var(--text-secondary);
}
.folder-back:hover { background: var(--surface-hover); color: var(--text-primary); }
.folder-back .shell-icon { width: 12px; height: 12px; transform: rotate(90deg); }

/* 菜单行：图标 15、标题省略、子文件夹给一个右指箭头。 */
.folder-row { grid-template-columns: 16px minmax(0, 1fr) 14px; }
.folder-row .row-icon { display: grid; place-items: center; color: var(--text-secondary); }
.folder-row .row-icon .shell-icon { width: 14px; height: 14px; }
.folder-row .favicon { width: 16px; height: 16px; }
.folder-row .row-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.folder-row .row-chevron {
  width: 12px;
  height: 12px;
  color: var(--text-secondary);
  transform: rotate(-90deg);
}
</style>
