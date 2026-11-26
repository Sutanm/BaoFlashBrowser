<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { QuickView } from '../shared/overlay'
import { useBrowserStore } from './stores/browser'
import { applyShellTheme } from './theme'

/**
 * 叠加层宿主：panel / quick / toast **共用同一个文档与渲染进程**，靠事件切换显示哪个组件。
 *
 * 为什么不按 kind 分别加载一个文档：那是「一种内容一个渲染进程」，每个都要预热、
 * 还要错开预热时间。这里三个组件都常驻挂载（`v-show`），切换只是 CSS 显隐。
 *
 * `quick` 里还有两页（快捷设置 / 收藏夹）：同样靠 `v-show` 切换，**不重新挂载**——
 * 换页时两边的高度/滚动位置都还在，飞窗只需要一次 resize。
 *
 * 组件用异步导入：首帧只含宿主本身（很轻），大块插画在后台并行加载，不拖第一次打开。
 */
const ShellOverlay = defineAsyncComponent(() => import('./ShellOverlay.vue'))
const QuickSettings = defineAsyncComponent(() => import('./QuickSettings.vue'))
const BookmarksPanel = defineAsyncComponent(() => import('./BookmarksPanel.vue'))
const BookmarkEditPanel = defineAsyncComponent(() => import('./BookmarkEditPanel.vue'))

const store = useBrowserStore()
const kind = ref<'panel' | 'quick' | 'toast'>('panel')
/** 飞窗当前画哪一页；由主进程的 `quick-opened` 带过来（它才知道外壳最后一次请求的是哪页）。 */
const view = ref<QuickView>('settings')
/** toast 文本存在宿主里：toast 组件是异步挂载的，事件可能先于挂载到达。 */
const toastText = ref('')
/** 是否正在显示；隐藏时暂停 CSS 动画与日晷的时钟动画（视图 detach 后页面仍是 visible）。 */
const active = ref(false)
const quickShown = computed(() => kind.value === 'quick')
let detach: (() => void) | undefined
let openTimer = 0

function setIdle(idle: boolean): void {
  document.documentElement.dataset.overlayIdle = idle ? 'true' : 'false'
}

/** 打开动画：只加一个短属性，由 CSS 播一次，结束就清掉。 */
function markOpening(): void {
  const root = document.documentElement
  root.dataset.overlayOpen = 'true'
  if (openTimer) window.clearTimeout(openTimer)
  openTimer = window.setTimeout(() => { delete root.dataset.overlayOpen }, 180)
}

/**
 * 度量：等内容真正提交到一帧之后再回报（`nextTick` 只保证 DOM 更新，
 * 再加一次 rAF 才接近「渲染层已出画面」；这是代理指标，不是屏幕呈现证明）。
 */
function reportReadyAfterPaint(): void {
  void nextTick(() => {
    requestAnimationFrame(() => { void window.baoOverlay.reportReady() })
  })
}

onMounted(() => {
  setIdle(true)
  store.connect()
  /**
   * 长任务观测（2026-11-25 演示 §7.7-1 / ADR-0004「把纪律变成门槛」）。
   *
   * 观察必须装在**浮层自己的 realm** 里：LoAF 的 `windowAttribution` 是按帧树关系分档的
   * （self/descendant/ancestor/same-page/other），而浮层是另一个顶层窗口——外壳侧 observer
   * 只能知道"这一帧晚了"，看不到是浮层的哪段脚本。
   *
   * `longtask` 给时长和归属，`long-animation-frame` 额外给 `scripts[].sourceURL`——
   * 后者才是"哪一行"。两者都不支持时静默降级（生产端只有诊断用）。
   */
  let observer: PerformanceObserver | undefined
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const scripts = (entry as PerformanceEntry & { scripts?: { sourceURL?: string; invoker?: string }[] }).scripts
        const source = scripts?.find((script) => script.sourceURL)?.sourceURL ?? entry.name
        void window.baoOverlay.reportLongTask(entry.duration, source)
      }
    })
    observer.observe({ entryTypes: ['longtask', 'long-animation-frame'] })
  } catch {
    observer?.disconnect()
    observer = undefined
  }
  onBeforeUnmount(() => observer?.disconnect())
  detach = window.baoOverlay.subscribe((event) => {
    if (event.type === 'panel-opened' || event.type === 'quick-opened') void store.run({ type: 'snapshot' })
    // 主题在宿主这一层就落地：内容是异步组件，首次打开时它可能比事件晚挂载，
    // 之后自己也收不到那条 `*-opened`（共享模式下浮层文档是点击那一刻才建出来的）。
    if (event.type === 'panel-opened' || event.type === 'quick-opened') applyShellTheme(event.theme)
    if (event.type === 'panel-opened') {
      kind.value = 'panel'
      active.value = true
      markOpening()
    } else if (event.type === 'quick-opened') {
      view.value = event.view
      kind.value = 'quick'
      active.value = true
      markOpening()
    } else if (event.type === 'toast') {
      toastText.value = event.text
      kind.value = 'toast'
      active.value = true
      markOpening()
    } else if (event.type === 'panel-closed' || event.type === 'quick-closed' ||
               event.type === 'toast-closed' || event.type === 'overlay-hidden') {
      active.value = false
    }
    setIdle(!active.value)
    if (active.value) reportReadyAfterPaint()
  })
  // 拉一次当前内容：共享模式下文档可能在「点击那一刻」才被开出来，`*-opened` 早于订阅就丢了。
  void window.baoOverlay.pullOverlay()
})

onBeforeUnmount(() => {
  if (openTimer) window.clearTimeout(openTimer)
  detach?.()
})
</script>

<template>
  <div v-show="kind === 'panel'" class="overlay-slot">
    <ShellOverlay kind="panel" />
  </div>
  <div v-show="quickShown && view === 'settings'" class="overlay-slot">
    <QuickSettings kind="quick" :paused="!active" />
  </div>
  <div v-show="quickShown && view === 'bookmarks'" class="overlay-slot">
    <BookmarksPanel :paused="!active" />
  </div>
  <div v-show="quickShown && view === 'bookmark-edit'" class="overlay-slot">
    <BookmarkEditPanel :paused="!active" />
  </div>
  <div v-show="kind === 'toast'" class="overlay-slot">
    <ShellOverlay kind="toast" :text="toastText" />
  </div>
</template>

<style>
.overlay-slot { display: contents; }

/* 打开时的一点淡入 + 微缩放（Chrome 菜单约 100 ms）；属性由宿主在 180 ms 后清掉。 */
[data-overlay-open='true'] .quick,
[data-overlay-open='true'] .engine-panel,
[data-overlay-open='true'] .toast {
  animation: bao-overlay-in 140ms cubic-bezier(.2, .8, .2, 1);
}
@keyframes bao-overlay-in {
  from { opacity: .55; transform: scale(.985); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  [data-overlay-open='true'] .quick,
  [data-overlay-open='true'] .engine-panel,
  [data-overlay-open='true'] .toast { animation: none; }
}
</style>
