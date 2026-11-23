<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { browserEngines, engineLabels } from '../shared/engine'
import type { BrowserEngine } from '../shared/engine'
import type { ThemeMode } from '../shared/settings'
import ShellIcon from './ShellIcon.vue'
import ThemeSwitch from './ThemeSwitch.vue'
import { applyShellTheme } from './theme'
import { useBrowserStore } from './stores/browser'

/**
 * 齿轮快捷设置（`?baoOverlay=quick`，M2 增量 2 下半）。
 *
 * 视觉取 Chromium 的菜单数值：圆角 12（`kMenuRadius → kMediumSmall`）、
 * 投影 `0 12px 48px α.24 + 0 0 24px α.12`（`bubble_menu_shadow_elevation = 12` 走
 * `MakeMdShadowValues`）、边框 `kColorMenuBorder`。**不画右上角 X**：点外部 / Esc 关闭。
 *
 * 飞窗永远在窗口内（Electron 的 WebContentsView 被窗口裁剪，见
 * `docs/design/gear-quick-settings.html` 的说明），所以内容超出时自身滚动。
 */
const props = defineProps<{ kind: 'quick' }>()
/** 与 App.vue 的 QUICK_* 保持一致：浮层视图给面板四周留出投影空间。 */
const GUTTER_TOP = 16
const GUTTER_BOTTOM = 16
const GUTTER_LEFT = 16
const GUTTER_RIGHT = 8

const store = useBrowserStore()
const { snapshot } = storeToRefs(store)
const panel = ref<HTMLElement>()
const busy = ref(false)
const error = ref('')

const settings = computed(() => snapshot.value?.settings)
const theme = computed<ThemeMode>(() => settings.value?.themeMode ?? 'system')
const engine = computed<BrowserEngine>(() => settings.value?.defaultEngine ?? 'ppapi')
const flashReady = computed(() => snapshot.value?.flash !== false)

let detach: (() => void) | undefined
let observer: ResizeObserver | undefined

/**
 * 内容尺寸变了就告诉主进程（主进程再按窗口夹取，超出部分由本面板滚动）。
 *
 * 必须用 `scrollHeight`（内容高度）而不是 `getBoundingClientRect().height`：
 * 面板的 `max-height` 依赖视图高度（`100vh`），用盒子高度会形成
 * 「测量→缩小视图→再测量」的收缩反馈，最后塌成一条（实测踩过）。
 */
function measure(): void {
  const element = panel.value
  if (!element) return
  const contentHeight = element.scrollHeight
  if (contentHeight < 40) return
  // +2：`scrollHeight` 不含边框，留 1–2 px 余量避免"刚好相等"时冒出滚动条。
  void window.baoOverlay.resizeQuick(contentHeight + GUTTER_TOP + GUTTER_BOTTOM + 2)
}

async function write(key: 'theme.mode' | 'engine.default', value: string): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    if (!await store.run({ type: 'set-setting', key: key as never, value: value as never })) {
      error.value = store.message || '设置未能保存'
      return
    }
    await nextTick()
    measure()
  } finally {
    busy.value = false
  }
}

function chooseTheme(mode: ThemeMode): void {
  if (mode !== theme.value) void write('theme.mode', mode)
}

function chooseEngine(next: BrowserEngine): void {
  if (next === engine.value) return
  if (next === 'ppapi' && !flashReady.value) return
  void write('engine.default', next)
}

async function openSettings(): Promise<void> {
  await window.baoOverlay.closeQuick(true)
  await store.run({ type: 'open-settings' })
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  void window.baoOverlay.closeQuick(true)
}

onMounted(() => {
  detach = window.baoOverlay.subscribe((event) => {
    if (event.type === 'quick-opened') {
      void nextTick(() => {
        panel.value?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus()
        measure()
      })
    }
  })
  observer = new ResizeObserver(measure)
  if (panel.value) observer.observe(panel.value)
  store.connect()
  void nextTick(measure)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  detach?.()
  store.disconnect()
})

watch(() => snapshot.value?.settings, () => { void nextTick(measure) })
// 飞窗是独立文档：必须自己应用一次 token（否则外壳变量不在这里，面板会掉回浏览器默认色）。
applyShellTheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
watch(() => snapshot.value?.theme, (theme) => { if (theme) applyShellTheme(theme) })
</script>

<template>
  <div class="quick-frame" @keydown="onKeydown">
    <section ref="panel" class="quick" :data-kind="props.kind" aria-label="快捷设置">
      <p class="group-label">主题</p>
      <div class="quick-theme">
        <ThemeSwitch :mode="theme" :busy="busy" compact @select="chooseTheme" />
      </div>

      <div class="divider" role="presentation"></div>
      <p class="group-label">默认引擎</p>
      <div role="radiogroup" aria-label="默认引擎">
        <button
          v-for="name in browserEngines"
          :key="name"
          type="button"
          class="row engine"
          role="radio"
          :aria-checked="engine === name"
          :disabled="busy || (name === 'ppapi' && !flashReady)"
          :title="name === 'ppapi' && !flashReady ? '未检测到 Flash 插件' : undefined"
          @click="chooseEngine(name)"
        >
          <span class="radio" aria-hidden="true"></span>
          <span>{{ engineLabels[name] }}</span>
          <ShellIcon v-if="name === 'ppapi' && !flashReady" name="error" class="warn" />
          <ShellIcon v-else name="check" class="check" />
        </button>
      </div>

      <p v-if="error" class="error" role="status">{{ error }}</p>

      <div class="divider" role="presentation"></div>
      <button type="button" class="row footer" @click="openSettings">
        <span class="lead-icon"><ShellIcon name="gear" /></span>
        <span>全部设置</span>
        <span class="chev"><ShellIcon name="chevron" /></span>
      </button>
    </section>
  </div>
</template>

<style>
/* 单文档、无滚动条跳动：外层只负责留出投影空间（与 App.vue 的 QUICK_* 一致）。 */
.shell-overlay, .shell-overlay body { margin: 0; overflow: hidden; background: transparent; }
.quick-frame { box-sizing: border-box; width: 100%; height: 100vh; padding: 16px 8px 16px 16px; display: flex; align-items: flex-start; }

/* Chromium 菜单数值：圆角 12、阴影 elevation 12、边框 kColorMenuBorder（这里用 token）。 */
.quick {
  box-sizing: border-box;
  width: 100%;
  max-height: calc(100vh - 32px);
  overflow: auto;
  padding: 6px;
  border: 1px solid var(--stroke-divider);
  border-radius: 12px;
  background: var(--surface-toolbar);
  box-shadow: 0 12px 48px color-mix(in srgb, #3c4043 24%, transparent),
              0 0 24px color-mix(in srgb, #3c4043 12%, transparent);
  font: var(--size-body)/1.4 var(--shell-font);
  color: var(--text-primary);
}
.quick *, .quick *::before, .quick *::after { box-sizing: border-box; }
.quick :where(button) { font: inherit; color: inherit; border: 0; background: none; cursor: pointer; }
.quick button:disabled { cursor: default; }

.group-label { margin: 0; padding: 6px 9px 2px; font-size: 11px; color: var(--text-secondary); }
.divider { height: 1px; margin: 6px 4px; background: var(--stroke-divider); }

.row {
  display: grid; align-items: center; gap: 9px; width: 100%; min-height: 36px; padding: 0 9px;
  border-radius: 7px; text-align: left; font-size: 12px;
}
.row.engine { grid-template-columns: 13px 1fr auto; }
.row.footer { grid-template-columns: 18px 1fr 14px; min-height: 38px; }
.row:hover:not(:disabled) { background: var(--surface-hover); }
.row:disabled { opacity: .45; }
.row[aria-checked='true'] { background: var(--engine-selection); }
.row:focus-visible { outline: 2px solid var(--brand-stroke); outline-offset: -2px; }

.radio { width: 13px; height: 13px; border: 1.5px solid var(--text-secondary); border-radius: 50%; display: grid; place-items: center; }
.row[aria-checked='true'] .radio { border-color: var(--engine-accent); }
.row[aria-checked='true'] .radio::after { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--engine-accent); }

.quick-theme { padding: 5px 9px 8px; }

.row .check { width: 13px; height: 13px; color: var(--engine-accent); visibility: hidden; }
.row[aria-checked='true'] .check { visibility: visible; }
.row .warn { width: 13px; height: 13px; color: var(--engine-override); }

.row.footer .lead-icon, .row.footer .chev { display: grid; place-items: center; color: var(--text-secondary); }
.row.footer .lead-icon .shell-icon { width: 15px; height: 15px; }
.row.footer .chev .shell-icon { width: 14px; height: 14px; /* chevron 是向下箭头，旋成向右 */ transform: rotate(-90deg); }
.row.footer:hover .lead-icon, .row.footer:hover .chev { color: var(--text-primary); }

.error { margin: 6px 9px 2px; font-size: 11px; color: var(--text-error); }

@media (forced-colors: active) {
  .row[aria-checked='true'] { outline: 1px solid Highlight; outline-offset: -1px; }
}
</style>
