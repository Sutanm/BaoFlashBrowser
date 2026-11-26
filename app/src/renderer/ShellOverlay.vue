<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import type { BrowserCommand } from '../shared/browser'
import { browserEngines, hostOf } from '../shared/engine'
import type { BrowserEngine } from '../shared/engine'
import type { OverlayKind } from '../shared/overlay'
import { OVERLAY_INSET, OVERLAY_TOP_INSET } from './overlay-layout'
import ShellIcon from './ShellIcon.vue'
import { useBrowserStore } from './stores/browser'
import { applyShellTheme, initialShellTheme } from './theme'

const props = defineProps<{ kind: OverlayKind; text?: string }>()
const store = useBrowserStore()
const { snapshot, active, message } = storeToRefs(store)
const panel = ref<HTMLElement>()
const toast = ref(props.text ?? '')
watch(() => props.text, (value) => {
  if (value) toast.value = value
}, { immediate: true })
const busy = ref(false)
const host = computed(() => hostOf(active.value?.address ?? ''))
const pinned = computed(() => host.value ? active.value?.pinnedEngine : undefined)
const override = computed(() => pinned.value && pinned.value !== active.value?.engine)
const names = { ppapi: 'Flash', ruffle: 'Ruffle' }
let detach: (() => void) | undefined
let observer: ResizeObserver | undefined
let restoreSelection = false

applyShellTheme(initialShellTheme())
watch(() => snapshot.value?.theme, (theme) => { if (theme) applyShellTheme(theme) })

async function focusSelected(): Promise<void> {
  await nextTick()
  panel.value?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus()
}

watch(() => active.value?.engine, () => {
  if (restoreSelection) {
    restoreSelection = false
    void focusSelected()
  }
})

async function submit(command: BrowserCommand): Promise<boolean> {
  if (busy.value) return false
  busy.value = true
  try {
    const ok = await store.run(command)
    if (!ok && message.value) await window.baoOverlay.reportFailure(message.value)
    return ok
  } finally {
    busy.value = false
  }
}

async function choose(engine: BrowserEngine): Promise<void> {
  // 插件缺失时「原生 Flash」是不可用档：不弹失败提示（那只会打断人），
  // 直接跳到设置页的 Flash 插件区，让用户看到导入入口。
  if (engine === 'ppapi' && snapshot.value?.flash === false) {
    // 先开设置页再关面板：`open-settings` 的发送者校验要求 panel 仍然可见。
    await store.run({ type: 'open-settings' })
    await window.baoOverlay.closePanel(false)
    return
  }
  if (engine === active.value?.engine || await submit({ type: 'set-engine', engine })) {
    await window.baoOverlay.closePanel()
  }
}

async function setRule(remember: boolean, fromOverride = false): Promise<void> {
  if (await submit({ type: remember ? 'remember-engine' : 'forget-engine' }) && fromOverride) {
    await nextTick()
    panel.value?.querySelector<HTMLElement>('[role="switch"]')?.focus()
  }
}

function dismiss(): void { void window.baoOverlay.dismissToast() }

onMounted(() => {
  detach = window.baoOverlay.subscribe((event) => {
    if (event.type === 'toast') toast.value = event.text
    if (event.type === 'panel-opened') {
      // 打开事件带着当前主题（常驻文档 + 推送可能早于订阅）。
      applyShellTheme(event.theme)
      restoreSelection = !active.value
      void focusSelected()
    }
  })
  if (props.kind === 'panel' && panel.value) {
    observer = new ResizeObserver(() => {
      if (!panel.value) return
      const height = Math.ceil(panel.value.getBoundingClientRect().height) + OVERLAY_TOP_INSET + OVERLAY_INSET
      void window.baoOverlay.resizePanel(height)
    })
    observer.observe(panel.value)
  }
  store.connect()
})

onBeforeUnmount(() => {
  observer?.disconnect()
  detach?.()
  store.disconnect()
})
</script>

<template>
  <div class="overlay-frame" :class="{ flyout: kind === 'panel' }" :style="kind === 'toast' ? { padding: `${OVERLAY_TOP_INSET}px ${OVERLAY_INSET}px ${OVERLAY_INSET}px` } : undefined">
    <section v-if="kind === 'panel'" id="engine-panel" ref="panel" class="engine-panel overlay-card" role="dialog" aria-labelledby="engine-heading">
      <h2 id="engine-heading" class="overlay-title">渲染引擎</h2>
      <div class="engine-choices" role="group" aria-label="选择当前标签的引擎">
        <button v-for="engine in browserEngines" :key="engine" type="button" class="engine-choice"
          :aria-pressed="active?.engine === engine"
          :aria-disabled="!active || (engine === 'ppapi' && snapshot?.flash === false) ? 'true' : 'false'"
          :title="engine === 'ppapi' && snapshot?.flash === false
            ? `未检测到 Flash 插件（已自动查找本机已安装的 Flash）。也可以把 pepflashplayer64.dll 放到：${snapshot?.flashHint ?? ''} ，然后重启。本产品不随包分发 Flash。`
            : undefined"
          @click="choose(engine)">
          <span class="engine-symbol" :class="engine"><ShellIcon :name="engine === 'ppapi' ? 'flash' : 'ruffle'" /></span>
          <strong>{{ names[engine] }}</strong>
          <span class="desc">{{ engine === 'ppapi' ? '原生播放器' : '兼容播放器' }}</span>
          <ShellIcon name="check" class="choice-check" />
        </button>
      </div>
      <div class="site-rule">
        <div class="site-head"><strong>此站点</strong><span class="host" :title="host">{{ host || '无站点' }}</span></div>
        <div v-if="!override" class="site-control">
          <span id="remember-label">记住当前引擎</span>
          <button type="button" role="switch" class="remember" aria-labelledby="remember-label"
            :title="host ? undefined : '当前页面没有可保存规则的站点'" :aria-checked="!!pinned" :disabled="!host"
            @click="setRule(!pinned)"><span></span></button>
        </div>
        <template v-else-if="active && pinned">
          <p class="override-text">已记住 {{ names[pinned] }} · 当前使用 {{ names[active.engine] }}</p>
          <div class="site-actions">
            <button type="button" class="overlay-button primary" @click="setRule(true, true)">改为记住 {{ names[active.engine] }}</button>
            <button type="button" class="overlay-button" @click="setRule(false, true)">取消记住</button>
          </div>
        </template>
      </div>
    </section>
    <div v-else-if="toast" class="toast" role="alert">
      <ShellIcon name="error" class="toast-icon" />
      <p>{{ toast }}</p>
      <button type="button" aria-label="关闭提示" class="toast-close" @click="dismiss"><ShellIcon name="close" /></button>
    </div>
  </div>
</template>

<style>
.shell-overlay, .shell-overlay body { margin: 0; overflow: hidden; background: transparent; }
.shell-overlay { font: var(--size-body)/1.4 var(--shell-font); color: var(--text-primary); }
.overlay-frame *, .overlay-frame *::before, .overlay-frame *::after { box-sizing: border-box; }
:where(.overlay-frame button) { font: inherit; color: inherit; border: 0; background: transparent; }
.overlay-frame button:not(:disabled) { cursor: pointer; }
/* 面板里的行同飞窗：键盘焦点用整行高亮表示（Chrome 菜单的做法），不画环。
   只有真正的表单控件（主题开关的档位）才保留 2px 环。 */
.overlay-frame button:focus-visible { outline: none; background: var(--surface-hover); }
.overlay-frame .engine-choice[aria-pressed='true']:focus-visible {
  background: color-mix(in srgb, var(--engine-accent) 20%, var(--surface-toolbar));
}
.overlay-frame button:focus:not(:focus-visible) { outline: none; }

/* 面板与飞窗同一套分层：卡片（圆角 12 + 真投影）取 `overlay-panel.css` 的共用类，
   投影画在视图外扩出来的透明边距里（数值来自 `OVERLAY_GUTTER`，见 OverlayHost）。
   这里只留引擎档位与站点规则的排布。 */
.overlay-frame { box-sizing: border-box; width: 100%; height: 100vh; display: flex; align-items: flex-start; }
.overlay-frame.flyout { padding: 0 var(--overlay-gutter, 12px) var(--overlay-gutter, 12px); }
.toast {
  background: var(--surface-toolbar);
  /* 提示条也留了一圈透明边距（`ShellOverlay` 的 inline padding），所以同样用真投影。 */
  border: 0;
  border-radius: 12px;
  box-shadow: 0 2px 6px rgb(0 0 0 / 10%), 0 8px 20px rgb(0 0 0 / 14%);
}
.engine-choices { display: grid; gap: 2px; }
.engine-choice {
  display: grid; grid-template-columns: 22px 1fr auto 14px; gap: 7px; align-items: center;
  min-height: 32px; padding: 4px 6px; border-radius: var(--radius-control); border: 1px solid transparent;
  text-align: left; font-size: 12px;
}
.engine-choice:not([aria-disabled='true']):hover, .toast-close:hover { background: var(--surface-hover); }
.engine-choice[aria-pressed='true'] {
  background: var(--surface-selected); border-color: color-mix(in srgb, var(--engine-accent) 20%, transparent);
}
.engine-symbol {
  display: grid; place-items: center; width: 22px; height: 22px; border-radius: 7px;
  background: color-mix(in srgb, currentColor 13%, transparent);
}
.engine-symbol.ppapi { color: var(--engine-flash); }
.engine-symbol.ruffle { color: var(--engine-ruffle); }
.engine-symbol .shell-icon { width: 13px; height: 13px; }
.choice-check { width: 14px; height: 14px; color: var(--engine-accent); visibility: hidden; }
.engine-choice[aria-pressed='true'] .choice-check { visibility: visible; }
.desc { font-size: 11px; color: var(--text-secondary); }
.site-rule { margin-top: 6px; padding: 6px 6px 1px; border-top: 1px solid var(--stroke-divider); }
.site-head, .site-control { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.site-head { font-size: 11px; }
.site-head strong { flex: none; }
.host {
  max-width: 76%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 4px;
  font-size: 10px; color: var(--text-secondary); border: 1px solid var(--stroke-divider);
  background: var(--surface-page); border-radius: 5px;
}
.site-control { min-height: 27px; margin-top: 2px; font-size: 12px; }
.remember {
  width: 31px; height: 18px; border: 1px solid var(--stroke-control); border-radius: var(--radius-pill);
  background: var(--surface-page); padding: 2px; display: flex; align-items: center; flex: none;
}
.remember span { width: 12px; height: 12px; border-radius: 50%; background: var(--text-secondary); }
.remember[aria-checked='true'] { justify-content: end; background: var(--engine-accent); border-color: var(--engine-accent); }
.remember[aria-checked='true'] span { background: var(--surface-toolbar); }
.remember:disabled { opacity: .45; }
.override-text { margin: 4px 0 0; color: var(--engine-override); font-size: 12px; }
.site-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 5px; }
.toast { display: flex; align-items: flex-start; gap: 8px; padding: 8px; font-size: 12px; }
.toast p { flex: 1; margin: 2px 0; overflow-wrap: anywhere; }
.toast-icon { color: var(--text-error); margin-top: 2px; }
.toast-close { display: grid; place-items: center; width: 23px; height: 23px; padding: 0; border-radius: 5px; flex: none; }
.toast-close .shell-icon { width: 14px; height: 14px; }
@media (forced-colors: active) {
  .engine-choice[aria-pressed='true'] { border-color: Highlight; }
  .remember span { forced-color-adjust: none; background: ButtonText; }
  .remember[aria-checked='true'] span { background: Highlight; }
}
</style>
