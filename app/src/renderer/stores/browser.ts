import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import type { BrowserCommand, BrowserState } from '../../shared/browser'

/**
 * 浏览器投影状态（架构 §3 外壳：Vue 3 + Pinia，瞬态交互留在组件内）。
 * 主进程持业务权威，这里只缓存最近一次投影并按 revision 丢弃过期快照。
 */
export const useBrowserStore = defineStore('browser', () => {
  const snapshot = shallowRef<BrowserState>()
  const message = ref('')
  const active = computed(() =>
    snapshot.value?.tabs.find((tab) => tab.id === snapshot.value?.activeId))
  let detach: (() => void) | undefined

  function apply(update: BrowserState): void {
    if (snapshot.value && update.revision < snapshot.value.revision) return
    snapshot.value = update
  }

  async function run(command: BrowserCommand): Promise<void> {
    message.value = ''
    try {
      const result = await window.baoBrowser.run(command)
      if (result.ok) apply(result.state)
      else message.value = result.message
    } catch {
      message.value = '浏览器操作失败'
    }
  }

  function connect(): void {
    if (detach) return
    detach = window.baoBrowser.subscribe(apply)
    void run({ type: 'snapshot' })
  }

  function disconnect(): void {
    detach?.()
    detach = undefined
  }

  return { snapshot, message, active, apply, run, connect, disconnect }
})
