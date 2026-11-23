<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { themeModeLabels } from '../shared/settings'
import type { SettingsSnapshot, ThemeMode } from '../shared/settings'
import type { BrowserEngine } from '../shared/engine'
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
  void write({ key: 'engine.default', value: next })
}

const themes: Array<{ mode: ThemeMode; description: string }> = [
  { mode: 'system', description: '跟随 Windows 的浅色/深色' },
  { mode: 'light', description: '始终使用浅色' },
  { mode: 'dark', description: '始终使用深色' }
]
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
        <p class="lead">
          只影响浏览器界面与站点看到的 <code>prefers-color-scheme</code>；Flash 内容不会被反色。
        </p>
        <div class="theme-cards" role="radiogroup" aria-label="主题">
          <button
            v-for="item in themes"
            :key="item.mode"
            type="button"
            class="theme-card"
            role="radio"
            :aria-checked="theme === item.mode"
            :aria-label="`${themeModeLabels[item.mode]}：${item.description}`"
            :disabled="busy"
            @click="chooseTheme(item.mode)"
          >
            <span class="preview" :class="item.mode" aria-hidden="true">
              <span class="bar"><i></i><i></i><i></i></span>
              <span class="body"><i></i><i></i><i></i></span>
            </span>
            <span class="caption">{{ themeModeLabels[item.mode] }}</span>
          </button>
        </div>
      </section>

      <section aria-labelledby="engine-title">
        <h2 id="engine-title">默认引擎</h2>
        <p class="lead">站点规则优先于这里；在标签上手动切换过就沿用那次选择。</p>
        <div role="radiogroup" aria-label="默认引擎" class="choices">
          <button
            type="button"
            class="choice"
            role="radio"
            :aria-checked="engine === 'ppapi'"
            :disabled="busy"
            @click="chooseEngine('ppapi')"
          >
            <span class="radio" aria-hidden="true"></span>
            <span class="label">
              原生 Flash（PPAPI）
              <span class="sub">新站点默认使用；未检测到插件时自动回落 Ruffle</span>
            </span>
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
            <span class="label">Ruffle<span class="sub">不依赖插件，兼容优先</span></span>
          </button>
        </div>
      </section>

      <section aria-labelledby="language-title">
        <h2 id="language-title">语言</h2>
        <p class="lead">界面语言即时生效，不需要重启。</p>
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

.theme-cards {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  max-width: 470px;
}
.theme-card {
  padding: 6px 6px 8px;
  border: 1px solid var(--stroke-control);
  border-radius: 9px;
  background: var(--surface-toolbar);
  text-align: center;
}
.theme-card[aria-checked='true'] {
  border-color: var(--brand-stroke);
  box-shadow: inset 0 0 0 1px var(--brand-stroke);
}
.theme-card .caption { display: block; margin-top: 6px; font-size: 11px; }
.theme-card[aria-checked='true'] .caption { color: var(--brand-stroke); font-weight: 600; }

.preview {
  display: flex;
  flex-direction: column;
  height: 58px;
  border: 1px solid var(--stroke-divider);
  border-radius: 5px;
  overflow: hidden;
  background: #fff;
}
.preview .bar {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 10px;
  padding: 0 3px;
  background: #dfe3ea;
}
.preview .bar i { width: 3px; height: 3px; border-radius: 50%; background: #8b8f9c66; }
.preview .body { flex: 1; padding: 4px; display: grid; gap: 3px; align-content: start; }
.preview .body i { height: 3px; border-radius: 2px; background: #626879; opacity: 0.28; }
.preview .body i:nth-child(2) { width: 62%; }
.preview .body i:nth-child(3) { width: 44%; }
.preview.light { background: #fff; }
.preview.dark { background: #23252d; }
.preview.dark .bar { background: #3a3d48; }
.preview.dark .body i { background: #f2f2f6; opacity: 0.25; }
.preview.system { background: linear-gradient(90deg, #fff 50%, #23252d 50%); }
.preview.system .bar { background: linear-gradient(90deg, #dfe3ea 50%, #3a3d48 50%); }

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
  .choice[aria-checked='true'],
  .theme-card[aria-checked='true'] { outline: 1px solid Highlight; outline-offset: -1px; }
  .preview { forced-color-adjust: none; }
}
</style>
