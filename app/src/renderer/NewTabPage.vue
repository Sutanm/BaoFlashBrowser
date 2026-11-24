<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { NtpSnapshot } from '../shared/ntp'
import { applyShellTheme } from './theme'

/**
 * 新标签页（`bao://newtab`）——对齐 Chrome NTP 的页面职责 v1。
 *
 * 现在能做的事都有真实数据源或真实动作：
 * - realbox：与地址栏同一套解析（主进程 `parseAddress`），回车在**本标签**导航；
 * - 设置入口：与 `Ctrl+,` 同一条单例规则（已有设置页就切过去，否则就地覆盖本页）；
 * - 状态：原生 Flash 插件是否可用（BYOP 下这是用户最需要知道的事）。
 *
 * 快捷方式/最近访问需要历史与书签（尚未实现），所以**不画空板块**。
 * 数据只来自 preload 暴露的 `baoNtp`，页面不持有权威状态。
 */
const snapshot = ref<NtpSnapshot>()
const address = ref('')
const error = ref('')
const busy = ref(false)
const field = ref<HTMLInputElement>()

let detach: (() => void) | undefined
const systemTheme = matchMedia('(prefers-color-scheme: dark)')

const failureText: Record<string, string> = {
  'invalid-address': '请输入有效的 HTTP 或 HTTPS 网址',
  'forbidden-sender': '当前页面无权执行该操作',
  'invalid-command': '无效的操作'
}

const flashReady = computed(() => snapshot.value?.flash === true)
const flashText = computed(() =>
  snapshot.value ? (flashReady.value ? '原生 Flash 已就绪' : '未检测到 Flash 插件') : '')
const storageWarning = computed(() => snapshot.value?.storage === 'unavailable')

function applyTheme(theme?: 'light' | 'dark'): void {
  applyShellTheme(theme ?? (systemTheme.matches ? 'dark' : 'light'))
}

function apply(next: NtpSnapshot): void {
  snapshot.value = next
  applyTheme(next.theme)
}

function onSystemTheme(): void {
  // 有主进程快照时以它为准（它就是 nativeTheme 解析后的结果）。
  if (!snapshot.value) applyTheme()
}

onMounted(async () => {
  applyTheme()
  systemTheme.addEventListener('change', onSystemTheme)
  const initial = await window.baoNtp.read()
  if (initial) apply(initial)
  detach = window.baoNtp.subscribe(apply)
})

onBeforeUnmount(() => {
  detach?.()
  systemTheme.removeEventListener('change', onSystemTheme)
})

function blurInput(): void {
  field.value?.blur()
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
</script>

<template>
  <main class="newtab">
    <h1 class="wordmark">BaoFlashBrowser Next</h1>

    <form class="realbox" role="search" @submit.prevent="submit">
      <input
        ref="field"
        v-model="address"
        type="text"
        name="address"
        aria-label="搜索或输入网址"
        placeholder="输入网址"
        autocomplete="off"
        spellcheck="false"
        :disabled="busy"
        @keydown.esc="blurInput"
      >
      <button type="submit" class="go" :disabled="busy || !address.trim()">打开</button>
    </form>
    <p v-if="error" class="error" role="status">{{ error }}</p>

    <footer class="foot">
      <span class="flash" :class="{ ready: flashReady }">{{ flashText }}</span>
      <button type="button" class="link" :disabled="busy" @click="openSettings">
        {{ flashReady ? '设置' : '打开设置导入' }}
      </button>
    </footer>

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
html, body { height: 100%; }
body { margin: 0; background: var(--surface-page); }
h1, p { margin: 0; }
button, input { font: inherit; color: inherit; }
button { border: 0; background: none; cursor: pointer; }
button:disabled { cursor: default; opacity: 0.6; }
input:disabled { opacity: 0.7; }

/* 只有键盘操作才画焦点环，环与设置页/外壳同一套（2px、外侧、accent 62%）。 */
:focus:not(:focus-visible) { outline: none; }
:focus-visible {
  outline: 2px solid var(--stroke-focus-ring);
  outline-offset: 1px;
}

.newtab {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  width: min(640px, 100%);
  min-height: 100%;
  margin: 0 auto;
  padding: clamp(72px, 22vh, 200px) 24px 48px;
}

.wordmark {
  font-size: 28px;
  font-weight: 650;
  letter-spacing: -0.02em;
  text-align: center;
}

.realbox {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 46px;
  margin-top: 6px;
  padding: 0 6px 0 18px;
  border: 1px solid var(--stroke-control);
  border-radius: var(--radius-pill, 24px);
  background: var(--surface-toolbar);
  transition: border-color var(--motion-normal, 180ms) ease;
}
.realbox:focus-within {
  border-color: var(--brand-stroke);
  box-shadow: inset 0 0 0 1px var(--brand-stroke);
}
.realbox input {
  flex: 1;
  width: 0;
  height: 100%;
  padding: 0;
  border: 0;
  outline: none;
  background: transparent;
}
.realbox input::placeholder { color: var(--text-secondary); opacity: 1; }
.realbox .go {
  flex: none;
  height: 34px;
  padding: 0 16px;
  border-radius: var(--radius-pill, 20px);
  background: var(--surface-hover);
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 600;
}
.realbox .go:hover:not(:disabled) { background: var(--surface-pressed); }

.error { font-size: 12px; color: var(--text-error, #a82929); text-align: center; }

.foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-secondary);
}
.foot .flash { flex: none; }
.foot .flash.ready { color: var(--engine-accent); }
.foot .link {
  padding: 1px 6px;
  border-radius: 5px;
  color: var(--engine-accent);
  font-size: 12px;
}
.foot .link:hover:not(:disabled) { background: var(--surface-hover); }

.warn {
  margin-top: 8px;
  padding: 6px 10px;
  border-radius: 7px;
  font-size: 12px;
  color: var(--text-error, #a82929);
  background: color-mix(in srgb, var(--text-error, #a82929) 10%, transparent);
}

@media (forced-colors: active) {
  .realbox { border-color: CanvasText; }
  .realbox:focus-within { outline: 2px solid Highlight; outline-offset: -2px; }
}
</style>
