<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { BOOKMARK_BAR_ROOT, bookmarkForAddress, folderOptions } from '../shared/bookmarks'
import ShellIcon from './ShellIcon.vue'
import { applyShellTheme, initialShellTheme } from './theme'
import { useBrowserStore } from './stores/browser'
import './overlay-panel.css'

/**
 * 「编辑收藏夹」气泡（地址栏星标下方，Chromium 的 `BookmarkBubbleView`）。
 *
 * 与 Chromium 的关系（源码在 `chrome/browser/ui/views/bookmarks/bookmark_bubble_view.cc`）：
 * - 点星标时收藏**已经写进去了**（`BookmarkCurrentTab` → `AddIfNotBookmarked`），
 *   气泡只负责改名/换文件夹/删除——所以这里没有"创建"按钮，只有「完成」与「删除」；
 * - 字段是 名称 + 文件夹，按钮是 完成 + 删除；
 * - 初始焦点在名称输入框（`initially_focused_field = kBookmarkNameFieldId`），并全选，
 *   所以打开就能直接改名。
 *
 * 与本仓库产品决定的两处差异：
 * 1. **按钮顺序/主次**：Chromium 把「完成」当主按钮。但在这里点星标就已经收藏了，最常见的
 *    意图是"点错了，撤销"，所以「删除」放在最右、用危险色，「完成」退成次要按钮（2026-11-26 决定）。
 * 2. **保存时机**：Chromium 在气泡关闭时统一 `ApplyEdits()`；我们的气泡是独立文档、关闭由主进程
 *    发起，那一刻 `quick` 角色的命令权限已经失效，没法回写。所以改成"停顿 400 ms / 失焦 /
 *    点完成"就保存，用户不会因为点了下页面外面就丢掉刚改的名字。
 *
 * 文件夹是**下拉**（库里支持任意层文件夹，不只是两个根）；「更多」把同一只飞窗换到完整编辑器。
 */
const props = defineProps<{ paused?: boolean }>()

const TITLE_COMMIT_DELAY = 400

const store = useBrowserStore()
const { snapshot } = storeToRefs(store)
const panel = ref<HTMLElement>()
const titleField = ref<HTMLInputElement>()
const busy = ref(false)
const error = ref('')
const folderOpen = ref(false)
/**
 * 名称框的草稿只在**用户改过**之后才存在（`dirty`）。
 *
 * 为什么不"打开时把库里的名字拷进 ref"：飞窗文档比投影早一步就绪（点星标时先落库、
 * 再开气泡，而浮层可能这一刻才被 `window.open` 出来），任何"拷贝一次"的写法都会在
 * 数据还没到的时候拷到空串，然后靠 watcher 补救——实测补救不上，名称框会一直空着。
 * 直接把显示值算成"库里那条的名字"，数据什么时候到就什么时候显示。
 */
const draft = ref('')
const dirty = ref(false)
const titleModel = computed({
  get: () => dirty.value ? draft.value : (node.value?.title ?? ''),
  set: (value: string) => {
    draft.value = value
    dirty.value = true
    scheduleCommit()
  }
})

const active = computed(() => snapshot.value?.tabs.find((tab) => tab.id === snapshot.value?.activeId))
/** 气泡编辑的就是"当前地址那一本收藏"：星标刚加的那条，或早就存在的那条。 */
const node = computed(() => {
  const tab = active.value
  if (!tab || tab.internal) return undefined
  return bookmarkForAddress(snapshot.value?.bookmarks ?? [], tab.address)
})
const host = computed(() => {
  const address = active.value?.address ?? ''
  try {
    return new URL(address).host || address
  } catch {
    return address
  }
})
/** 可选的收藏位置（所有文件夹，两级缩进）；下拉与编辑器共用这一份，规则在 `folderOptions`。 */
const folders = computed(() => folderOptions(snapshot.value?.bookmarks ?? []))
const currentFolder = computed(() => {
  const parent = node.value?.parentId
  return folders.value.find((folder) => folder.id === parent) ?? folders.value[0]
})
const currentFolderLabel = computed(() => currentFolder.value?.title ?? '收藏夹栏')

let detach: (() => void) | undefined
let observer: ResizeObserver | undefined
let lastSentHeight = 0
let commitTimer: ReturnType<typeof setTimeout> | undefined

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

/** 打开时清掉草稿 → 名称框显示库里的名字；并像 Chromium 那样聚焦 + 全选。 */
function resetTitle(): void {
  error.value = ''
  dirty.value = false
  draft.value = ''
  folderOpen.value = false
  void nextTick(() => {
    const field = titleField.value
    if (!field) return
    field.focus({ preventScroll: true })
    field.select()
  })
}

/** 停顿 400 ms 自动保存：见文件头对「保存时机」那条说明。 */
function scheduleCommit(): void {
  clearTimeout(commitTimer)
  commitTimer = setTimeout(() => { void commitTitle() }, TITLE_COMMIT_DELAY)
}

async function commitTitle(): Promise<void> {
  clearTimeout(commitTimer)
  const target = node.value
  if (!target || !dirty.value) return
  const next = draft.value.trim()
  // 空名称不写：`renameBookmark` 会拒（Chromium 也拒绝把标题清空）。
  if (!next || next === target.title) {
    dirty.value = false
    return
  }
  if (await store.run({ type: 'update-bookmark', id: target.id, title: next })) {
    // 已经落库：回到"显示库里的名字"，之后的投影回写不会再被草稿盖住。
    dirty.value = false
  } else {
    error.value = store.message || '名称没有保存'
  }
}

async function chooseFolder(parentId: string): Promise<void> {
  const target = node.value
  folderOpen.value = false
  if (!target || busy.value || target.parentId === parentId) return
  busy.value = true
  error.value = ''
  try {
    if (!await store.run({ type: 'update-bookmark', id: target.id, parentId })) {
      error.value = store.message || '没有换到那个文件夹'
    }
  } finally {
    busy.value = false
  }
}

/** 「更多」：换到同一只飞窗的完整编辑器（名称 / URL / 文件夹树 / 新建文件夹）。 */
async function openEditor(): Promise<void> {
  await commitTitle()
  if (!await window.baoOverlay.openBookmarkEditor()) error.value = '打开编辑器失败'
}

async function done(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    await commitTitle()
    await window.baoOverlay.closeQuick(true)
  } finally {
    busy.value = false
  }
}

async function remove(): Promise<void> {
  const target = node.value
  if (!target || busy.value) return
  busy.value = true
  error.value = ''
  try {
    if (!await store.run({ type: 'remove-bookmark', id: target.id })) {
      error.value = store.message || '未能删除这条收藏'
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
  // 下拉展开时 Esc 先收下拉，再按一次才关气泡。
  if (folderOpen.value) {
    folderOpen.value = false
    return
  }
  void done()
}

onMounted(() => {
  detach = window.baoOverlay.subscribe((event) => {
    if (event.type === 'quick-opened' && event.view === 'bookmark-edit') {
      applyShellTheme(event.theme)
      lastSentHeight = 0
      resetTitle()
      void nextTick(measure)
    }
  })
  observer = new ResizeObserver(measure)
  if (panel.value) observer.observe(panel.value)
  store.connect()
  void nextTick(measure)
})

onBeforeUnmount(() => {
  clearTimeout(commitTimer)
  observer?.disconnect()
  detach?.()
  store.disconnect()
})

// 换页/换标签/收藏刚落地时把名称对齐到新目标（面板是常驻的，不会重新挂载）。
// 盯的是 **节点 id**：点星标时"收藏"先落库、气泡随后打开，数据可能比气泡晚一步到；
// 只要目标变了就清掉草稿，显示值由 `titleModel` 从库里的那条现算。
watch(() => node.value?.id, () => resetTitle())
watch([() => props.paused, () => folderOpen.value], () => { void nextTick(measure) })
watch(() => snapshot.value?.settings, () => { void nextTick(measure) })

applyShellTheme(initialShellTheme())
watch(() => snapshot.value?.theme, (theme) => { if (theme) applyShellTheme(theme) })
</script>

<template>
  <div class="bubble-frame" @keydown="onKeydown">
    <section id="bookmark-edit-panel" ref="panel" class="quick overlay-card bubble" role="dialog" aria-labelledby="bookmark-edit-title">
      <header class="bubble-head">
        <h2 id="bookmark-edit-title" class="overlay-title">编辑收藏夹</h2>
        <button type="button" class="bubble-close" aria-label="关闭" title="关闭" @click="done">
          <ShellIcon name="close" />
        </button>
      </header>

      <template v-if="node">
        <p class="bubble-site" :title="active?.address">
          <span class="site-icon" aria-hidden="true"><ShellIcon name="page" /></span>
          <span class="site-host">{{ host }}</span>
        </p>

        <div class="bubble-field">
          <label for="bookmark-name" class="overlay-label">名称</label>
          <input
            id="bookmark-name"
            ref="titleField"
            v-model="titleModel"
            class="overlay-input"
            type="text"
            autocomplete="off"
            spellcheck="false"
            @blur="commitTitle"
            @keydown.enter.prevent="done"
          >
        </div>

        <div class="bubble-field">
          <span id="bookmark-folder-label" class="overlay-label">文件夹</span>
          <!-- 下拉：库里可以有任意层文件夹，所以不是"两个根的二选一"。 -->
          <button
            type="button"
            class="overlay-input folder-trigger"
            role="combobox"
            aria-labelledby="bookmark-folder-label"
            aria-haspopup="listbox"
            :aria-expanded="folderOpen"
            :disabled="busy"
            @click="folderOpen = !folderOpen"
          >
            <ShellIcon name="folder" class="trigger-icon" />
            <span class="trigger-label">{{ currentFolderLabel }}</span>
            <ShellIcon name="chevron" class="trigger-chevron" />
          </button>
          <div v-if="folderOpen" class="folder-menu" role="listbox" aria-labelledby="bookmark-folder-label">
            <button
              v-for="folder in folders"
              :key="folder.id"
              type="button"
              role="option"
              class="overlay-row folder-option"
              :aria-selected="node.parentId === folder.id"
              :style="{ paddingInlineStart: `${9 + folder.depth * 14}px` }"
              @click="chooseFolder(folder.id)"
            >
              <ShellIcon name="folder" class="option-icon" />
              <span class="option-label">{{ folder.title }}</span>
              <ShellIcon name="check" class="check" />
            </button>
          </div>
        </div>

        <p v-if="error" class="overlay-error" role="status">{{ error }}</p>

        <footer class="bubble-actions">
          <!-- 「删除」在最右且用危险色：点星标就已经收藏了，最常见的意图是撤销。 -->
          <button type="button" class="overlay-button more" :disabled="busy" @click="openEditor">更多</button>
          <span class="actions-gap"></span>
          <button type="button" class="overlay-button" :disabled="busy" @click="done">完成</button>
          <button type="button" class="overlay-button danger" :disabled="busy" @click="remove">删除</button>
        </footer>
      </template>
      <p v-else class="overlay-empty">
        这个页面还没有收藏（可能刚在别处删除了）。点地址栏里的星标即可重新收藏。
      </p>
    </section>
  </div>
</template>

<style>
/* 只有"这一页独有"的排布留在这里；卡片、标题、行、输入框、按钮全部取共用类。 */
.bubble-frame { box-sizing: border-box; width: 100%; height: 100vh; display: flex; align-items: flex-start; }

.bubble-head { display: flex; align-items: center; gap: 6px; }
.bubble-head .overlay-title { flex: 1; }
.bubble-close {
  display: grid; place-items: center; width: 22px; height: 22px; padding: 0;
  border-radius: 5px; color: var(--text-secondary); flex: none;
}
.bubble-close:hover { color: var(--text-primary); background: var(--surface-hover); }
.bubble-close:focus-visible { outline: 2px solid var(--stroke-focus-ring); outline-offset: -1px; }
.bubble-close .shell-icon { width: 13px; height: 13px; }

/* 站点一行：只是"这是哪个站点的收藏"，名字在下面的输入框里。 */
.bubble-site { display: flex; align-items: center; gap: 6px; margin: 0; padding: 0 9px 4px; color: var(--text-secondary); }
.site-icon { display: grid; place-items: center; }
.site-icon .shell-icon { width: 13px; height: 13px; }
.site-host { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.bubble-field { display: grid; gap: 3px; padding: 0 6px 6px; }
.bubble-field .overlay-label { padding: 2px 3px 0; }
.bubble-field .overlay-input { width: 100%; }

/* 文件夹下拉：触发器长得像输入框（32px），展开后在原地铺一列可滚动的选项。 */
.folder-trigger {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr) 14px;
  align-items: center;
  gap: 6px;
  padding: 0 9px;
  text-align: start;
  font-size: 12px;
}
.folder-trigger:hover:not(:disabled) { background: var(--surface-hover); }
.folder-trigger[aria-expanded='true'] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.folder-trigger .trigger-icon { width: 14px; height: 14px; color: var(--text-secondary); }
.folder-trigger .trigger-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.folder-trigger .trigger-chevron { width: 14px; height: 14px; color: var(--text-secondary); }

.folder-menu {
  margin-top: 3px;
  max-height: 200px;
  overflow-y: auto;
  padding: 2px;
  border: 1px solid var(--stroke-divider);
  border-radius: 8px;
  background: var(--surface-toolbar);
  scrollbar-gutter: stable;
}
.folder-option { grid-template-columns: 14px minmax(0, 1fr) 14px; min-height: 30px; }
.folder-option .option-icon { width: 13px; height: 13px; color: var(--text-secondary); }
.folder-option .option-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.folder-option .check { width: 14px; height: 14px; color: var(--engine-accent); visibility: hidden; }
.folder-option[aria-selected='true'] .check { visibility: visible; }

.bubble-actions { display: flex; align-items: center; gap: 6px; padding: 2px 3px 2px; }
.bubble-actions .actions-gap { flex: 1; }

@media (forced-colors: active) {
  .folder-trigger[aria-expanded='true'] { outline: 2px solid Highlight; outline-offset: -2px; }
  .folder-option[aria-selected='true'] { outline: 1px solid Highlight; outline-offset: -1px; }
}
</style>
