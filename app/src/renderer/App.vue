<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { TAB_BAR_HEIGHT, TOOLBAR_HEIGHT } from '../shared/browser'
import type { BrowserCommand, BrowserTab } from '../shared/browser'
import { engineLabels, engineSourceLabels, engineSwitchLabels, otherEngine } from '../shared/engine'
import type { OverlayBounds } from '../shared/overlay'
import {
  ENGINE_PANEL_INITIAL_HEIGHT, TOAST_HEIGHT, TOAST_WIDTH, flyoutBounds, panelBounds as enginePanelBounds
} from '../shared/overlay-geometry'
import type { FlyoutAnchor } from '../shared/overlay-geometry'
import ShellIcon from './ShellIcon.vue'
import { applyShellTheme } from './theme'
import { useBrowserStore } from './stores/browser'

const DRAG_THRESHOLD = 6

const shellStyle = {
  '--tab-bar-height': `${TAB_BAR_HEIGHT}px`,
  '--toolbar-height': `${TOOLBAR_HEIGHT}px`
}

const store = useBrowserStore()
const { snapshot: state, message, active } = storeToRefs(store)
const address = ref('')
const addressField = ref<HTMLInputElement>()
const tabStrip = ref<HTMLElement>()

interface TabDrag {
  id: number
  startX: number
  startY: number
  screenX: number
  screenY: number
  moved: boolean
}

let tabDrag: TabDrag | undefined
let suppressSelect = false
const draggingId = ref<number>()

watch([() => active.value?.id, () => active.value?.address], () => {
  address.value = active.value?.address ?? ''
  message.value = ''
})

watch(() => active.value?.id, () => {
  tabStrip.value?.querySelector('.selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}, { flush: 'post' })

watch(() => state.value?.theme, (theme) => {
  if (theme) applyShellTheme(theme)
})

function run(command: BrowserCommand): Promise<boolean> {
  return store.run(command)
}

const engineTitle = computed(() => {
  const tab = active.value
  if (!tab) return ''
  const current = `渲染引擎：${engineLabels[tab.engine]}`
  return tab.pinnedEngine
    ? `${current} · 站点已记住 ${engineLabels[tab.pinnedEngine]}`
    : `${current}（${engineSourceLabels[tab.engineSource]}）`
})
const switchLabel = computed(() => {
  const tab = active.value
  return tab ? engineSwitchLabels[otherEngine(tab.engine)] : ''
})

function switchEngine(): void {
  const tab = active.value
  if (!tab) return
  void run({ type: 'set-engine', engine: otherEngine(tab.engine) })
}

const enginePanelOpen = ref(false)
const engineTrigger = ref<HTMLButtonElement>()
const engineRoot = ref<HTMLElement>()
const toast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | undefined
let detachOverlay: (() => void) | undefined

/**
 * 齿轮快捷设置飞窗（M2 增量 2 下半）。
 *
 * 定位：顶边压在齿轮按钮下沿（0 缝）、右边缘与按钮对齐；横向与高度都交给主进程按窗口
 * 内容区夹取（`shell-overlays.ts` 的 `clampBounds`），所以飞窗**永远在窗口内**，内容超出
 * 时由面板自己滚动。宽 320 是 Chromium 菜单的常见宽度，外面留 16 px 给投影。
 */
/**
 * 飞窗挂在齿轮按钮下方：右边缘与按钮右缘对齐、顶边贴住按钮下沿。
 * 视图尺寸 = 面板尺寸（没有给投影预留的透明留白，否则会看到一条「光影」）。
 */
const QUICK_WIDTH = 320
const QUICK_INITIAL_HEIGHT = 320
const gearRoot = ref<HTMLButtonElement>()
const quickOpen = ref(false)

function quickBounds(): OverlayBounds | null {
  const rect = gearRoot.value?.getBoundingClientRect()
  if (!rect) return null
  return flyoutBounds(anchorOf(rect), QUICK_WIDTH, QUICK_INITIAL_HEIGHT)
}

/** 锚点：按钮右缘 + 按钮下缘——飞窗紧贴按钮展开（顶边不再落到工具栏下沿）。 */
function anchorOf(rect: { right: number; bottom: number }): FlyoutAnchor {
  return { anchorRight: rect.right, anchorBottom: rect.bottom, viewportWidth: window.innerWidth }
}

async function toggleQuick(): Promise<void> {
  if (quickOpen.value) {
    closeQuick(true)
    return
  }
  closeEnginePanel()
  const bounds = quickBounds()
  if (!bounds) return
  quickOpen.value = true
  if (!await window.baoOverlay.setQuick(bounds)) quickOpen.value = false
}

function closeQuick(restoreFocus = false): void {
  if (!quickOpen.value) return
  quickOpen.value = false
  // 外壳侧关闭走 `set-quick(null)`：`close-quick` 是飞窗自己（quick 角色）用来关闭并
  // 请求焦点归还的命令，外壳调用会被发送者校验拒绝。
  void window.baoOverlay.setQuick(null)
  if (restoreFocus) gearRoot.value?.focus()
}

function panelBounds(): OverlayBounds | null {
  const rect = engineRoot.value?.getBoundingClientRect()
  if (!rect) return null
  return enginePanelBounds(anchorOf(rect), ENGINE_PANEL_INITIAL_HEIGHT)
}

async function toggleEnginePanel(): Promise<void> {
  if (enginePanelOpen.value) {
    closeEnginePanel()
    return
  }
  closeQuick(false)
  const bounds = panelBounds()
  if (!bounds) return
  enginePanelOpen.value = true
  if (!await window.baoOverlay.setPanel(bounds)) enginePanelOpen.value = false
}

function closeEnginePanel(): void {
  if (!enginePanelOpen.value) return
  enginePanelOpen.value = false
  void window.baoOverlay.setPanel(null)
}

/** 网页与浮层有独立 WebContents；这里只处理外壳范围内的点击。 */
function onEnginePointerDown(event: PointerEvent): void {
  if (event.target instanceof Node && !engineTrigger.value?.contains(event.target)) closeEnginePanel()
  if (quickOpen.value && event.target instanceof Node && !gearRoot.value?.contains(event.target)) closeQuick(false)
}

function clearToast(): void {
  clearTimeout(toastTimer)
  toast.value = ''
}

function showToast(text: string): void {
  clearTimeout(toastTimer)
  toast.value = text
  const bounds = {
    x: 0,
    y: TAB_BAR_HEIGHT + TOOLBAR_HEIGHT,
    width: TOAST_WIDTH,
    height: TOAST_HEIGHT
  }
  void window.baoOverlay.setToast({ bounds, text })
  toastTimer = setTimeout(() => {
    clearToast()
    void window.baoOverlay.setToast(null)
  }, 6500)
}

watch(message, (text) => { if (text) showToast(text) })
let lastNoticeId = 0
watch(() => active.value?.notice, (notice) => {
  if (notice && notice.id > lastNoticeId) {
    lastNoticeId = notice.id
    showToast(notice.message)
  }
})
watch(() => active.value?.id, closeEnginePanel)
watch(() => active.value?.id, () => closeQuick(false))

function onShellResize(): void {
  // Close anchored settings rather than leave them detached from the trigger.
  closeEnginePanel()
  closeQuick(false)
}

onMounted(() => {
  detachOverlay = window.baoOverlay.subscribe((event) => {
    if (event.type === 'panel-closed') {
      enginePanelOpen.value = false
      if (event.restoreFocus) engineTrigger.value?.focus()
    } else if (event.type === 'quick-closed') {
      quickOpen.value = false
      if (event.restoreFocus) gearRoot.value?.focus()
    } else if (event.type === 'toast-closed') clearToast()
    else if (event.type === 'failure') showToast(event.text)
  })
  document.addEventListener('pointerdown', onEnginePointerDown, true)
  window.addEventListener('resize', onShellResize)
})
onBeforeUnmount(() => {
  detachOverlay?.()
  clearToast()
  document.removeEventListener('pointerdown', onEnginePointerDown, true)
  window.removeEventListener('resize', onShellResize)
})

/** 拖出窗口（架构 §3「拖出窗口」）：指针捕获保证移出窗口后仍能拿到释放点。 */
function startTabDrag(tab: BrowserTab, event: PointerEvent): void {
  suppressSelect = false
  if (event.button !== 0) return
  if ((event.target as HTMLElement | null)?.closest('.close-tab')) return
  tabDrag = {
    id: tab.id,
    startX: event.screenX,
    startY: event.screenY,
    screenX: event.screenX,
    screenY: event.screenY,
    moved: false
  }
  draggingId.value = tab.id
  try {
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  } catch {
    // 合成事件或指针已释放：不阻断拖动逻辑
  }
}

function moveTabDrag(event: PointerEvent): void {
  if (!tabDrag) return
  tabDrag.screenX = event.screenX
  tabDrag.screenY = event.screenY
  if (!tabDrag.moved &&
      Math.hypot(event.screenX - tabDrag.startX, event.screenY - tabDrag.startY) >= DRAG_THRESHOLD) {
    tabDrag.moved = true
  }
}

async function endTabDrag(event: PointerEvent): Promise<void> {
  const drag = tabDrag
  tabDrag = undefined
  draggingId.value = undefined
  const target = event.currentTarget
  if (target instanceof HTMLElement) {
    try {
      target.releasePointerCapture(event.pointerId)
    } catch {
      // 捕获已释放
    }
  }
  if (!drag?.moved) return
  suppressSelect = true
  const screenX = event.screenX || drag.screenX
  const screenY = event.screenY || drag.screenY
  const index = dropIndex(screenX, screenY)
  if (index !== undefined) {
    await run({ type: 'move', id: drag.id, index })
    return
  }
  await run({ type: 'tearoff', id: drag.id, screenX, screenY })
}

function selectTab(tab: BrowserTab, event: MouseEvent): void {
  if ((event.target as HTMLElement | null)?.closest('.close-tab')) return
  if (suppressSelect) {
    suppressSelect = false
    return
  }
  void run({ type: 'select', id: tab.id })
}

/** 中键关闭（Chrome 式目标，架构 §3 商标交互）。 */
function onTabAuxClick(tab: BrowserTab, event: MouseEvent): void {
  if (event.button !== 1) return
  event.preventDefault()
  void run({ type: 'close', id: tab.id })
}

/** 双击标签栏空白处新建标签。 */
function onStripDoubleClick(event: MouseEvent): void {
  if ((event.target as HTMLElement | null)?.closest('.tab')) return
  // 标签栏空白双击在 Chrome 里是新建标签页，这里保持；窗口最大化只走标题栏其余空白处。
  event.stopPropagation()
  void addTab()
}

/** 方向键切换标签：切完把焦点留在标签栏，才能连续用方向键浏览（审计 P2）。 */
async function cycleTab(step: number): Promise<void> {
  const list = state.value?.tabs ?? []
  if (list.length < 2) return
  const current = list.findIndex((tab) => tab.id === active.value?.id)
  const next = (current + step + list.length) % list.length
  await run({ type: 'select', id: list[next].id })
  await nextTick()
  const strip = tabStrip.value
  const selected = strip?.querySelector<HTMLElement>('.tab.selected .tab-title')
  selected?.focus()
}

/** 双击标题栏最大化/还原：系统按钮只管点击，双击语义要自己转发（A5）。 */
function onTitlebarDoubleClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null
  // 标签、按钮上双击有自己的语义，不触发窗口最大化。
  if (target?.closest('.tab, button, input')) return
  void window.baoWindowControl.toggleMaximize()
}

function onTabStripKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  void cycleTab(event.key === 'ArrowRight' ? 1 : -1)
}

/** 指针被系统取消（触摸被抢走、手势中断等）：丢弃这次拖动，不提交排序或拖出。 */
function cancelTabDrag(event: PointerEvent): void {
  if (!tabDrag) return
  tabDrag = undefined
  draggingId.value = undefined
  suppressSelect = true
  const target = event.currentTarget
  if (target instanceof HTMLElement) {
    try {
      target.releasePointerCapture(event.pointerId)
    } catch {
      // 捕获已释放
    }
  }
}

/** 释放点在标签栏内时给出目标序号；栏外（横或纵）返回 undefined，交给 tearoff 判定。 */
function dropIndex(screenX: number, screenY: number): number | undefined {
  const strip = tabStrip.value
  if (!strip) return undefined
  const rect = strip.getBoundingClientRect()
  const clientX = screenX - window.screenX
  const clientY = screenY - window.screenY
  // 审计 P2：原实现只看 X，竖直拖出会被当成排序。两个轴都要在标签栏范围内。
  if (clientY < rect.top - 4 || clientY > rect.bottom + 4) return undefined
  if (clientX < rect.left - 4 || clientX > rect.right + 4) return undefined
  const items = [...strip.querySelectorAll<HTMLElement>('.tab')]
  let index = 0
  for (const [position, item] of items.entries()) {
    const box = item.getBoundingClientRect()
    if (clientX >= box.left + box.width / 2) index = position + 1
  }
  return index
}

async function addTab(): Promise<void> {
  await run({ type: 'add' })
  await nextTick()
  addressField.value?.focus()
}

applyShellTheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')

onMounted(() => store.connect())
onBeforeUnmount(() => store.disconnect())
</script>

<template>
  <header class="shell" :style="shellStyle">
    <div class="titlebar" @dblclick="onTitlebarDoubleClick">

      <div
        ref="tabStrip"
        class="tabs"
        aria-label="标签页"
        @dblclick="onStripDoubleClick"
        @keydown="onTabStripKeydown"
      >
        <div
          v-for="(tab, index) in state?.tabs"
          :key="tab.id"
          class="tab"
          :class="{ selected: tab.id === active?.id, crashed: tab.crashed, dragging: tab.id === draggingId, pinned: tab.pinned, muted: tab.muted }"
          @pointerdown="startTabDrag(tab, $event)"
          @pointermove="moveTabDrag"
          @pointerup="endTabDrag"
          @pointercancel="cancelTabDrag"
          @click="selectTab(tab, $event)"
          @auxclick="onTabAuxClick(tab, $event)"
          @contextmenu.prevent="run({ type: 'tab-menu', id: tab.id })"
        >
          <span v-if="index > 0" class="tab-separator" aria-hidden="true"></span>
          <button
            type="button"
            class="tab-title"
            :aria-pressed="tab.id === active?.id"
            :aria-busy="tab.loading"
            :title="tab.title"
          >
            <span v-if="tab.internal" class="site-icon settings-icon" aria-hidden="true"><ShellIcon name="gear" /></span>
            <span v-else class="glyph page site-icon" :class="{ loading: tab.loading }" aria-hidden="true"></span>
            <span v-if="!tab.pinned" class="tab-label">{{ tab.title }}</span>
            <span v-if="tab.muted" class="muted-mark" aria-hidden="true">
              <svg viewBox="0 0 16 16">
                <path d="M8.6 2.6v10.8L5.3 10.5H2.6V5.5h2.7L8.6 2.6Z" fill="currentColor" />
                <path d="m10.6 6.2 3 3.6m0-3.6-3 3.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </svg>
            </span>
          </button>
          <button
            v-if="!tab.pinned"
            type="button"
            class="icon-button close-tab"
            :aria-label="`关闭标签页：${tab.title}`"
            @click="run({ type: 'close', id: tab.id })"
          ><span class="glyph cross" aria-hidden="true"></span></button>
        </div>
      </div>
      <div class="add-tab-slot">
        <button type="button" class="icon-button add-tab" aria-label="新建标签页" @click="addTab"><span class="glyph plus" aria-hidden="true"></span></button>
      </div>
    </div>

    <form class="toolbar" aria-label="导航工具栏" @submit.prevent="run({ type: 'navigate', address })">
      <button
        type="button"
        class="icon-button"
        title="后退"
        aria-label="后退"
        :disabled="!active?.canGoBack"
        @click="run({ type: 'back' })"
      ><span class="glyph arrow" aria-hidden="true"></span></button>
      <button
        type="button"
        class="icon-button"
        title="前进"
        aria-label="前进"
        :disabled="!active?.canGoForward"
        @click="run({ type: 'forward' })"
      ><span class="glyph arrow forward" aria-hidden="true"></span></button>
      <button
        type="button"
        class="icon-button"
        title="重新加载"
        aria-label="重新加载"
        :disabled="!active"
        @click="run({ type: 'reload' })"
      ><span class="glyph refresh" aria-hidden="true"></span></button>
      <div class="address-bar">
        <input
          ref="addressField"
          v-model="address"
          aria-label="地址栏"
          placeholder="输入网址"
          autocomplete="off"
          spellcheck="false"
        >
      </div>
      <div v-if="active && !active.internal" ref="engineRoot" class="engine-pill" role="group" aria-label="渲染引擎">
        <button type="button" class="engine-switch" role="switch"
          :aria-checked="active.engine === 'ruffle'" :aria-label="switchLabel" :title="engineTitle" @click="switchEngine">
          <span class="engine-mark" :class="active.pinnedEngine && active.pinnedEngine !== active.engine ? 'overridden' : active.engine" aria-hidden="true">
            <ShellIcon v-if="active.pinnedEngine" name="lock" />
            <span v-else class="engine-dot"></span>
          </span>
          {{ active.engine === 'ruffle' ? 'Ruffle' : 'Flash' }}
        </button>
        <button ref="engineTrigger" type="button" class="engine-more" :aria-expanded="enginePanelOpen"
          aria-haspopup="dialog" aria-label="引擎设置" title="引擎设置" @click="toggleEnginePanel">
          <ShellIcon name="chevron" />
        </button>
      </div>
      <button
        ref="gearRoot"
        type="button"
        class="icon-button gear-button"
        :aria-expanded="quickOpen"
        aria-haspopup="dialog"
        aria-label="快捷设置"
        title="快捷设置"
        @click="toggleQuick"
      ><ShellIcon name="gear" /></button>
    </form>
  </header>  <p class="sr-only" role="status">{{ toast }}</p>
  <main v-if="active?.error" class="page-error" aria-labelledby="page-error-title">
    <div>
      <ShellIcon name="error" />
      <h1 id="page-error-title">{{ active.error }}</h1>
      <button type="button" class="page-retry" @click="run({ type: 'reload' })">重试</button>
    </div>
  </main>
</template>

<style>
:root {
  font: var(--size-body)/1.4 var(--shell-font);
  color: var(--text-primary);
  background: var(--surface-page);
}

* { box-sizing: border-box; }
body { margin: 0; }
button, input { font: inherit; color: inherit; }
button { border: 0; background: transparent; }
button:not(:disabled) { cursor: pointer; }
button:focus-visible { outline: 2px solid var(--stroke-focus-ring); outline-offset: 1px; }

.titlebar {
  display: flex;
  align-items: center;
  gap: var(--space-s);
  height: var(--tab-bar-height);
  padding-inline: var(--space-s) calc(100vw - env(titlebar-area-width, calc(100vw - 144px)) + 36px);
  background: var(--surface-window);
  -webkit-app-region: drag;
  user-select: none;
}

.tabs {
  display: flex;
  align-self: end;
  padding-inline: var(--tab-foot);
  scroll-padding-inline: var(--tab-foot);
  min-width: 0;
  width: max-content;
  overflow-x: auto;
  scrollbar-width: none;
  -webkit-app-region: no-drag;
}

.tab {
  position: relative;
  isolation: isolate;
  display: flex;
  align-items: center;
  flex: 0 1 180px;
  min-width: 88px;
  width: 180px;
  height: var(--tab-height);
  padding-inline-end: var(--space-xs);
  border: var(--shell-stroke) solid transparent;
  border-bottom: 0;
  border-radius: var(--tab-radius) var(--tab-radius) 0 0;
  color: var(--text-secondary);
  font-size: var(--size-caption);
}

.tab:hover { background: var(--surface-hover); }
/* 标签之间的小竖线：选中/悬停时让位（Edge、Chrome 同款处理） */
.tab-separator {
  position: absolute;
  left: -0.5px;
  top: 50%;
  translate: 0 -50%;
  width: 1px;
  height: 16px;
  /* 比 --stroke-divider（Fluent stroke2）深一档：直接用它几乎看不见 */
  background: color-mix(in srgb, var(--text-primary) 30%, transparent);
  pointer-events: none;
}
.tab.selected .tab-separator,
.tab:hover .tab-separator,
.tab.selected + .tab .tab-separator,
.tab:hover + .tab .tab-separator { opacity: 0; }
.tab.dragging { opacity: .6; }
.tab.selected {
  z-index: 1;
  color: inherit;
  background: transparent;
}

.tab.selected::before,
.tab.selected::after {
  /* One contour for the sides and feet keeps the open bottom free of seams. */
  --inset: 0px;
  --side: calc(var(--tab-foot) + var(--inset));
  --foot-radius: calc(var(--tab-foot) + var(--inset));
  --top-radius: calc(var(--tab-radius) - var(--inset));
  --top-join: calc(var(--tab-foot) + var(--tab-radius));

  position: absolute;
  z-index: -1;
  inset: calc(-1 * var(--shell-stroke)) calc(-1 * (var(--tab-foot) + var(--shell-stroke))) 0;
  pointer-events: none;
  background: var(--tab-outline, var(--stroke-divider));
  content: "";
  clip-path: shape(
    from 0 calc(100% + var(--inset)),
    arc to var(--side) calc(100% - var(--tab-foot)) of var(--foot-radius) ccw,
    line to var(--side) var(--tab-radius),
    arc to var(--top-join) var(--inset) of var(--top-radius) cw,
    hline to calc(100% - var(--top-join)),
    arc to calc(100% - var(--side)) var(--tab-radius) of var(--top-radius) cw,
    line to calc(100% - var(--side)) calc(100% - var(--tab-foot)),
    arc to 100% calc(100% + var(--inset)) of var(--foot-radius) ccw,
    close
  );
}

.tab.selected::after {
  --inset: var(--shell-stroke);
  background: var(--surface-toolbar);
}

.tab-title {
  display: flex;
  align-items: center;
  gap: var(--space-s);
  flex: 1;
  min-width: 0;
  height: 100%;
  text-align: start;
  padding: 0 var(--space-xs) 0 var(--space-m);
  border-radius: var(--tab-radius) 0 0 0;
}

.tab.selected .tab-title { font-weight: 600; }
.tab-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.site-icon { color: var(--text-secondary); }
.settings-icon { display: inline-flex; align-items: center; }
.settings-icon .shell-icon { width: 14px; height: 14px; }
.tab.selected .site-icon { color: var(--brand-stroke); }
.tab.crashed .site-icon { color: var(--text-error); }
.glyph.page.loading::before { inset: 2px; border-radius: 50%; border-inline-end-color: transparent; }
.glyph.page.loading::after { content: none; }

@media (prefers-reduced-motion: no-preference) {
  .tab, .icon-button { transition: background-color var(--motion-fast) ease; }
  .address-bar { transition: border-color var(--motion-normal) ease; }
}

.icon-button {
  display: grid;
  place-items: center;
  flex: none;
  width: 32px;
  height: 32px;
  padding: 0;
  border-radius: var(--button-radius);
  color: var(--text-secondary);
  -webkit-app-region: no-drag;
}

.icon-button:hover:not(:disabled) { color: inherit; background: var(--surface-hover); }
.icon-button:disabled { color: var(--text-disabled); }
/* 齿轮：打开时保持按下色，与飞窗形成「同一块」的视觉延续。 */
.gear-button { margin-inline-start: 2px; }
.gear-button[aria-expanded='true'] { color: var(--text-primary); background: var(--surface-pressed); }
.close-tab { width: 22px; height: 22px; opacity: 0; }

/* 固定标签（架构 §3「标签操作」）：只留站点图标，排在最左，没有关闭按钮。 */
.tab.pinned { flex: 0 0 auto; min-width: 0; width: 44px; }
.tab.pinned .tab-title { padding: 0; justify-content: center; border-radius: calc(var(--tab-radius) - var(--inset)); }
.tab.pinned .muted-mark { position: absolute; right: 7px; bottom: 5px; }

/* 静音标记：与站点图标同色的喇叭加斜杠。 */
.muted-mark { display: inline-flex; align-items: center; color: var(--text-secondary); }
.muted-mark svg { width: 12px; height: 12px; }
.tab.selected .muted-mark { color: var(--brand-stroke); }
.tab:hover .close-tab,
.tab.selected .close-tab,
.tab:focus-within .close-tab { opacity: 1; }
@media (forced-colors: active) { .close-tab { opacity: 1; } }
.tab:not(.selected) .close-tab:hover {
  color: var(--text-primary);
  background: var(--surface-pressed);
}

.add-tab-slot {
  display: grid;
  align-items: center;
  align-self: end;
  flex: none;
  height: var(--tab-height);
  border-block-start: var(--shell-stroke) solid transparent;
}
.add-tab { width: var(--new-tab-button-size); height: var(--new-tab-button-size); }

.glyph {
  position: relative;
  display: inline-block;
  flex: none;
  width: 16px;
  height: 16px;
}
.glyph::before, .glyph::after { position: absolute; content: ""; }
.glyph.plus::before, .glyph.cross::before { inset: 7px 2px; background: currentColor; }
.glyph.plus::after, .glyph.cross::after { inset: 2px 7px; background: currentColor; }
.glyph.cross { width: 14px; height: 14px; transform: rotate(45deg); }
.glyph.cross::before { inset: 6px 2px; }
.glyph.cross::after { inset: 2px 6px; }
.glyph.arrow::before { top: 7px; left: 2px; width: 12px; border-top: 1.5px solid; }
.glyph.arrow::after {
  top: 4px;
  left: 2px;
  width: 7px;
  height: 7px;
  border-top: 1.5px solid;
  border-left: 1.5px solid;
  transform: rotate(-45deg);
}
.glyph.forward { transform: rotate(180deg); }
.glyph.page::before { inset: 2px 3px; border: 1.5px solid; border-radius: 2px; }
.glyph.page::after { inset: 6px 5px auto; border-top: 1px solid; }
.glyph.refresh::before { inset: 2px; border: 1.5px solid; border-right-color: transparent; border-radius: 50%; }
.glyph.refresh::after { top: 2px; right: 1px; width: 5px; height: 5px; border-right: 1.5px solid; border-bottom: 1.5px solid; }

.toolbar {
  display: flex;
  align-items: center;
  gap: var(--nav-gap);
  height: var(--toolbar-height);
  padding: 0 var(--space-s);
  background: var(--surface-toolbar);
  border-bottom: var(--shell-stroke) solid var(--stroke-divider);
}

.address-bar {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  height: 32px;
  margin-inline-start: var(--space-xs);
  padding: 0 var(--space-m);
  border: var(--shell-stroke) solid var(--stroke-control);
  border-radius: var(--address-radius);
  background: var(--surface-toolbar);
}
.address-bar:focus-within {
  background: var(--surface-toolbar);
  border-color: var(--brand-stroke);
  box-shadow: inset 0 0 0 1px var(--brand-stroke);
}
.address-bar input { flex: 1; width: 0; padding: 0; border: 0; outline: none; background: transparent; }
.address-bar input::placeholder { color: var(--text-secondary); opacity: 1; }
.engine-pill {
  flex: none;  display: grid;
  grid-template-columns: 66px 25px;
  /* 与地址栏、图标按钮同高（32px），工具栏看起来才是一条线 */
  height: 32px;
  margin-inline-start: 3px;
  border: 1px solid var(--stroke-control);
  border-radius: var(--radius-pill);
  background: linear-gradient(var(--surface-toolbar), var(--surface-page));
  -webkit-app-region: no-drag;
}
.engine-pill button { display: flex; align-items: center; padding: 0; }
.engine-pill button:hover, .engine-more[aria-expanded='true'] { background: var(--surface-hover); }
.engine-switch {
  gap: 5px;
  padding-inline-start: 8px !important;
  border-radius: var(--radius-pill) 0 0 var(--radius-pill);
  font-size: 12px;
  font-weight: 650;
}
.engine-more {
  position: relative;
  justify-content: center;
  color: var(--text-secondary);
  border-radius: 0 var(--radius-pill) var(--radius-pill) 0;
}
.engine-more::before { content: ''; position: absolute; left: 0; height: 12px; border-left: 1px solid var(--stroke-divider); }
.engine-more .shell-icon, .engine-mark .shell-icon { width: 12px; height: 12px; }
.engine-more[aria-expanded='true'] .shell-icon { transform: rotate(180deg); }
.engine-mark { width: 13px; height: 13px; flex: none; display: grid; place-items: center; }
.engine-mark.ppapi { color: var(--engine-flash); }
.engine-mark.ruffle { color: var(--engine-ruffle); }
.engine-mark.overridden { color: var(--engine-override); }
.engine-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.sr-only { position: absolute; width: 1px; height: 1px; margin: 0; overflow: hidden; clip-path: inset(50%); }
.page-error { min-height: calc(100vh - var(--tab-bar-height) - var(--toolbar-height)); display: grid; place-items: center; text-align: center; padding: 24px; }
.page-error .shell-icon { width: 24px; height: 24px; color: var(--text-error); }
.page-error h1 { margin: 6px 0 10px; font-size: 16px; }
.page-retry { padding: 4px 12px; border: 1px solid var(--stroke-control); border-radius: 7px; color: var(--engine-accent); background: var(--engine-selection); }
.page-retry:hover { background: var(--surface-hover); }

@media (forced-colors: active) {
  .tab.selected { --tab-outline: Highlight; }
  .tab.selected::before, .tab.selected::after { forced-color-adjust: none; }
  .tab.selected::after { background: Canvas; }
  .address-bar:focus-within { outline: 2px solid Highlight; outline-offset: -2px; }
}
</style>
