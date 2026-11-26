<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { TAB_BAR_HEIGHT, TOOLBAR_HEIGHT, INFOBAR_HEIGHT } from '../shared/browser'
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
import { dropSlotIndex, finalDropIndex } from './tab-drag'

const DRAG_THRESHOLD = 6

const shellStyle = {
  '--tab-bar-height': `${TAB_BAR_HEIGHT}px`,
  '--toolbar-height': `${TOOLBAR_HEIGHT}px`,
  '--infobar-height': `${INFOBAR_HEIGHT}px`
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

/**
 * 地址栏里是否有**用户自己敲的、尚未提交**的草稿。
 *
 * 为什么需要它：外壳启动后的首份状态广播可能晚于用户输入。实测（常驻预热档，
 * `scripts/probe-overlay-navigation*.cjs` + 应用内埋点）：填好地址 → 状态广播到达 →
 * 输入框被重置成 `active.address`（新标签页是空串）→ 回车等于导航到空地址，
 * 标签永远停在新标签页。症状在外壳套件里表现为整片 30 s 超时、现场 `active:''`，
 * 一度被误判为「共享浮层抢焦点」。
 *
 * 判定刻意用"用户是否敲过"而不是"值是否与上次同步不同"：后者分不清"用户输入"与
 * "程序化切标签/导航"，会把切标签后的地址栏也钉在旧值上（实测把 Ctrl+,→设置页那条用例钉死）。
 */
const addressDirty = ref(false)

/** 把输入框同步回当前标签的地址（提交后、离开输入框时用）。 */
function syncAddressFromActive(): void {
  addressDirty.value = false
  address.value = active.value?.address ?? ''
}

watch([() => active.value?.id, () => active.value?.address], () => {
  // 用户有未提交草稿时不覆盖；其余一律跟随标签状态。
  if (!addressDirty.value) address.value = active.value?.address ?? ''
  message.value = ''
})

watch([() => active.value?.id, () => active.value?.internal], ([id]) => {
  tabStrip.value?.querySelector('.selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  /**
   * 新标签页：焦点进地址栏（Chrome 的 `ShouldFocusLocationBarByDefault`）。
   * 主进程把焦点交给了外壳（NTP 视图不抢焦点），这里补上「输入框」这一步；
   * `Ctrl+T`、`+`、从网页 Back 回 NTP 因此行为一致。
   */
  const tab = state.value?.tabs.find((item) => item.id === id)
  if (tab?.internal === 'newtab') {
    void nextTick(() => {
      if (document.activeElement !== addressField.value) addressField.value?.focus({ preventScroll: true })
    })
  }
}, { flush: 'post' })

watch(() => state.value?.theme, (theme) => {
  if (theme) applyShellTheme(theme)
})

/** 地址栏回车：提交即视为「草稿已交出去」，之后跟随标签状态。 */
function submitAddress(): void {
  addressDirty.value = false
  void run({ type: 'navigate', address: address.value })
}

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
  cancelHoverPrewarm()
  closeEnginePanel()
  const bounds = quickBounds()
  if (!bounds) return
  await ensureSharedOverlay()
  quickOpen.value = true
  if (!await window.baoOverlay.setQuick(bounds)) quickOpen.value = false
}

/** 共享进程模式探测结果（只问一次）。 */
let sharedOverlayMode: boolean | undefined
/** 已经打开的浮层窗口句柄；窗口被关掉（closed）才重新开。 */
let sharedOverlayWindow: Window | null = null
/** 正在进行的开窗动作（单飞）：悬停预热与点击兜底会几乎同时调用它。 */
let sharedOverlayOpening: Promise<void> | undefined

/**
 * 共享进程模式（proto）：浮层由外壳自己 `window.open` 产生，复用外壳的渲染进程。
 *
 * 注意**不能**每次都 `window.open(url, name)`：同名窗口会被复用，但会`navigate`到该 URL，
 * 也就是把浮层文档整个重新加载（实测：齿轮 pointerenter 走预热 → 文档重载 → 已订阅的
 * 监听器、DOM 状态全丢，飞窗打开后既收不到 `quick-opened` 也没有焦点）。
 * 因此这里缓存 WindowProxy，窗口还活着就直接返回，只做幂等的「保证存在」。
 *
 * 而且必须**单飞**：Playwright/真人都是先 pointerenter 再 click，两者间隔十几毫秒，
 * 两个调用会同时看到 `sharedOverlayWindow === null` → 连开两次同名窗口（第二次把第一次
 * 导航掉）→ 飞窗文档刚好在 `setQuick` 那一刻被重载，视图亮着但内容/订阅全空。
 * 见 docs/discussions/2026-11-25-overlay-shared-process-demo.md
 */
function ensureSharedOverlay(): Promise<void> {
  sharedOverlayOpening ??= openSharedOverlay().finally(() => { sharedOverlayOpening = undefined })
  return sharedOverlayOpening
}

async function openSharedOverlay(): Promise<void> {
  if (sharedOverlayMode === undefined) sharedOverlayMode = await window.baoOverlay.sharedMode()
  if (!sharedOverlayMode) return
  if (sharedOverlayWindow && !sharedOverlayWindow.closed) return
  try {
    const url = new URL(location.href)
    url.search = '?baoOverlay=overlay'
    sharedOverlayWindow = window.open(url.href, 'bao-overlay', 'width=600,height=520')
  } catch (error) {
    sharedOverlayWindow = null
  }
}
/**
 * 常驻档（`overlay.prewarm=always`）：文档启动后就建好、一直热着，**第一次点开也是热的**。
 *
 * 触发权在主进程（`overlay-prewarm` 事件）：共享模式下建文档要由外壳 `window.open` 完成，
 * 而"该不该建"取决于主进程独占的信息（设置项、自动化/后台模式、策略覆盖）。
 *
 * 时机是**立刻**，不再等空闲：主进程在 `window.show()` **之前**推这个事件，那时窗口还不可见，
 * 用户不可能正在输入，因此"建文档"与"用户打字"不可能重叠。这一条是被实测逼出来的——
 * 放在空闲时刻建时，开窗恰好落在"用户填好地址、还没敲回车"的窗口里，回车被吞（见 §7.4）。
 * 价格实测只有 +6 MB（共享进程），代价是启动期多付一次开窗（~40 ms 量级）。
 */
function prewarmSharedOverlay(): void {
  void ensureSharedOverlay()
}

/** 悬停预热（auto 策略）：主进程先回答"这一档准不准"，准了才排开窗。 */
let hoverPrewarmTimer = 0
/**
 * 悬停"意图"时长：不能在 pointerenter 里同步开窗（会把紧随其后的 click 吞掉）。
 *
 * 180 ms 是实测出来的折中：太短等于同步开窗（页面有内容时必现 click 丢失），
 * 太长则真人在"悬停→点击"之间等不到预热，等于还是冷开。
 */
const HOVER_PREWARM_MS = 180

/**
 * 悬停定时器到点：**开窗前再问一次主进程**。
 *
 * 排队这 180 ms 里策略可能已经从 `auto` 变成 `never`（设置页切换、自动化开始、窗口转后台），
 * 而主进程此时会 `retire()` 掉已有的浮层文档；如果这里不复查，定时器会立刻把刚退役的文档
 * 又开回来（2026-11-26 审计）。
 */
function prewarmOpen(): void {
  void window.baoOverlay.canPrewarm().then((allowed) => {
    if (allowed) void ensureSharedOverlay()
  })
}

function prewarmOverlay(): void {
  // 闸门在主进程：`overlay.prewarm=never` 和自动化/后台模式一律回答 false。
  // 早先这里不看返回值、直接排开窗定时器，于是三档行为完全一致（never 也照样悬停即建、
  // 建完也不回收）—— 见 docs/discussions/2026-11-25-overlay-shared-process-demo.md §7。
  void window.baoOverlay.canPrewarm().then((allowed) => {
    if (!allowed) return
    // 独立进程模式：主进程自己建隐藏视图，这一步就是"预热"的全部。
    // 共享模式：这条命令是空操作（主进程不建视图），真正做事的是下面那次延迟开窗。
    void window.baoOverlay.prewarm()
    // 共享模式（以及模式还没探测出来时）按"悬停意图"延迟开窗：点得快就取消，让点击路径
    // 自己去冷开（`cancelHoverPrewarm`）。独立进程模式下 `ensureSharedOverlay()` 立刻返回。
    window.clearTimeout(hoverPrewarmTimer)
    hoverPrewarmTimer = window.setTimeout(prewarmOpen, HOVER_PREWARM_MS)
  })
}

function cancelHoverPrewarm(): void {
  window.clearTimeout(hoverPrewarmTimer)
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
  cancelHoverPrewarm()
  closeQuick(false)
  const bounds = panelBounds()
  if (!bounds) return
  await ensureSharedOverlay()
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
  // 共享模式：提示条也可能在没有任何悬停预热的情况下出现，先确保浮层文档存在。
  void ensureSharedOverlay().then(() => window.baoOverlay.setToast({ bounds, text }))
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
  // 共享模式探测提前问一次（点击路径里不要再等一次 IPC）。这里**不**顺手开窗：
  // 实测"启动后空闲时建文档"会抢焦点、吞掉用户正在敲的键（整轮前台套件里打出 7 条随机失败），
  // 所以预热只挂在用户的显式动作上（悬停 / 点击兜底）。见 docs/discussions 2026-11-25 飞窗共享进程。
  void window.baoOverlay.sharedMode().then((mode) => { sharedOverlayMode = mode })
  detachOverlay = window.baoOverlay.subscribe((event) => {
    if (event.type === 'panel-closed') {
      enginePanelOpen.value = false
      if (event.restoreFocus) engineTrigger.value?.focus()
    } else if (event.type === 'quick-closed') {
      quickOpen.value = false
      if (event.restoreFocus) gearRoot.value?.focus()
    } else if (event.type === 'toast-closed') clearToast()
    else if (event.type === 'overlay-prewarm') prewarmSharedOverlay()
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
  const index = dropIndex(screenX, screenY, drag.id)
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

/**
 * 释放点在标签栏内时给出目标序号；栏外（横或纵）返回 undefined，交给 tearoff 判定。
 *
 * 返回值符合 `move` IPC 的语义：**移除被拖项之后的最终索引**。指针落点本身数的是
 * 「含被拖项」的插槽，向右拖时会多算被拖项自己那一格，所以必须用 `finalDropIndex`
 * 换算一次（否则横向拖拽会偏一位）。
 */
function dropIndex(screenX: number, screenY: number, id: number): number | undefined {
  const strip = tabStrip.value
  if (!strip) return undefined
  const rect = strip.getBoundingClientRect()
  const clientX = screenX - window.screenX
  const clientY = screenY - window.screenY
  // 审计 P2：原实现只看 X，竖直拖出会被当成排序。两个轴都要在标签栏范围内。
  if (clientY < rect.top - 4 || clientY > rect.bottom + 4) return undefined
  if (clientX < rect.left - 4 || clientX > rect.right + 4) return undefined
  const items = [...strip.querySelectorAll<HTMLElement>('.tab')]
  const boxes = items.map((item) => {
    const box = item.getBoundingClientRect()
    return { left: box.left, width: box.width }
  })
  const slot = dropSlotIndex(boxes, clientX)
  // 渲染顺序与主进程 `tabs` 一致：用快照里的位置把插槽换算成移除后的最终索引。
  // 取不到（拖动途中标签被关掉）时按列表首位处理，越界由主进程的 `unknown-tab` 兜底。
  const from = state.value?.tabs.findIndex((tab) => tab.id === id) ?? -1
  return finalDropIndex(slot, from)
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
          :class="{ selected: tab.id === active?.id, crashed: tab.crashed, dragging: tab.id === draggingId, pinned: tab.pinned, muted: tab.muted, sleeping: tab.discarded, awake: tab.keepAwake }"
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
            <span v-if="tab.internal === 'settings'" class="site-icon settings-icon" aria-hidden="true"><ShellIcon name="gear" /></span>
            <span v-else class="glyph page site-icon" :class="{ loading: tab.loading }" aria-hidden="true"></span>
            <span v-if="!tab.pinned" class="tab-label">{{ tab.title }}</span>
            <span v-if="tab.keepAwake" class="awake-mark" aria-hidden="true" title="保持活跃（不自动休眠）"></span>
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

    <form class="toolbar" aria-label="导航工具栏" @submit.prevent="submitAddress">
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
          @input="addressDirty = true"
          @blur="syncAddressFromActive"
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
          aria-haspopup="dialog" aria-label="引擎设置" title="引擎设置"
          @pointerenter="prewarmOverlay" @click="toggleEnginePanel">
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
        @pointerenter="prewarmOverlay"
        @click="toggleQuick"
      ><ShellIcon name="gear" /></button>
    </form>
    <!--
      崩溃恢复提示（Chrome 的「恢复页面」气泡）：只有上次异常退出时才出现。
      正常退出后重启没有这条提示，直接就是新标签页。
    -->
    <div v-if="state?.sessionPrompt" class="session-infobar" role="region" aria-label="恢复上次会话">
      <span class="session-infobar-text">
        上次未正常退出，可以恢复 {{ state.sessionPrompt.tabs }} 个标签页
      </span>
      <button
        type="button"
        class="session-infobar-action primary"
        @click="run({ type: 'restore-session' })"
      >恢复标签页</button>
      <button
        type="button"
        class="session-infobar-action"
        @click="run({ type: 'dismiss-session' })"
      >忽略</button>
    </div>
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
  height: var(--tab-bar-height);
  padding-inline: 0 calc(100vw - env(titlebar-area-width, calc(100vw - 144px)) + 36px);
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

/*
 * 崩溃恢复提示条：固定高度（与主进程 `INFOBAR_HEIGHT` 一致），页面视图会让开这一段。
 * 用 info 语义色而不是警告色——"上次没正常退出"是提示，不是错误。
 */
.session-infobar {
  display: flex;
  align-items: center;
  gap: var(--space-s);
  height: var(--infobar-height);
  padding-inline: var(--space-s) var(--space-m);
  background: var(--surface-window);
  border-bottom: var(--shell-stroke) solid var(--stroke-divider);
  color: var(--text-primary);
  font-size: var(--size-caption);
}

.session-infobar-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.session-infobar-action {
  flex: 0 0 auto;
  height: 26px;
  padding-inline: var(--space-s);
  border-radius: var(--button-radius);
  color: var(--text-primary);
}

.session-infobar-action:hover { background: var(--surface-hover); }

.session-infobar-action.primary {
  background: var(--engine-accent);
  color: var(--surface-page);
}

.session-infobar-action.primary:hover { filter: brightness(1.08); }
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
/* 保持活跃标记：一个小圆点，不抢标题长度。 */
.awake-mark { width: 6px; height: 6px; border-radius: 50%; background: var(--engine-accent); opacity: .75; flex: none; }
/* 已休眠：标题弱化，点击即唤醒。 */
.tab.sleeping .tab-label { opacity: .55; }
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
  /*
   * Chromium 142 的 NTB 同样是 28px，位置由 12px 标签底角与 6px strip padding
   * 共同计算。这里的标签脚更小，回收半个脚宽即可；完整回收会让图标贴住轮廓。
   */
  margin-inline-start: -2px;
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
