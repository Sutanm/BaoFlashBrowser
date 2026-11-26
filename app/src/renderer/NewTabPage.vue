<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { engineLabels } from '../shared/engine'
import type { ThemeMode } from '../shared/settings'
import type { NtpSnapshot } from '../shared/ntp'
import ShellIcon from './ShellIcon.vue'
import ThemeSwitch from './ThemeSwitch.vue'
import { applyShellTheme } from './theme'

/**
 * 新标签页（`bao://newtab`）：关键首帧由 `newtab.html` 先画出同尺寸的品牌与 realbox，
 * Vue 接管交互后再补真实的 Flash / 默认引擎 / 存储状态。没有数据源的历史与推荐不伪造。
 */
const snapshot = ref<NtpSnapshot>()
const address = ref('')
const error = ref('')
const busy = ref(false)
const themeBusy = ref(false)
const field = ref<HTMLInputElement>()

let detach: (() => void) | undefined
let revealFrame: number | undefined
const systemTheme = matchMedia('(prefers-color-scheme: dark)')

const failureText: Record<string, string> = {
  'invalid-address': '请输入有效的 HTTP 或 HTTPS 网址',
  'forbidden-sender': '当前页面无权执行该操作',
  'invalid-command': '无效的操作',
  'invalid-setting': '无效的主题设置',
  'settings-save-failed': '主题未能保存，已保留原值',
  'storage-unavailable': '设置存储不可用，本次无法保存'
}

const flashReady = computed(() => snapshot.value?.flash === true)
const flashTitle = computed(() => snapshot.value
  ? (flashReady.value ? '原生 Flash 已就绪' : '尚未检测到 Flash')
  : '正在检测 Flash')
const flashDetail = computed(() => flashReady.value ? 'PPAPI 插件可以直接运行经典内容' : '可在设置中导入本地插件')
const defaultEngine = computed(() => snapshot.value?.settings.defaultEngine)
const defaultEngineLabel = computed(() => defaultEngine.value ? engineLabels[defaultEngine.value] : '正在读取')
const themeMode = computed<ThemeMode>(() => snapshot.value?.settings.themeMode ?? 'system')
const storageWarning = computed(() => snapshot.value?.storage === 'unavailable')

function applyTheme(theme?: 'light' | 'dark'): void {
  applyShellTheme(theme ?? (systemTheme.matches ? 'dark' : 'light'))
}

function apply(next: NtpSnapshot): void {
  snapshot.value = next
  applyTheme(next.theme)
}

function onSystemTheme(): void {
  if (!snapshot.value) applyTheme()
}

function revealApp(): void {
  document.documentElement.dataset.ntpReady = 'true'
  document.getElementById('ntp-first-paint')?.remove()
}

onMounted(async () => {
  applyTheme()
  systemTheme.addEventListener('change', onSystemTheme)
  // 下一帧直接用完全同尺寸的 Vue 内容接管关键首帧；不做整页淡入，避免「一起刷新」感。
  revealFrame = requestAnimationFrame(revealApp)
  const initial = await window.baoNtp.read()
  if (initial) apply(initial)
  detach = window.baoNtp.subscribe(apply)
})

onBeforeUnmount(() => {
  detach?.()
  if (revealFrame !== undefined) cancelAnimationFrame(revealFrame)
  systemTheme.removeEventListener('change', onSystemTheme)
})

function blurInput(): void {
  field.value?.blur()
}

function focusRealbox(): void {
  field.value?.focus()
}

async function submit(): Promise<void> {
  if (busy.value) return
  const value = address.value.trim()
  if (!value) return
  busy.value = true
  error.value = ''
  try {
    const result = await window.baoNtp.run({ type: 'navigate', address: value })
    if (!result.ok) error.value = failureText[result.code] ?? '无法打开这个地址'
    else address.value = ''
  } catch {
    error.value = '无法打开这个地址'
  } finally {
    busy.value = false
  }
}

async function openSettings(): Promise<void> {
  error.value = ''
  try {
    const result = await window.baoNtp.run({ type: 'open-settings' })
    if (!result.ok) error.value = failureText[result.code] ?? '无法打开设置'
  } catch {
    error.value = '无法打开设置'
  }
}

async function chooseTheme(mode: ThemeMode): Promise<void> {
  if (themeBusy.value || mode === themeMode.value) return
  themeBusy.value = true
  error.value = ''
  try {
    const result = await window.baoNtp.run({ type: 'set-theme', mode })
    if (!result.ok) error.value = failureText[result.code] ?? '无法切换主题'
  } catch {
    error.value = '无法切换主题'
  } finally {
    themeBusy.value = false
  }
}
</script>

<template>
  <main class="newtab">
    <section class="hero" aria-labelledby="ntp-title">
      <div class="brand-lockup">
        <span class="brand-mark" aria-hidden="true">BF</span>
        <div>
          <h1 id="ntp-title" class="wordmark">BaoFlashBrowser Next</h1>
          <p class="tagline">为经典网页与 Flash 内容而生</p>
        </div>
      </div>

      <form class="realbox" role="search" @submit.prevent="submit">
        <span class="search-symbol" aria-hidden="true"></span>
        <input
          ref="field"
          v-model="address"
          type="text"
          name="address"
          aria-label="搜索或输入网址"
          placeholder="搜索或输入网址"
          autocomplete="off"
          spellcheck="false"
          :disabled="busy"
          @keydown.esc="blurInput"
        >
        <button type="submit" class="go" :disabled="busy || !address.trim()">打开</button>
      </form>
      <p class="message" :class="{ visible: error }" role="status">{{ error || '占位' }}</p>
    </section>

    <section v-if="snapshot" class="theme-shortcut" aria-label="主题快捷切换">
      <div class="theme-shortcut-copy">
        <strong>界面主题</strong>
        <small>让新标签页跟着你的心情变换</small>
      </div>
      <ThemeSwitch :mode="themeMode" :busy="themeBusy" @select="chooseTheme" />
    </section>

    <section v-if="snapshot" class="utility-grid" aria-label="浏览器状态与快捷操作">
      <article class="utility-card">
        <span class="utility-icon" :class="{ ready: flashReady }">
          <ShellIcon :name="flashReady ? 'check' : 'error'" />
        </span>
        <span class="utility-copy">
          <strong>{{ flashTitle }}</strong>
          <small>{{ flashDetail }}</small>
        </span>
        <button v-if="!flashReady" type="button" class="card-action" @click="openSettings">导入</button>
      </article>

      <article class="utility-card">
        <span class="utility-icon engine">
          <ShellIcon :name="defaultEngine === 'ppapi' ? 'flash' : 'ruffle'" />
        </span>
        <span class="utility-copy">
          <strong>默认引擎 · {{ defaultEngineLabel }}</strong>
          <small>新页面将优先使用此渲染方式</small>
        </span>
      </article>

      <button type="button" class="utility-card settings-card" :disabled="busy" @click="openSettings">
        <span class="utility-icon"><ShellIcon name="gear" /></span>
        <span class="utility-copy">
          <strong>浏览器设置</strong>
          <small>主题、引擎与会话偏好</small>
        </span>
        <span class="card-arrow" aria-hidden="true">›</span>
      </button>
    </section>

    <button type="button" class="keyboard-hint" @click="focusRealbox">
      按 <kbd>Ctrl</kbd> + <kbd>L</kbd> 随时输入网址
    </button>

    <p v-if="storageWarning" class="warn" role="alert">设置存储不可用：改动不会保存。</p>
  </main>
</template>

<style>
:root {
  color-scheme: light;
  font: var(--size-body, 13px)/1.5 var(--shell-font);
  color: var(--text-primary);
  background: var(--surface-page);
}

:root[data-theme='dark'] { color-scheme: dark; }

* { box-sizing: border-box; }
html, body, #app { height: 100%; }
body { margin: 0; background: var(--surface-page); }
h1, p { margin: 0; }
button, input { font: inherit; color: inherit; }
button { border: 0; background: none; cursor: pointer; }
button:disabled { cursor: default; opacity: 0.6; }
input:disabled { opacity: 0.7; }

:focus:not(:focus-visible) { outline: none; }
:focus-visible {
  outline: 2px solid var(--stroke-focus-ring);
  outline-offset: 2px;
}

.newtab {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: min(960px, 100%);
  min-height: 100%;
  margin: 0 auto;
  padding: clamp(74px, 16vh, 154px) 30px 42px;
}

.hero { width: 100%; }

.brand-lockup {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 15px;
  margin-bottom: 28px;
}

.brand-mark {
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  border-radius: 15px;
  background: linear-gradient(145deg, var(--accent), var(--accent-strong));
  color: var(--surface-toolbar);
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.04em;
  box-shadow: 0 8px 24px color-mix(in srgb, var(--engine-accent) 20%, transparent);
}

.wordmark {
  font-size: clamp(30px, 3vw, 40px);
  font-weight: 650;
  line-height: 1.05;
  letter-spacing: -0.035em;
}

.tagline {
  margin-top: 5px;
  color: var(--text-secondary);
  font-size: 13px;
}

.realbox {
  display: flex;
  align-items: center;
  gap: 13px;
  width: 100%;
  height: 58px;
  padding: 0 7px 0 21px;
  border: 1px solid var(--stroke-control);
  border-radius: var(--radius-pill, 29px);
  background: var(--surface-toolbar);
  box-shadow: 0 5px 18px color-mix(in srgb, var(--text-primary) 9%, transparent);
  transition: border-color var(--motion-normal, 180ms) ease, box-shadow var(--motion-normal, 180ms) ease;
}

.realbox:focus-within {
  border-color: var(--brand-stroke);
  box-shadow: 0 6px 22px color-mix(in srgb, var(--brand-stroke) 18%, transparent), inset 0 0 0 1px var(--brand-stroke);
}

.search-symbol {
  position: relative;
  width: 17px;
  height: 17px;
  flex: none;
  border: 1.7px solid var(--text-secondary);
  border-radius: 50%;
}
.search-symbol::after {
  position: absolute;
  right: -5px;
  bottom: -3px;
  width: 7px;
  height: 1.7px;
  border-radius: 2px;
  background: var(--text-secondary);
  content: '';
  transform: rotate(45deg);
}

.realbox input {
  flex: 1;
  width: 0;
  height: 100%;
  padding: 0;
  border: 0;
  outline: none;
  background: transparent;
  font-size: 15px;
}
.realbox input::placeholder { color: var(--text-secondary); opacity: 1; }

.realbox .go {
  height: 44px;
  min-width: 76px;
  padding: 0 20px;
  border-radius: var(--radius-pill, 23px);
  background: var(--surface-hover);
  font-size: 13px;
  font-weight: 600;
}
.realbox .go:hover:not(:disabled) { background: var(--surface-pressed); }

.message {
  height: 25px;
  padding-top: 6px;
  color: transparent;
  font-size: 12px;
  text-align: center;
}
.message.visible { color: var(--text-error, #a82929); }

.theme-shortcut {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 28px;
  width: 100%;
  min-height: 132px;
  padding: 15px 28px 9px;
  border: 1px solid color-mix(in srgb, var(--stroke-divider) 72%, transparent);
  border-radius: calc(var(--radius-surface, 14px) + 2px);
  background:
    radial-gradient(circle at 78% 25%, color-mix(in srgb, var(--brand-stroke) 9%, transparent), transparent 42%),
    color-mix(in srgb, var(--surface-toolbar) 76%, var(--surface-page));
  box-shadow: 0 8px 28px color-mix(in srgb, var(--text-primary) 5%, transparent);
}
.theme-shortcut-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.theme-shortcut-copy strong { font-size: 15px; font-weight: 650; }
.theme-shortcut-copy small { color: var(--text-secondary); font-size: 12px; }
.theme-shortcut .bao-theme-switch { flex: none; }

.utility-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  width: 100%;
  margin-top: 12px;
  animation: utility-arrive 100ms ease-out both;
}

@keyframes utility-arrive {
  from { opacity: 0; transform: translateY(2px); }
  to { opacity: 1; transform: translateY(0); }
}

.utility-card {
  display: flex;
  align-items: center;
  min-width: 0;
  min-height: 88px;
  padding: 15px;
  border: 1px solid color-mix(in srgb, var(--stroke-divider) 72%, transparent);
  border-radius: var(--radius-surface, 14px);
  background: color-mix(in srgb, var(--surface-toolbar) 72%, var(--surface-page));
  text-align: left;
}

button.utility-card { width: 100%; }
button.utility-card:hover:not(:disabled) { background: var(--surface-hover); }

.utility-icon {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  flex: none;
  border-radius: 12px;
  background: color-mix(in srgb, var(--text-error, #a82929) 10%, transparent);
  color: var(--text-error, #a82929);
}
.utility-icon.ready {
  background: color-mix(in srgb, var(--engine-accent) 12%, transparent);
  color: var(--engine-accent);
}
.utility-icon.engine {
  background: color-mix(in srgb, var(--brand-stroke) 11%, transparent);
  color: var(--brand-stroke);
}
.utility-icon .shell-icon { width: 20px; height: 20px; }

.utility-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 3px;
  margin-left: 12px;
}
.utility-copy strong {
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.utility-copy small {
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-action {
  flex: none;
  margin-left: 8px;
  padding: 5px 9px;
  border-radius: 7px;
  color: var(--engine-accent);
  font-size: 12px;
}
.card-action:hover { background: var(--surface-pressed); }
.card-arrow { margin-left: 8px; color: var(--text-secondary); font-size: 22px; }

.keyboard-hint {
  margin-top: auto;
  padding-top: 34px;
  color: var(--text-secondary);
  font-size: 11px;
}
.keyboard-hint:hover { color: var(--text-primary); }
.keyboard-hint kbd {
  padding: 1px 5px;
  border: 1px solid var(--stroke-control);
  border-radius: 4px;
  background: var(--surface-toolbar);
  font: inherit;
}

.warn {
  margin-top: 12px;
  padding: 7px 11px;
  border-radius: 7px;
  color: var(--text-error, #a82929);
  background: color-mix(in srgb, var(--text-error, #a82929) 10%, transparent);
  font-size: 12px;
}

@media (max-width: 760px) {
  .newtab { padding: 52px 20px 30px; }
  .brand-lockup { justify-content: flex-start; }
  .brand-mark { width: 46px; height: 46px; }
  .wordmark { font-size: 29px; }
  .realbox { height: 54px; }
  .theme-shortcut { align-items: flex-start; flex-direction: column; padding: 18px 20px 10px; }
  .theme-shortcut .bao-theme-switch { align-self: center; }
  .utility-grid { grid-template-columns: 1fr; }
  .utility-card { min-height: 72px; }
}

@media (forced-colors: active) {
  .realbox, .utility-card { border-color: CanvasText; }
  .realbox:focus-within { outline: 2px solid Highlight; outline-offset: -2px; }
}

@media (prefers-reduced-motion: reduce) {
  .utility-grid { animation: none; }
}
</style>
