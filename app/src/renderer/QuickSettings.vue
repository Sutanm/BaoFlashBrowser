<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { browserEngines, engineLabels } from '../shared/engine'
import type { BrowserEngine } from '../shared/engine'
import { THEME_MODES, themeModeLabels } from '../shared/settings'
import type { ThemeMode } from '../shared/settings'
import ShellIcon from './ShellIcon.vue'
import { applyShellTheme, initialShellTheme } from './theme'
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
const props = defineProps<{ kind: 'quick'; paused?: boolean }>()
/** 与 App.vue 的 QUICK_* 保持一致：浮层视图给面板四周留出投影空间。 */
/** 嵌入态：视图与面板同尺寸，不再为投影留白（留白会让面板看起来是悬浮的）。 */
const GUTTER_TOP = 0
const GUTTER_BOTTOM = 0

const store = useBrowserStore()
const { snapshot } = storeToRefs(store)
const panel = ref<HTMLElement>()
const busy = ref(false)
const error = ref('')

const settings = computed(() => snapshot.value?.settings)
const theme = computed<ThemeMode>(() => settings.value?.themeMode ?? 'system')
const themeModes = THEME_MODES
const quickThemeLabels: Record<ThemeMode, string> = { system: '系统', light: '浅色', dark: '深色' }
const engine = computed<BrowserEngine>(() => settings.value?.defaultEngine ?? 'ppapi')
const flashReady = computed(() => snapshot.value?.flash !== false)
const flashHint = computed(() => snapshot.value?.flashHint ?? '')

let detach: (() => void) | undefined
let observer: ResizeObserver | undefined

/**
 * 内容尺寸变了就告诉主进程（主进程再按窗口夹取，超出部分由本面板滚动）。
 *
 * 必须用 `scrollHeight`（内容高度）而不是 `getBoundingClientRect().height`：
 * 面板的 `max-height` 依赖视图高度（`100vh`），用盒子高度会形成
 * 「测量→缩小视图→再测量」的收缩反馈，最后塌成一条（实测踩过）。
 */
let lastSentHeight = 0

function measure(): void {
  const element = panel.value
  if (!element) return
  const contentHeight = element.scrollHeight
  if (contentHeight < 40) return
  // +2：`scrollHeight` 不含边框，留 1–2 px 余量避免"刚好相等"时冒出滚动条。
  const next = contentHeight + GUTTER_TOP + GUTTER_BOTTOM + 2
  // 高度没变就不上报：ResizeObserver 会在视图 bounds 变化后再次触发，
  // 每帧都发会变成「测量 ↔ 设 bounds」的正反馈（实测每秒上万次 IPC）。
  if (Math.abs(next - lastSentHeight) < 1) return
  lastSentHeight = next
  void window.baoOverlay.resizeQuick(next)
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

function onThemeKeydown(event: KeyboardEvent, index: number): void {
  const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key]
  if (step === undefined || busy.value) return
  event.preventDefault()
  const next = (index + step + themeModes.length) % themeModes.length
  const buttons = (event.currentTarget as HTMLElement).parentElement
    ?.querySelectorAll<HTMLButtonElement>('.theme-option')
  buttons?.[next]?.focus()
  chooseTheme(themeModes[next])
}

function chooseEngine(next: BrowserEngine): void {
  if (next === engine.value) return
  if (next === 'ppapi' && !flashReady.value) return
  void write('engine.default', next)
}

async function openSettings(): Promise<void> {
  // 先开设置页再关飞窗：`open-settings` 的发送者校验要求 quick 仍然可见。
  await store.run({ type: 'open-settings' })
  await window.baoOverlay.closeQuick(true)
}

/**
 * 「收藏夹」入口：请外壳在星标下方展开同一只飞窗的另一页。
 *
 * 为什么不在本文档里直接切页：锚点要贴着星标，而星标在外壳文档里——这里拿不到它的矩形。
 * 外壳本来就在管"飞窗挂在哪颗按钮下"，切页也交给它，就只有一个地方知道飞窗现在挂在谁下面。
 */
async function openBookmarks(): Promise<void> {
  await window.baoOverlay.openBookmarks()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  void window.baoOverlay.closeQuick(true)
}

onMounted(() => {
  detach = window.baoOverlay.subscribe((event) => {
    if (event.type === 'quick-opened') {
      // 打开事件带着当前主题：叠加层是常驻文档，光靠推送会漏（文档还没订阅时的事件）。
      applyShellTheme(event.theme)
      // 外壳给的初始高度只是猜测：每次打开都要重新上报一次，去重值必须一起清掉
      // （否则第二次打开会留下一截空白视图，盖住页面上的点击）。
      lastSentHeight = 0
      void nextTick(() => {
        // 不聚焦任何元素：面板用 tabindex 接过焦点会被 Chromium 画上默认焦点环
        // （打开飞窗就出现一圈黄边）。Tab 从文档进入时会先落到唯一可 tab 的选中档，
        // Esc 由主进程的 before-input-event 处理，不需要焦点。
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
applyShellTheme(initialShellTheme())
watch(() => snapshot.value?.theme, (theme) => { if (theme) applyShellTheme(theme) })
</script>

<template>
  <div class="quick-frame" @keydown="onKeydown">
    <section id="quick-settings" ref="panel" class="quick overlay-card" :data-kind="props.kind" role="dialog" aria-label="快捷设置">
      <p class="overlay-label">主题</p>
      <div class="quick-theme" role="radiogroup" aria-label="主题">
        <button
          v-for="(mode, index) in themeModes"
          :key="mode"
          type="button"
          class="theme-option"
          role="radio"
          :aria-checked="theme === mode"
          :aria-label="themeModeLabels[mode]"
          :title="themeModeLabels[mode]"
          :tabindex="theme === mode ? 0 : -1"
          :disabled="busy"
          @click="chooseTheme(mode)"
          @keydown="onThemeKeydown($event, index)"
        >
          {{ quickThemeLabels[mode] }}
        </button>
      </div>

      <div class="overlay-divider" role="presentation"></div>
      <p class="overlay-label">默认引擎</p>
      <div role="radiogroup" aria-label="默认引擎">
        <button
          v-for="name in browserEngines"
          :key="name"
          type="button"
          class="overlay-row engine"
          role="radio"
          :aria-checked="engine === name"
          :aria-disabled="busy || (name === 'ppapi' && !flashReady) ? 'true' : 'false'"
          :title="name === 'ppapi' && !flashReady
            ? `未检测到 Flash 插件（已自动查找本机已安装的 Flash）：把 pepflashplayer64.dll 放到 ${flashHint || '<exe目录>\\flash\\'} 后重启。`
            : undefined"
          @click="chooseEngine(name)"
        >
          <span class="overlay-radio" aria-hidden="true"></span>
          <span>{{ engineLabels[name] }}</span>
          <ShellIcon v-if="name === 'ppapi' && !flashReady" name="error" class="warn" />
          <ShellIcon v-else name="check" class="check" />
        </button>
      </div>

      <p v-if="error" class="overlay-error" role="status">{{ error }}</p>

      <div class="overlay-divider" role="presentation"></div>
      <!-- 两行都是"直接动作"（打开收藏夹页 / 打开设置标签），不是展开子菜单，
           所以不画 `>` —— 那个箭头会让人以为还要再展开一层。 -->
      <button type="button" class="overlay-row footer" @click="openBookmarks">
        <span class="lead-icon"><ShellIcon name="star" /></span>
        <span>收藏夹</span>
      </button>
      <button type="button" class="overlay-row footer" @click="openSettings">
        <span class="lead-icon"><ShellIcon name="gear" /></span>
        <span>全部设置</span>
      </button>
    </section>
  </div>
</template>

<style>
/* 单文档、无滚动条跳动：外层只负责铺满视图。
   卡片、分组标签、分隔线、行、radio 圆点都取 `overlay-panel.css` 的共用类——
   四个飞窗（快捷设置/引擎/收藏夹/编辑气泡）必须是同一套数值，各写一份就是漂移。 */
.shell-overlay, .shell-overlay body { margin: 0; overflow: hidden; background: transparent; }
.quick-frame {
  box-sizing: border-box;
  width: 100%;
  height: 100vh;
  /* 视图比卡片大一圈：四周（除顶边）留透明边距画投影。数值来自 OVERLAY_GUTTER，
     由 OverlayHost 写成 CSS 变量；透明边距里的鼠标由主进程转发给页面（见 shell-overlays.ts）。 */
  padding: 0 var(--overlay-gutter, 12px) var(--overlay-gutter, 12px);
  display: flex;
  align-items: flex-start;
}

/* 只有这一页独有的排布留在这里。 */
.overlay-row.engine { grid-template-columns: 13px 1fr auto; }
.overlay-row.footer { grid-template-columns: 18px 1fr; min-height: 38px; }
.overlay-row[aria-disabled='true'] { opacity: .45; cursor: default; }
/* 菜单式的键盘焦点：整行高亮，不画环（Chrome 的菜单项就是这么做的）。
   选中行本来就有底色，聚焦时换成更饱和的 accent 混合色，保证「聚焦」看得出来。 */
.overlay-row[aria-checked='true']:focus-visible {
  background: color-mix(in srgb, var(--engine-accent) 20%, var(--surface-toolbar));
}

.quick-theme {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 3px;
  margin: 5px 8px 8px;
  padding: 3px;
  border: 1px solid var(--stroke-control);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface-page) 72%, var(--surface-toolbar));
}
.quick .theme-option {
  min-width: 0;
  min-height: 32px;
  padding: 4px 7px;
  border-radius: 7px;
  color: var(--text-secondary);
  font-size: 12px;
  white-space: nowrap;
}
.quick .theme-option:hover:not(:disabled):not([aria-checked='true']) { background: var(--surface-hover); }
.quick .theme-option[aria-checked='true'] {
  color: var(--text-primary);
  background: var(--surface-toolbar);
  box-shadow: 0 1px 3px rgb(0 0 0 / 12%);
  font-weight: 600;
}
.quick .theme-option:focus:not(:focus-visible) { outline: none; }
.quick .theme-option:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 1px var(--stroke-focus-ring);
}

.overlay-row .check { width: 13px; height: 13px; color: var(--engine-accent); visibility: hidden; }
.overlay-row[aria-checked='true'] .check { visibility: visible; }
.overlay-row .warn { width: 13px; height: 13px; color: var(--engine-override); }

.overlay-row.footer .lead-icon { display: grid; place-items: center; color: var(--text-secondary); }
.overlay-row.footer .lead-icon .shell-icon { width: 15px; height: 15px; }
.overlay-row.footer:hover .lead-icon { color: var(--text-primary); }



@media (forced-colors: active) {
  .overlay-row[aria-checked='true'] { outline: 1px solid Highlight; outline-offset: -1px; }
  .theme-option[aria-checked='true'] { outline: 1px solid Highlight; outline-offset: -1px; }
}
</style>
