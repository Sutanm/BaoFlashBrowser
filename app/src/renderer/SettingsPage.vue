<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { SettingsSnapshot, ThemeMode } from '../shared/settings'
import type { BrowserEngine } from '../shared/engine'
import ThemeSwitch from './ThemeSwitch.vue'
import { applyShellTheme } from './theme'

/**
 * 内部设置页（`bao://settings`，对齐 Edge/Chrome 的设置页）。
 *
 * 数据来源只有一条：preload 暴露的 `baoSettings`。页面不持有权威状态——
 * 每次写入都用主进程返回的快照覆盖本地值，因此「叠加层改了主题 → 页面立刻跟着变」
 * 是同一份 store 的自然结果，不需要额外同步逻辑。
 */
const snapshot = ref<SettingsSnapshot>()
const busy = ref(false)
const error = ref('')

const failureText: Record<string, string> = {
  'forbidden-sender': '当前页面无权修改设置',
  'invalid-setting': '无效的设置项',
  'settings-save-failed': '设置未能保存，已保留原值',
  'storage-unavailable': '设置存储不可用，本次无法保存'
}

const current = computed(() => snapshot.value?.settings)
const theme = computed(() => current.value?.themeMode ?? 'system')
const engine = computed(() => current.value?.defaultEngine ?? 'ppapi')
const storage = computed(() => snapshot.value?.storage ?? 'ready')

let detach: (() => void) | undefined

function apply(next: SettingsSnapshot): void {
  snapshot.value = next
  applyShellTheme(next.theme)
}

onMounted(async () => {
  const initial = await window.baoSettings.read()
  if (initial) apply(initial)
  detach = window.baoSettings.subscribe(apply)
})

onBeforeUnmount(() => detach?.())

async function write(patch: { key: 'theme.mode' | 'engine.default' | 'locale'; value: string }): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await window.baoSettings.write(patch.key, patch.value as never)
    if (result.ok) apply(result.snapshot)
    else error.value = failureText[result.code] ?? '设置未能保存'
  } finally {
    busy.value = false
  }
}

function chooseTheme(mode: ThemeMode): void {
  void write({ key: 'theme.mode', value: mode })
}

function chooseEngine(next: BrowserEngine): void {
  if (next === 'ppapi' && !flashReady.value) return
  void write({ key: 'engine.default', value: next })
}

const flashReady = computed(() => snapshot.value?.flash !== false)

</script>

<template>
  <header class="settings-head">
    <h1>设置</h1>
    <p class="hint">bao://settings · 内部页，不记录历史</p>
    <p v-if="storage === 'unavailable'" class="warn" role="alert">
      设置存储不可用：本次修改不会保存，重启后回到默认值。
    </p>
  </header>

  <div class="settings-body">
    <nav class="settings-nav" aria-label="设置分类">
      <button type="button" aria-current="page"><span class="dot" aria-hidden="true"></span>外观</button>
      <button type="button" disabled>下载</button>
      <button type="button" disabled>隐私与清理</button>
      <button type="button" disabled>关于</button>
    </nav>

    <main class="settings-content">
      <section aria-labelledby="theme-title">
        <h2 id="theme-title">主题</h2>
        <div class="settings-theme">
          <ThemeSwitch :mode="theme" :busy="busy" @select="chooseTheme" />
        </div>
      </section>

      <section aria-labelledby="engine-title">
        <h2 id="engine-title">默认引擎</h2>
        <div role="radiogroup" aria-label="默认引擎" class="choices">
          <button
            type="button"
            class="choice"
            role="radio"
            :aria-checked="engine === 'ppapi'"
            :disabled="busy || !flashReady"
            :title="flashReady ? undefined : '未检测到 Flash 插件'"
            @click="chooseEngine('ppapi')"
          >
            <span class="radio" aria-hidden="true"></span>
            <span class="label">原生 Flash（PPAPI）</span>
          </button>
          <button
            type="button"
            class="choice"
            role="radio"
            :aria-checked="engine === 'ruffle'"
            :disabled="busy"
            @click="chooseEngine('ruffle')"
          >
            <span class="radio" aria-hidden="true"></span>
            <span class="label">Ruffle</span>
          </button>
        </div>
      </section>

      <section aria-labelledby="language-title">
        <h2 id="language-title">语言</h2>
        <label class="select-row">
          <span>界面语言</span>
          <select :value="current?.locale ?? 'zh-CN'" :disabled="busy" @change="write({ key: 'locale', value: ($event.target as HTMLSelectElement).value })">
            <option value="zh-CN">简体中文</option>
          </select>
        </label>
      </section>

      <p v-if="error" class="error" role="status">{{ error }}</p>
    </main>
  </div>
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
h1, h2, p { margin: 0; }
button, select { font: inherit; color: inherit; }
button { border: 0; background: none; cursor: pointer; }
button:disabled { cursor: default; opacity: 0.6; }
:focus-visible { outline: 2px solid var(--brand-stroke); outline-offset: -2px; }

.settings-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
  padding: 16px 22px 12px;
  border-bottom: 1px solid var(--stroke-divider);
}
.settings-head h1 { font-size: 17px; letter-spacing: -0.01em; }
.settings-head .hint { font-size: 11px; color: var(--text-secondary); }
.settings-head .warn {
  flex-basis: 100%;
  margin-top: 6px;
  padding: 6px 9px;
  border-radius: 7px;
  font-size: 12px;
  color: var(--text-error, #a82929);
  background: color-mix(in srgb, var(--text-error, #a82929) 10%, transparent);
}

.settings-body {
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr);
  height: calc(100vh - 62px);
  min-height: 0;
}
.settings-nav {
  padding: 10px 8px;
  border-right: 1px solid var(--stroke-divider);
  background: var(--surface-window);
  overflow: auto;
}
.settings-nav button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  border-radius: 7px;
  font-size: 12px;
  text-align: left;
}
.settings-nav button[aria-current='page'] {
  background: var(--engine-selection);
  color: var(--engine-accent);
  font-weight: 600;
}
.settings-nav button:disabled { color: var(--text-secondary); opacity: 0.55; }
.settings-nav .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  flex: none;
}

.settings-content {
  max-width: 760px;
  padding: 16px 24px 28px;
  overflow: auto;
}
.settings-content section + section {
  margin-top: 22px;
  padding-top: 18px;
  border-top: 1px solid var(--stroke-divider);
}
.settings-content h2 { font-size: 14px; font-weight: 650; margin-bottom: 2px; }
.settings-content .lead { font-size: 12px; color: var(--text-secondary); margin-bottom: 10px; }
.settings-content code {
  padding: 0 3px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--text-secondary) 12%, transparent);
  font-size: 11px;
}

.settings-theme { padding: 12px 0 3px; }

.choices { display: grid; gap: 4px; max-width: 470px; }
.choice {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 9px;
  border: 1px solid transparent;
  border-radius: 8px;
  font-size: 12px;
  text-align: left;
}
.choice:hover:not(:disabled) { background: var(--surface-hover); }
.choice[aria-checked='true'] {
  background: var(--engine-selection);
  border-color: color-mix(in srgb, var(--engine-accent) 22%, transparent);
}
.choice .radio {
  flex: none;
  width: 14px;
  height: 14px;
  border: 1.5px solid var(--text-secondary);
  border-radius: 50%;
  display: grid;
  place-items: center;
}
.choice[aria-checked='true'] .radio { border-color: var(--engine-accent); }
.choice[aria-checked='true'] .radio::after {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--engine-accent);
}
.choice .label { flex: 1; min-width: 0; }
.choice .sub { display: block; font-size: 11px; color: var(--text-secondary); }

.select-row {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 470px;
  padding: 7px 9px;
  border: 1px solid var(--stroke-control);
  border-radius: 8px;
  background: var(--surface-toolbar);
  font-size: 12px;
}
.select-row select {
  flex: 1;
  border: 0;
  background: none;
  padding: 2px 0;
}

.error { margin-top: 14px; font-size: 12px; color: var(--text-error, #a82929); }

@media (forced-colors: active) {
  .choice[aria-checked='true'] { outline: 1px solid Highlight; outline-offset: -1px; }
}
</style>
