<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { BOOKMARK_BAR_ROOT, bookmarkForAddress, folderOptions } from '../shared/bookmarks'
import ShellIcon from './ShellIcon.vue'
import { applyShellTheme, initialShellTheme } from './theme'
import { useBrowserStore } from './stores/browser'
import './overlay-panel.css'

/**
 * 完整编辑器（气泡里的「更多」，Chromium 的 `BookmarkEditor`）。
 *
 * 它和气泡的区别是**批量**：名称 / URL / 文件夹都在本地草稿里，点「保存」才一次写回；
 * 气泡是"改一点存一点"（它是从星标点开的，用户可能只想改个名字就走）。
 *
 * 与设置页、收藏夹树**共用同一份投影**（`BrowserState.bookmarks`）与同一套纯逻辑
 * （`folderOptions` / `titleFor`）：新增的文件夹立刻出现在树里，树里的删除也会让这里少一行。
 * 数据层没有第二份书签副本。
 *
 * 本轮能做的：改名、改地址、换文件夹、新建文件夹。没做（画出来点不动就是假 UI）：
 * 拖动排序、删除文件夹、导入/导出。
 */
const props = defineProps<{ paused?: boolean }>()

const store = useBrowserStore()
const { snapshot } = storeToRefs(store)
const panel = ref<HTMLElement>()
const busy = ref(false)
const error = ref('')
const titleDraft = ref('')
const urlDraft = ref('')
const folderDraft = ref<string>(BOOKMARK_BAR_ROOT)
const creating = ref(false)
const newFolderName = ref('')

const active = computed(() => snapshot.value?.tabs.find((tab) => tab.id === snapshot.value?.activeId))
const node = computed(() => {
  const tab = active.value
  if (!tab || tab.internal) return undefined
  return bookmarkForAddress(snapshot.value?.bookmarks ?? [], tab.address)
})
const folders = computed(() => folderOptions(snapshot.value?.bookmarks ?? []))

let detach: (() => void) | undefined
let observer: ResizeObserver | undefined
let lastSentHeight = 0

/** 与其它飞窗同一套高度上报（内容高度，去重后才发，避免「测量 ↔ 设 bounds」正反馈）。 */
function measure(): void {
  const element = panel.value
  if (element) {
    const contentHeight = element.scrollHeight
    if (contentHeight >= 40) {
      const next = contentHeight + 2
      if (Math.abs(next - lastSentHeight) >= 1) {
        lastSentHeight = next
        void window.baoOverlay.resizeQuick(next)
      }
    }
  }
}

/** 打开时把草稿对齐到库里那条：编辑器的语义是"保存才生效"，所以每次打开都重新取一次。 */
function resetDrafts(): void {
  error.value = ''
  creating.value = false
  newFolderName.value = ''
  titleDraft.value = node.value?.title ?? ''
  urlDraft.value = node.value?.url ?? active.value?.address ?? ''
  folderDraft.value = node.value?.parentId ?? BOOKMARK_BAR_ROOT
}

/** 新建文件夹：建好后直接选中它（用户点「新建」就是为了把这条放进去）。 */
async function createFolder(): Promise<void> {
  const title = newFolderName.value.trim()
  if (!title || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const parentId = folderDraft.value || BOOKMARK_BAR_ROOT
    if (!await store.run({ type: 'create-bookmark-folder', title, parentId })) {
      error.value = store.message || '文件夹没有建成'
      return
    }
    // 投影里已经有它了：按名字找到新节点并选中。
    const created = folderOptions(snapshot.value?.bookmarks ?? []).find((folder) => folder.title === title)
    if (created) folderDraft.value = created.id
    newFolderName.value = ''
    creating.value = false
    await nextTick()
    measure()
  } finally {
    busy.value = false
  }
}

/** 保存：只提交真正改过的字段（没改就不发命令，避免无意义的写与广播）。 */
async function save(): Promise<void> {
  const target = node.value
  if (!target || busy.value) return
  const title = titleDraft.value.trim()
  const url = urlDraft.value.trim()
  if (!title) {
    error.value = '名称不能为空'
    return
  }
  if (!url) {
    error.value = '地址不能为空'
    return
  }
  busy.value = true
  error.value = ''
  try {
    const changes: { id: string; title?: string; url?: string; parentId?: string } = { id: target.id }
    if (title !== target.title) changes.title = title
    if (url !== (target.url ?? '')) changes.url = url
    if (folderDraft.value && folderDraft.value !== target.parentId) changes.parentId = folderDraft.value
    if (changes.title !== undefined || changes.url !== undefined || changes.parentId !== undefined) {
      if (!await store.run({ type: 'update-bookmark', ...changes })) {
        error.value = store.message || '没有保存成功'
        return
      }
    }
    await window.baoOverlay.closeQuick(true)
  } finally {
    busy.value = false
  }
}

async function cancel(): Promise<void> {
  if (busy.value) return
  await window.baoOverlay.closeQuick(true)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  if (creating.value) {
    creating.value = false
    newFolderName.value = ''
    return
  }
  void cancel()
}

onMounted(() => {
  detach = window.baoOverlay.subscribe((event) => {
    if (event.type === 'quick-opened' && event.view === 'bookmark-editor') {
      applyShellTheme(event.theme)
      lastSentHeight = 0
      resetDrafts()
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

// 目标换了（换标签/刚收藏）就以库里的为准；正在输入的草稿不覆盖。
watch(() => node.value?.id, () => resetDrafts())
watch([() => props.paused, creating.value, () => folders.value.length], () => { void nextTick(measure) })
watch(() => snapshot.value?.settings, () => { void nextTick(measure) })

applyShellTheme(initialShellTheme())
watch(() => snapshot.value?.theme, (theme) => { if (theme) applyShellTheme(theme) })
</script>

<template>
  <div class="editor-frame" @keydown="onKeydown">
    <section id="bookmark-editor-panel" ref="panel" class="quick overlay-card editor" role="dialog" aria-labelledby="bookmark-editor-title">
      <header class="editor-head">
        <h2 id="bookmark-editor-title" class="overlay-title">编辑收藏夹</h2>
        <button type="button" class="editor-close" aria-label="关闭" title="关闭" @click="cancel">
          <ShellIcon name="close" />
        </button>
      </header>

      <template v-if="node">
        <div class="editor-field">
          <label for="editor-name" class="overlay-label">名称</label>
          <input id="editor-name" v-model="titleDraft" class="overlay-input" type="text" autocomplete="off" spellcheck="false">
        </div>

        <div class="editor-field">
          <label for="editor-url" class="overlay-label">URL</label>
          <input id="editor-url" v-model="urlDraft" class="overlay-input" type="url" autocomplete="off" spellcheck="false">
        </div>

        <div class="editor-field">
          <div class="folder-head">
            <span id="editor-folder-label" class="overlay-label">文件夹</span>
            <button type="button" class="overlay-button" :disabled="busy" @click="creating = !creating">
              {{ creating ? '取消新建' : '新建文件夹' }}
            </button>
          </div>
          <div v-if="creating" class="create-row">
            <input
              v-model="newFolderName"
              class="overlay-input"
              type="text"
              aria-label="新文件夹名称"
              placeholder="新文件夹名称"
              @keydown.enter.prevent="createFolder"
            >
            <button type="button" class="overlay-button primary" :disabled="busy || !newFolderName.trim()" @click="createFolder">添加</button>
          </div>
          <div class="folder-tree" role="radiogroup" aria-labelledby="editor-folder-label">
            <button
              v-for="folder in folders"
              :key="folder.id"
              type="button"
              role="radio"
              class="overlay-row folder-row"
              :aria-checked="folderDraft === folder.id"
              :style="{ paddingInlineStart: `${8 + folder.depth * 14}px` }"
              :disabled="busy"
              @click="folderDraft = folder.id"
            >
              <ShellIcon :name="folder.depth === 0 ? 'star' : 'folder'" class="folder-icon" />
              <span class="folder-label">{{ folder.title }}</span>
              <ShellIcon name="check" class="check" />
            </button>
          </div>
        </div>

        <p v-if="error" class="overlay-error" role="status">{{ error }}</p>

        <footer class="editor-actions">
          <button type="button" class="overlay-button" :disabled="busy" @click="cancel">取消</button>
          <button type="button" class="overlay-button primary" :disabled="busy" @click="save">保存</button>
        </footer>
      </template>
      <p v-else class="overlay-empty">
        这个页面还没有收藏（可能刚在别处删除了）。点地址栏里的星标即可重新收藏。
      </p>
    </section>
  </div>
</template>

<style>
/* 卡片/标题/标签/输入/行/按钮都取 `overlay-panel.css`；这里只留编辑器独有的排布。 */
.editor-frame {
  box-sizing: border-box;
  width: 100%;
  height: 100vh;
  /* 视图比卡片大一圈：四周（除顶边）留透明边距画投影。数值来自 OVERLAY_GUTTER，
     由 OverlayHost 写成 CSS 变量；透明边距里的鼠标由主进程转发给页面（见 shell-overlays.ts）。 */
  padding: 0 var(--overlay-gutter-x, 12px) var(--overlay-gutter-bottom, 20px);
  display: flex;
  align-items: flex-start;
}

.editor-head { display: flex; align-items: center; gap: 6px; }
.editor-head .overlay-title { flex: 1; }
.editor-close {
  display: grid; place-items: center; width: 22px; height: 22px; padding: 0;
  border-radius: 5px; color: var(--text-secondary); flex: none;
}
.editor-close:hover { color: var(--text-primary); background: var(--surface-hover); }
.editor-close:focus-visible { outline: 2px solid var(--stroke-focus-ring); outline-offset: -1px; }
.editor-close .shell-icon { width: 13px; height: 13px; }

.editor-field { display: grid; gap: 3px; padding: 0 4px 6px; }
.editor-field .overlay-label { padding: 2px 3px 0; }

/* 文件夹标题行右侧放「新建文件夹」——它作用的对象就是这棵树。 */
.folder-head { display: flex; align-items: center; gap: 6px; }
.folder-head .overlay-label { flex: 1; padding: 2px 3px 0; }

.create-row { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.create-row .overlay-input { flex: 1; min-width: 0; }

/* 树封顶滚动：文件夹多了编辑器不该长成一整屏（与收藏夹树同一做法）。 */
.folder-tree {
  max-height: 260px;
  overflow-y: auto;
  padding: 2px;
  border: 1px solid var(--stroke-divider);
  border-radius: 8px;
  scrollbar-gutter: stable;
}
.folder-row { grid-template-columns: 14px minmax(0, 1fr) 14px; min-height: 30px; }
.folder-row .folder-icon { width: 13px; height: 13px; color: var(--text-secondary); }
.folder-row .folder-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.folder-row .check { width: 14px; height: 14px; color: var(--engine-accent); visibility: hidden; }
.folder-row[aria-checked='true'] .check { visibility: visible; }

.editor-actions { display: flex; justify-content: flex-end; gap: 6px; padding: 2px 3px 2px; }

@media (forced-colors: active) {
  .folder-row[aria-checked='true'] { outline: 1px solid Highlight; outline-offset: -1px; }
}
</style>
