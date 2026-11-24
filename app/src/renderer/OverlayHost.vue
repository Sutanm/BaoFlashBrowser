<script setup lang="ts">
import { defineAsyncComponent, onBeforeUnmount, onMounted, ref } from 'vue'
import { useBrowserStore } from './stores/browser'

/**
 * 叠加层宿主：panel / quick / toast **共用同一个文档与渲染进程**，靠事件切换显示哪个组件。
 *
 * 为什么不按 kind 分别加载一个文档：那是「一种内容一个渲染进程」，每个都要预热、
 * 还要错开预热时间。这里三个组件都常驻挂载（`v-show`），切换只是 CSS 显隐。
 *
 * 组件用异步导入：首帧只含宿主本身（很轻），大块插画在后台并行加载，不拖第一次打开。
 */
const ShellOverlay = defineAsyncComponent(() => import('./ShellOverlay.vue'))
const QuickSettings = defineAsyncComponent(() => import('./QuickSettings.vue'))

const store = useBrowserStore()
const kind = ref<'panel' | 'quick' | 'toast'>('panel')
/** toast 文本存在宿主里：toast 组件是异步挂载的，事件可能先于挂载到达。 */
const toastText = ref('')
/** 是否正在显示；隐藏时暂停 CSS 动画与日晷的时钟动画（视图 detach 后页面仍是 visible）。 */
const active = ref(false)
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

onMounted(() => {
  setIdle(true)
  store.connect()
  detach = window.baoOverlay.subscribe((event) => {
    if (event.type === 'panel-opened' || event.type === 'quick-opened') void store.run({ type: 'snapshot' })
    if (event.type === 'panel-opened') {
      kind.value = 'panel'
      active.value = true
      markOpening()
    } else if (event.type === 'quick-opened') {
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
  })
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
  <div v-show="kind === 'quick'" class="overlay-slot">
    <QuickSettings kind="quick" :paused="!active" />
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
