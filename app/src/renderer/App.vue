<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { TAB_BAR_HEIGHT, TOOLBAR_HEIGHT } from '../shared/browser'
import type { BrowserCommand, BrowserTab } from '../shared/browser'
import type { BrowserEngine } from '../shared/engine'
import { engineLabels, engineSourceLabels, engineSwitchLabels, otherEngine } from '../shared/engine'
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

function run(command: BrowserCommand): Promise<void> {
  return store.run(command)
}

/** 引擎指示与切换（架构 §3 引擎）：胶囊开关，手动切换后可以记住为站点规则。 */
const engineTitle = computed(() => {
  const tab = active.value
  return tab ? `渲染引擎：${engineLabels[tab.engine]}（${engineSourceLabels[tab.engineSource]}）` : ''
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

/**
 * 四档选择（架构 §3 引擎）：前两档 Flash、后两档 Ruffle，带锁的档会写成站点规则。
 * 「已锁定」以 `engineSource === 'site-rule'` 判定；默认与手动切换都算未锁定。
 */
const engineOptions = computed(() => {
  const tab = active.value
  const pinned = tab?.engineSource === 'site-rule'
  // 起始页 / about:blank 没有站点可记，锁定档置灰（否则会收到 no-site 错误）。
  const canPin = !!tab?.address
  return [
    { key: 'lock-ppapi', engine: 'ppapi' as const, lock: true, label: '锁定 Flash', disabled: !canPin, selected: !!tab && tab.engine === 'ppapi' && pinned },
    { key: 'ppapi', engine: 'ppapi' as const, lock: false, label: 'Flash', disabled: false, selected: !!tab && tab.engine === 'ppapi' && !pinned },
    { key: 'ruffle', engine: 'ruffle' as const, lock: false, label: 'Ruffle', disabled: false, selected: !!tab && tab.engine === 'ruffle' && !pinned },
    { key: 'lock-ruffle', engine: 'ruffle' as const, lock: true, label: '锁定 Ruffle', disabled: !canPin, selected: !!tab && tab.engine === 'ruffle' && pinned }
  ]
})

/** 外圈：已锁定 = 固定镀层；规则被手动覆盖 = 琥珀色。 */
const ringState = computed(() => {
  const tab = active.value
  if (!tab) return ''
  if (tab.engineSource === 'site-rule') return 'locked'
  if (tab.pinnedEngine && tab.pinnedEngine !== tab.engine) return 'overridden'
  return ''
})

const enginePanelOpen = ref(false)
const engineRoot = ref<HTMLElement | null>(null)

function toggleEnginePanel(): void {
  enginePanelOpen.value = !enginePanelOpen.value
}

function closeEnginePanel(): void {
  enginePanelOpen.value = false
}

function chooseEngineMode(option: { engine: BrowserEngine; lock: boolean }): void {
  enginePanelOpen.value = false
  void run({ type: 'engine-mode', engine: option.engine, lock: option.lock })
}

/** 点面板外关闭（捕获阶段，避免被标签栏的指针手势吞掉）。 */
function onEnginePointerDown(event: PointerEvent): void {
  if (!enginePanelOpen.value) return
  const root = engineRoot.value
  if (root && event.target instanceof Node && !root.contains(event.target)) closeEnginePanel()
}

watch(() => active.value?.id, () => closeEnginePanel())
onMounted(() => document.addEventListener('pointerdown', onEnginePointerDown, true))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onEnginePointerDown, true))

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
  const index = dropIndex(screenX)
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
  void addTab()
}

function cycleTab(step: number): void {
  const list = state.value?.tabs ?? []
  if (list.length < 2) return
  const current = list.findIndex((tab) => tab.id === active.value?.id)
  const next = (current + step + list.length) % list.length
  void run({ type: 'select', id: list[next].id })
}

function onTabStripKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  cycleTab(event.key === 'ArrowRight' ? 1 : -1)
}

/** 释放点在标签栏内时给出目标序号；在栏外返回 undefined（交给 tearoff 判定）。 */
function dropIndex(screenX: number): number | undefined {
  const strip = tabStrip.value
  if (!strip) return undefined
  const rect = strip.getBoundingClientRect()
  const clientX = screenX - window.screenX
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
    <div class="titlebar">

      <div
        ref="tabStrip"
        class="tabs"
        aria-label="标签页"
        @dblclick="onStripDoubleClick"
        @keydown="onTabStripKeydown"
      >
        <div
          v-for="tab in state?.tabs"
          :key="tab.id"
          class="tab"
          :class="{ selected: tab.id === active?.id, crashed: tab.crashed, dragging: tab.id === draggingId }"
          @pointerdown="startTabDrag(tab, $event)"
          @pointermove="moveTabDrag"
          @pointerup="endTabDrag"
          @pointercancel="endTabDrag"
          @click="selectTab(tab, $event)"
          @auxclick="onTabAuxClick(tab, $event)"
        >
          <button
            type="button"
            class="tab-title"
            :aria-pressed="tab.id === active?.id"
            :aria-busy="tab.loading"
            :title="tab.title"
          >
            <span class="glyph page site-icon" :class="{ loading: tab.loading }" aria-hidden="true"></span>
            <span class="tab-label">{{ tab.title }}</span>
          </button>
          <button
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
      <div v-if="active" ref="engineRoot" class="engine" role="group" aria-label="渲染引擎">
        <div class="engine-pill" :class="[active.engine, ringState]">
          <button
            type="button"
            class="engine-switch"
            role="switch"
            :aria-checked="active.engine === 'ruffle'"
            :aria-label="switchLabel"
            :title="engineTitle"
            @click="switchEngine"
          >{{ active.engine === 'ruffle' ? 'Ruffle' : 'Flash' }}</button>
          <span v-if="ringState" class="engine-state" :class="ringState" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 1 1 6 0v3H9Z" />
            </svg>
          </span>
          <button
            type="button"
            class="engine-more"
            :aria-expanded="enginePanelOpen"
            aria-haspopup="true"
            aria-label="选择渲染引擎（含锁定此站点）"
            title="选择渲染引擎"
            @click="toggleEnginePanel"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" aria-hidden="true">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </div>
        <div
          v-if="enginePanelOpen"
          class="engine-panel"
          role="radiogroup"
          aria-label="渲染引擎"
          @keydown.esc="closeEnginePanel"
        >
          <button
            v-for="option in engineOptions"
            :key="option.key"
            type="button"
            role="radio"
            :aria-checked="option.selected"
            :disabled="option.disabled"
            :title="option.disabled ? '当前页面没有可记忆的站点' : option.label"
            class="engine-stop"
            :class="[option.engine, { on: option.selected, locked: option.lock }]"
            @click="chooseEngineMode(option)"
          >
            <span class="engine-stop-knob" aria-hidden="true">{{ option.engine === 'ppapi' ? 'F' : 'R' }}</span>
            <span class="engine-stop-label">{{ option.label }}</span>
          </button>
        </div>
      </div>
      <span v-if="message || active?.error" class="message" role="status" :title="message || active?.error">{{ message || active?.error }}</span>
    </form>
  </header>
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
button:focus-visible { outline: 1px solid var(--stroke-focus-outer); outline-offset: -1px; box-shadow: inset 0 0 0 2px var(--stroke-focus-inner); }

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
.close-tab { width: 22px; height: 22px; opacity: 0; }
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
.message {
  max-width: 34%;
  margin-left: 6px;
  color: var(--text-error);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 引擎胶囊开关（Fluent 2 尺寸；红=原生 Flash，紫=Ruffle，与既有产品一致）。 */
.engine {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  flex: none;
  margin-inline-start: var(--space-s);
  -webkit-app-region: no-drag;
}

/* 引擎胶囊（架构 §3 引擎）：实色底 + 白字，右侧 ⌄ 打开四档面板。
   锁定 = 固定镀层外圈（左上亮、右下暗，不旋转）；规则被覆盖 = 琥珀色外圈。 */
.engine-pill {
  position: relative;
  display: inline-flex;
  align-items: stretch;
  height: 26px;
  border-radius: var(--radius-pill);
  background: #c0392f;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .16);
  transition: background-color var(--motion-normal) ease;
}
.engine-pill.ruffle { background: #6a4fe0; }

.engine-switch {
  padding: 0 2px 0 12px;
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .01em;
  line-height: 26px;
}
.engine-more {
  display: flex;
  align-items: center;
  padding: 0 8px 0 4px;
  color: rgba(255, 255, 255, .72);
}
.engine-more svg { width: 9px; height: 9px; }
.engine-more:hover { color: #fff; }
.engine-pill:hover { filter: brightness(1.06); }
.engine-pill:has(.engine-switch:active) { filter: brightness(.94); }
.engine-switch:focus-visible,
.engine-more:focus-visible {
  outline: 1px solid var(--stroke-focus-outer);
  outline-offset: 1px;
  border-radius: var(--radius-pill);
}

/* 锁定状态标记：26px 高的胶囊上做不出可读的外圈，改用内嵌锁字形。
   白色 = 已锁定；琥珀 = 站点规则存在但被手动切换覆盖。 */
.engine-state {
  align-self: center;
  display: inline-flex;
  margin-inline-start: -2px;
  color: rgba(255, 255, 255, .88);
}
.engine-state.overridden { color: #ffd08a; }
.engine-state svg { width: 10px; height: 10px; }

/* 四档面板 */
.engine-panel {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 30;
  display: flex;
  gap: 2px;
  width: 276px;
  padding: 5px;
  border-radius: var(--radius-surface);
  background: var(--surface-toolbar);
  border: 1px solid var(--stroke-divider);
  box-shadow: 0 8px 24px rgba(0, 0, 0, .13), 0 2px 6px rgba(0, 0, 0, .07);
}
.engine-stop {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 6px 2px 5px;
  border-radius: var(--radius-control);
  color: var(--text-secondary);
  font-size: 10px;
  line-height: 1;
  white-space: nowrap;
}
.engine-stop:hover:not(:disabled) { background: var(--surface-hover); }
.engine-stop:disabled { color: var(--text-disabled); cursor: default; }
.engine-stop-knob {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-pill);
  background: transparent;
  color: transparent;
  font-size: 10px;
  font-weight: 700;
}
.engine-stop.on { color: var(--text-primary); font-weight: 600; }
.engine-stop.on .engine-stop-knob { color: #fff; }
.engine-stop.on.ppapi .engine-stop-knob { background: #c0392f; }
.engine-stop.on.ruffle .engine-stop-knob { background: #6a4fe0; }
.engine-stop:focus-visible {
  outline: 1px solid var(--stroke-focus-outer);
  outline-offset: -1px;
}

@media (prefers-reduced-motion: reduce) {
  .engine-pill { transition: none; }
}

@media (forced-colors: active) {
  .engine-pill { border: 1px solid ButtonText; background: ButtonFace; }
  .engine-pill .engine-switch,
  .engine-pill .engine-more { color: ButtonText; }
  .engine-pill.locked::after { background: Highlight; }
}

@media (forced-colors: active) {
  .tab.selected { --tab-outline: Highlight; }
  .tab.selected::before, .tab.selected::after { forced-color-adjust: none; }
  .tab.selected::after { background: Canvas; }
  .address-bar:focus-within { outline: 2px solid Highlight; outline-offset: -2px; }
}
</style>
