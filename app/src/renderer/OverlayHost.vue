<script setup lang="ts">
import { defineAsyncComponent, onBeforeUnmount, onMounted, ref } from 'vue'

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

const kind = ref<'panel' | 'quick'>('panel')
let detach: (() => void) | undefined

onMounted(() => {
  detach = window.baoOverlay.subscribe((event) => {
    if (event.type === 'panel-opened') kind.value = 'panel'
    else if (event.type === 'quick-opened') kind.value = 'quick'
  })
})
onBeforeUnmount(() => detach?.())
</script>

<template>
  <div v-show="kind === 'panel'" class="overlay-slot">
    <ShellOverlay kind="panel" />
  </div>
  <div v-show="kind === 'quick'" class="overlay-slot">
    <QuickSettings kind="quick" />
  </div>
</template>

<style>
.overlay-slot { display: contents; }
</style>


<style>
.overlay-slot { display: contents; }
</style>
