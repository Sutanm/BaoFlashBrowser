<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { PREWARM_MODES, prewarmModeLabels } from '../shared/settings'
import type { SettingsSnapshot, ThemeMode } from '../shared/settings'
import type { FlashPluginState } from '../shared/settings'
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
const prewarm = computed(() => current.value?.overlayPrewarm ?? 'auto')
const prewarmModes = PREWARM_MODES
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
  await loadFlash()
})

onBeforeUnmount(() => detach?.())

async function write(patch: { key: 'theme.mode' | 'engine.default' | 'locale' | 'overlay.prewarm'; value: string }): Promise<void> {
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
  if (next === 'ppapi' && !flashReady.value) {
    focusFlashSection()
    return
  }
  void write({ key: 'engine.default', value: next })
}

const flashReady = computed(() => snapshot.value?.flash !== false)

/** Flash 插件（BYOP）：状态 + 定位入口 + 导入入口。 */
const flash = ref<FlashPluginState>()
const flashBusy = ref(false)
const flashError = ref('')

/** 「就绪」指本进程启动时已经注册；`restartRequired` 表示磁盘上的选择变了。 */
const flashStatusText = computed(() => {
  const state = flash.value
  if (!state) return '读取中…'
  if (state.ready) return `已就绪${state.version ? ` · v${state.version}` : ''}`
  if (state.found) return state.version ? `已发现 v${state.version}，重启后生效` : '已找到插件，重启后生效'
  if (state.restartRequired) return '插件已移除，重启后停用'
  return '未找到'
})

/** 只有磁盘上真有插件时才提供「打开所在文件夹」；否则 `path` 只是建议的投放位置。 */
const flashMissing = computed(() => flash.value?.found === false)

async function loadFlash(): Promise<void> {
  flash.value = await window.baoSettings.flashStatus()
}

/** 打开插件所在文件夹（路径由主进程解析，页面只发一个"定位"意图）。 */
async function revealFlash(): Promise<void> {
  if (!flash.value?.found) return
  await window.baoSettings.flashReveal()
}

async function importFlash(): Promise<void> {
  if (flashBusy.value) return
  flashBusy.value = true
  flashError.value = ''
  try {
    const result = await window.baoSettings.flashImport()
    if (result.ok) flash.value = result.status
    else if (result.code !== 'cancelled') {
      flashError.value = result.code === 'invalid' ? '不是可用的插件文件'
        : result.code === 'not-64-bit' ? '这个插件不是 64 位的，本应用只能加载 64 位 PPAPI 插件'
        : result.code === 'not-pepper' ? '这个文件不是 PPAPI 插件（缺少 PPP_GetInterface 导出）'
        : '复制失败，请检查文件权限'
    }
  } finally {
    flashBusy.value = false
  }
}

/** 插件缺失时点「原生 Flash」直接跳到这一节，而不是弹一句失败提示。 */
function focusFlashSection(): void {
  document.getElementById('flash-section')?.scrollIntoView({ block: 'nearest' })
}

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
            :aria-disabled="busy || !flashReady ? 'true' : 'false'"
            :title="flashReady ? undefined : '未检测到 Flash 插件，当前自动使用 Ruffle'"
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

      <section id="flash-section" aria-labelledby="flash-title">
        <h2 id="flash-title">Flash 插件</h2>
        <div class="select-row flash-row">
          <span class="flash-state" :class="{ ready: flash?.ready }">{{ flashStatusText }}</span>
          <span class="flash-path" :title="flash?.path">{{ flash?.path }}</span>
          <button type="button" class="action" :disabled="!flash?.found" @click="revealFlash">打开所在文件夹</button>
          <button type="button" class="action" :disabled="flashBusy" @click="importFlash">导入</button>
        </div>
        <p v-if="flashMissing" class="lead">
          已自动查找系统安装的 Flash、Chrome/Chromium 的 PepperFlash、常见双核浏览器与下载目录。
          需要指定版本时用「导入」，导入的插件优先于自动发现。
        </p>
        <p v-if="flashError" class="error" role="status">{{ flashError }}</p>
      </section>

      <section aria-labelledby="perf-title">
        <h2 id="perf-title">性能</h2>
        <label class="select-row">
          <span>飞窗预热</span>
          <select :value="prewarm" :disabled="busy" @change="write({ key: 'overlay.prewarm', value: ($event.target as HTMLSelectElement).value })">
            <option v-for="mode in prewarmModes" :key="mode" :value="mode">{{ prewarmModeLabels[mode] }}</option>
          </select>
        </label>
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
/* 只有键盘操作才画焦点环：鼠标点选不该出现蓝框。
   环 = Chrome 同款（2px、外侧、跟随控件圆角），颜色取我们的 accent 62%。
   <select> 在 Chromium 里鼠标点击也匹配 :focus-visible（CSSWG #5822），
   这里不额外压掉它——与 Chrome 行为一致。 */
:focus:not(:focus-visible) { outline: none; }
:focus-visible {
  outline: 2px solid var(--stroke-focus-ring);
  outline-offset: 1px;
}

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
  grid-template-columns: 240px minmax(0, 1fr);
  height: calc(100vh - 62px);
  min-height: 0;
}
.settings-nav {
  padding: 12px 10px;
  border-right: 1px solid var(--stroke-divider);
  background: transparent;
  overflow: auto;
}
.settings-nav button {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 34px;
  padding: 0 12px;
  border-radius: 6px;
  font-size: 13px;
  text-align: left;
}
.settings-nav button[aria-current='page'] {
  background: var(--surface-hover);
  color: var(--text-primary);
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

/* 卡片式内容区（对齐 Edge 设置页：居中列 + 每节一张卡片） */
.settings-content {
  width: 100%;
  max-width: 1000px;
  margin: 0 auto;
  padding: 20px 28px 32px;
  overflow: auto;
}
.settings-content section {
  margin-bottom: 12px;
  padding: 16px 20px 18px;
  border: 1px solid var(--stroke-divider);
  border-radius: 12px;
  background: var(--surface-toolbar);
}
.settings-content section:last-of-type { margin-bottom: 0; }
.settings-content h2 { font-size: 15px; font-weight: 600; margin-bottom: 12px; }
.settings-content .lead { font-size: 12px; color: var(--text-secondary); margin-bottom: 10px; }
.settings-content code {
  padding: 0 3px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--text-secondary) 12%, transparent);
  font-size: 11px;
}

.settings-theme { padding: 12px 0 3px; }

.choices { display: grid; gap: 2px; }
.choice {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 40px;
  padding: 6px 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  font-size: 13px;
  text-align: left;
}
.choice:hover:not([aria-disabled='true']) { background: var(--surface-hover); }
.choice[aria-disabled='true'] { opacity: .55; cursor: default; }
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
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  min-height: 40px;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 13px;
}
.select-row:hover { background: var(--surface-hover); }
.select-row select {
  flex: none;
  width: 220px;
  padding: 3px 6px;
  border: 1px solid var(--stroke-control);
  border-radius: 6px;
  background: var(--surface-toolbar);
}
.select-row select:focus { border-color: var(--brand-stroke); }

.error { margin-top: 14px; font-size: 12px; color: var(--text-error, #a82929); }

/* Flash 插件：一行状态 + 路径 + 导入按钮，不写说明文字 */
.flash-row { gap: 10px; }
.flash-state { flex: none; font-size: 12px; color: var(--text-secondary); }
.flash-state.ready { color: var(--engine-accent); font-weight: 600; }
.flash-path {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 11px; color: var(--text-secondary); direction: rtl; text-align: left;
}
.action {
  flex: none; padding: 3px 10px; border: 1px solid var(--stroke-control); border-radius: 7px;
  background: var(--surface-toolbar); font-size: 12px; cursor: pointer;
}
.action:hover:not(:disabled) { background: var(--surface-hover); }
.action:disabled { opacity: .6; cursor: default; }

@media (forced-colors: active) {
  .choice[aria-checked='true'] { outline: 1px solid Highlight; outline-offset: -1px; }
}
</style>
