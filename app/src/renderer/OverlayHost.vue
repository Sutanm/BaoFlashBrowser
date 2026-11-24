<script setup lang="ts">
import { defineAsyncComponent, onBeforeUnmount, onMounted, ref } from 'vue'
import { useBrowserStore } from './stores/browser'

/**
 * 飞窗宿主：panel 与 quick **共用同一个文档/渲染进程**，靠事件切换显示哪个组件。
 *
 * 为什么不按 kind 分别加载一个文档：那是「一种飞窗一个渲染进程」，每个都要预热、
 * 还要错开预热时间。这里两个组件都常驻挂载（`v-show`），切换只是 CSS 显隐，
 * 不会丢订阅、也不会重新挂载。
 *
 * 两个组件用异步组件导入：叠加层文档的首帧只包含宿主本身（很轻），
 * 主题开关那 256 kB 的插画（ThemeSwitch）在后台并行加载，不拖第一次打开。
 */
const ShellOverlay = defineAsyncComponent(() => import('./ShellOverlay.vue'))
const QuickSettings = defineAsyncComponent(() => import('./QuickSettings.vue'))

const store = useBrowserStore()
const kind = ref<'panel' | 'quick'>('panel')
/** 飞窗是否正在显示；隐藏时暂停 CSS 动画与日晷的时钟动画（视图被 detach 后页面仍是 visible）。 */
const active = ref(false)
let detach: (() => void) | undefined

function setIdle(idle: boolean): void {
  document.documentElement.dataset.overlayIdle = idle ? 'true' : 'false'
}

onMounted(() => {
  setIdle(true)
  // 叠加层是常驻文档：主体可能在它加载之后才切主题，仅靠推送会漏。
  // 每次打开都重新拉一次快照，保证主题/设置与主进程一致。
  store.connect()
  detach = window.baoOverlay.subscribe((event) => {
    if (event.type === 'panel-opened' || event.type === 'quick-opened') void store.run({ type: 'snapshot' })
    if (event.type === 'panel-opened') {
      kind.value = 'panel'
      active.value = true
    } else if (event.type === 'quick-opened') {
      kind.value = 'quick'
      active.value = true
    } else if (event.type === 'panel-closed' || event.type === 'quick-closed' || event.type === 'overlay-hidden') {
      active.value = false
    }
    setIdle(!active.value)
  })
})
onBeforeUnmount(() => detach?.())
</script>

<template>
  <div v-show="kind === 'panel'" class="overlay-slot">
    <ShellOverlay kind="panel" />
  </div>
  <div v-show="kind === 'quick'" class="overlay-slot">
    <QuickSettings kind="quick" :paused="!active" />
  </div>
</template>

<style>
.overlay-slot { display: contents; }
</style>


<style>
.overlay-slot { display: contents; }
</style>
