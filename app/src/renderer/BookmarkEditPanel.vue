<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { BOOKMARK_BAR_ROOT, BOOKMARK_OTHER_ROOT, bookmarkForAddress } from '../shared/bookmarks'
import type { BookmarkRootId } from '../shared/bookmarks'
import ShellIcon from './ShellIcon.vue'
import { applyShellTheme, initialShellTheme } from './theme'
import { useBrowserStore } from './stores/browser'

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
 * 与 Chromium 的一处**刻意的差异**：Chromium 在气泡关闭时统一 `ApplyEdits()`，而我们的气泡是
 * 独立文档，关闭动作由主进程发起（`set-quick(null)`），那一刻 `quick` 角色的命令权限已经失效，
 * 没法再回写。所以改成"停顿 400 ms / 失焦 / 点完成"就保存——比"关闭时保存"更保守：
 * 用户不会因为点了一下页面外面就丢掉刚改的名字。
 */
const props = defineProps<{ paused?: boolean }>()

const TITLE_COMMIT_DELAY = 400

const store = useBrowserStore()
const { snapshot } = storeToRefs(store)
const panel = ref<HTMLElement>()
const titleField = ref<HTMLInputElement>()
const busy = ref(false)
const error = ref('')
/**
 * 名称框的草稿只在**用户改过**之后才存在（`dirty`）。
 *
 * 为什么不是"打开时把库里的名字拷进 ref"：飞窗文档比投影早一步就绪（点星标时先落库、
 * 再开气泡，而浮层可能这一刻才被 `window.open` 出来），任何"拷贝一次"的写法都会在
 * 数据还没到的时候拷到一个空串，然后靠 watcher 补救——实测补救不上，名称框就一直空着。
 * 直接把显示值算成"库里那条的名字"，数据什么时候到就什么时候显示，没有中间状态。
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
const folders = computed<Array<{ id: BookmarkRootId; label: string }>>(() => {
  const nodes = snapshot.value?.bookmarks ?? []
  const label = (id: BookmarkRootId, fallback: string): string =>
    nodes.find((entry) => entry.id === id)?.title || fallback
  return [
    { id: BOOKMARK_BAR_ROOT, label: label(BOOKMARK_BAR_ROOT, '收藏夹栏') },
    { id: BOOKMARK_OTHER_ROOT, label: label(BOOKMARK_OTHER_ROOT, '其他收藏夹') }
  ]
})

let detach: (() => void) | undefined
let observer: ResizeObserver | undefined
let lastSentHeight = 0
let commitTimer: ReturnType<typeof setTimeout> | undefined

/** 与快捷设置同一套高度上报（内容高度，去重后才发，避免「测量 ↔ 设 bounds」正反馈）。 */
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

/** 打开时把草稿清掉 → 名称框直接显示"库里那条的名字"；并像 Chromium 那样聚焦 + 全选。 */
function resetTitle(): void {
  error.value = ''
  dirty.value = false
  draft.value = ''
  void nextTick(() => {
    const field = titleField.value
    if (!field) return
    field.focus({ preventScroll: true })
    field.select()
  })
}

/** 停顿 400 ms 自动保存：见文件头对「关闭时保存」那条差异的说明。 */
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
  if (!next) {
    dirty.value = false
    return
  }
  if (next === target.title) {
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

async function chooseFolder(parentId: BookmarkRootId): Promise<void> {
  const target = node.value
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
watch(() => props.paused, () => { void nextTick(measure) })
watch(() => snapshot.value?.settings, () => { void nextTick(measure) })

applyShellTheme(initialShellTheme())
watch(() => snapshot.value?.theme, (theme) => { if (theme) applyShellTheme(theme) })
</script>

<template>
  <div class="bubble-frame" @keydown="onKeydown">
    <section id="bookmark-edit-panel" ref="panel" class="quick bubble" role="dialog" aria-labelledby="bookmark-edit-title">
      <header class="bubble-head">
        <h2 id="bookmark-edit-title">编辑收藏夹</h2>
        <button type="button" class="bubble-close" aria-label="关闭" title="关闭" @click="done">
          <ShellIcon name="close" />
        </button>
      </header>

      <template v-if="node">
        <div class="page-line" :title="active?.address">
          <span class="page-icon" aria-hidden="true"><ShellIcon name="page" /></span>
          <span class="page-host">{{ host }}</span>
        </div>

        <div class="field">
          <label for="bookmark-name">名称</label>
          <input
            id="bookmark-name"
            ref="titleField"
            v-model="titleModel"
            type="text"
            autocomplete="off"
            spellcheck="false"
            @blur="commitTitle"
            @keydown.enter.prevent="done"
          >
        </div>

        <div class="field">
          <span id="bookmark-folder-label">文件夹</span>
          <div class="folders" role="radiogroup" aria-labelledby="bookmark-folder-label">
            <button
              v-for="folder in folders"
              :key="folder.id"
              type="button"
              role="radio"
              class="folder-option"
              :aria-checked="node.parentId === folder.id"
              :title="`保存到${folder.label}`"
              :disabled="busy"
              @click="chooseFolder(folder.id)"
            >{{ folder.label }}</button>
          </div>
        </div>

        <p v-if="error" class="error" role="status">{{ error }}</p>

        <footer class="bubble-actions">
          <button type="button" class="secondary" :disabled="busy" @click="remove">删除</button>
          <button type="button" class="primary" :disabled="busy" @click="done">完成</button>
        </footer>
      </template>
      <p v-else class="empty">
        这个页面还没有收藏（可能刚在别处删除了）。点地址栏里的星标即可重新收藏。
      </p>
    </section>
  </div>
</template>

<style>
.bubble-frame { box-sizing: border-box; width: 100%; height: 100vh; display: flex; align-items: flex-start; }

/* 与其它飞窗同一套分层：圆角 12 + inset 1px 描边，不投影（视图与面板同尺寸）。 */
.bubble {
  box-sizing: border-box;
  width: 100%;
  max-height: 100vh;
  overflow: auto;
  padding: 8px;
  border: 0;
  border-radius: 12px;
  box-shadow: inset 0 0 0 1px var(--stroke-divider);
  background: var(--surface-toolbar);
  font: var(--size-body)/1.4 var(--shell-font);
  color: var(--text-primary);
  scrollbar-gutter: stable;
}
.bubble *, .bubble *::before, .bubble *::after { box-sizing: border-box; }
.bubble :where(button) { font: inherit; color: inherit; border: 0; background: none; cursor: pointer; }
.bubble button:disabled { cursor: default; opacity: .55; }
.bubble button:focus-visible { outline: 2px solid var(--stroke-focus-ring); outline-offset: 1px; }

.bubble-head { display: flex; align-items: center; gap: 8px; padding: 0 2px 2px 4px; }
.bubble-head h2 { flex: 1; margin: 0; font-size: 12px; font-weight: 600; }
.bubble-close {
  display: grid; place-items: center; width: 22px; height: 22px; padding: 0;
  border-radius: 5px; color: var(--text-secondary); flex: none;
}
.bubble-close:hover { color: var(--text-primary); background: var(--surface-hover); }
.bubble-close .shell-icon { width: 13px; height: 13px; }

/* 顶部一行只放"这是哪个站点"：名字在下面的输入框里（Chromium 的气泡同样如此）。 */
.page-line { display: flex; align-items: center; gap: 6px; padding: 2px 4px 6px; color: var(--text-secondary); }
.page-icon { display: grid; place-items: center; }
.page-icon .shell-icon { width: 13px; height: 13px; }
.page-host { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.field { display: grid; gap: 3px; padding: 0 4px 8px; }
.field > label, .field > span { font-size: 11px; color: var(--text-secondary); }
.field input {
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--stroke-control);
  border-radius: 7px;
  background: var(--surface-toolbar);
  color: inherit;
  font: inherit;
  font-size: 12px;
}
.field input:focus {
  outline: none;
  border-color: var(--brand-stroke);
  box-shadow: inset 0 0 0 1px var(--brand-stroke);
}

.folders {
  display: flex; gap: 2px; padding: 2px;
  border: 1px solid var(--stroke-control); border-radius: 8px;
  background: color-mix(in srgb, var(--surface-page) 72%, var(--surface-toolbar));
}
.folder-option {
  flex: 1; min-width: 0; min-height: 24px; padding: 2px 6px; border-radius: 6px;
  font-size: 11px; color: var(--text-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.folder-option[aria-checked='true'] {
  color: var(--text-primary); font-weight: 600;
  background: var(--surface-toolbar);
  box-shadow: 0 1px 3px rgb(0 0 0 / 12%);
}
/* 档位是真正的表单控件：键盘焦点用 2px 环（与设置页的档位一致）。 */
.bubble .folder-option:focus-visible { outline: 2px solid var(--stroke-focus-ring); outline-offset: -2px; }

.bubble-actions { display: flex; justify-content: flex-end; gap: 6px; padding: 2px 4px 0; }
.bubble .secondary {
  min-height: 30px; padding: 2px 14px; border-radius: 7px;
  border: 1px solid var(--stroke-control); font-size: 12px;
}
.bubble .secondary:hover:not(:disabled) { background: var(--surface-hover); }
.bubble .primary {
  min-height: 30px; padding: 2px 16px; border-radius: 7px;
  font-size: 12px; font-weight: 600;
  color: var(--surface-toolbar);
  background: var(--accent);
}
.bubble .primary:hover:not(:disabled) { background: var(--accent-strong); }
@media (forced-colors: active) {
  .bubble .primary { background: Highlight; color: HighlightText; }
  .folder-option[aria-checked='true'] { outline: 1px solid Highlight; outline-offset: -1px; }
}

.empty { margin: 4px; font-size: 12px; line-height: 1.6; color: var(--text-secondary); }
.error { margin: 0 4px 6px; font-size: 11px; color: var(--text-error); }
</style>
