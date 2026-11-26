<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  SESSION_STARTUP_MODES, THEME_MODES, discardModeLabels, prewarmModeSummaries, prewarmToggleHint,
  sessionStartupLabels, themeModeLabels
} from '../shared/settings'
import type { SessionStartupMode, SettingKey, SettingsSnapshot, ThemeMode } from '../shared/settings'
import type { FlashPluginState } from '../shared/settings'
import { DEFAULT_SEARCH_ENGINE, SEARCH_ENGINES, searchEngineLabels } from '../shared/search'
import type { SearchEngine } from '../shared/search'
import type { BrowserEngine } from '../shared/engine'
import { applyShellTheme } from './theme'

/**
 * 内部设置页（`bao://settings`，对齐 Edge/Chrome 的设置页）。
 *
 * 数据来源只有一条：preload 暴露的 `baoSettings`。页面不持有权威状态——
 * 每次写入都用主进程返回的快照覆盖本地值，因此「叠加层改了主题 → 页面立刻跟着变」
 * 是同一份 store 的自然结果，不需要额外同步逻辑。
 *
 * 首帧（2026-11-26）：主进程在返回 HTML 时注入了主题变量与 `SettingsSnapshot`
 * （见 `shared/internal-bootstrap.ts`），`settings.ts` 把它作为 `bootstrap` 传进来——
 * 所以第一次渲染就有真实值，后面的 `read()` 只是校正。
 */
const props = defineProps<{ bootstrap?: SettingsSnapshot }>()

const snapshot = ref<SettingsSnapshot | undefined>(props.bootstrap)
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
const searchEngine = computed(() => current.value?.searchEngine ?? DEFAULT_SEARCH_ENGINE)
const prewarm = computed(() => current.value?.overlayPrewarm ?? 'always')
const tabDiscard = computed(() => current.value?.tabDiscard ?? 'auto')
const sessionStartup = computed(() => current.value?.sessionStartup ?? 'newtab')
const themeModes = THEME_MODES
const startupModes = SESSION_STARTUP_MODES
const storage = computed(() => snapshot.value?.storage ?? 'ready')

/**
 * 左侧分区：**每一项都有真实内容**，点得动。
 *
 * 早期那版还列了「下载」且全是置灰摆设——本版本按安全策略拒绝所有下载
 * （见 `main/sessions.ts` 的 `denyDownloads`，下载能力在 M2 立项），
 * 列一个点进去也没内容的条目等于假 UI，所以直接不列；接入下载时再加回来。
 */
const sections = [
  { id: 'appearance', label: '外观与偏好' },
  { id: 'privacy', label: '隐私与清理' },
  { id: 'about', label: '关于' }
] as const
type SettingsSection = (typeof sections)[number]['id']
const section = ref<SettingsSection>('appearance')

/** 「关于」的版本三元组由主进程随快照下发（内部页拿不到 process.versions）。 */
const runtime = computed(() => snapshot.value?.runtime ?? { app: '—', electron: '—', chromium: '—' })

/**
 * 「隐私与清理 → 浏览数据」：分类清理已保存的会话。
 *
 * 清除后本次运行不再记录会话（主进程挂起写盘），所以提示文案要说清楚"下次启动恢复记录"，
 * 否则用户会以为按钮没生效（`session.startup = continue` 时尤其明显）。
 */
const sessionClearing = ref(false)
const dataNotice = ref('')

/** 「数据」分区第二档：站点引擎规则（只删规则，不重载已打开的标签）。 */
const rulesClearing = ref(false)
const rulesNotice = ref('')

async function clearEngineRules(): Promise<void> {
  if (rulesClearing.value) return
  rulesClearing.value = true
  rulesNotice.value = ''
  try {
    const cleared = await window.baoSettings.clearEngineRules()
    rulesNotice.value = cleared ? '已清除站点引擎规则' : '清除失败，规则未改动'
  } catch {
    rulesNotice.value = '清除失败，规则未改动'
  } finally {
    rulesClearing.value = false
  }
}

async function clearSession(): Promise<void> {
  if (sessionClearing.value) return
  sessionClearing.value = true
  dataNotice.value = ''
  try {
    const cleared = await window.baoSettings.clearSession()
    dataNotice.value = cleared
      ? '已清除已保存的会话与恢复提示；本次运行不再记录，下次启动恢复记录。'
      : '清除失败，会话数据未改动'
  } catch {
    dataNotice.value = '清除失败，会话数据未改动'
  } finally {
    sessionClearing.value = false
  }
}

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

async function write(patch: { key: SettingKey; value: string }): Promise<void> {
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

/** 启动行为：单选项直写（与默认引擎一致，写成功才更新本地快照）。 */
function chooseStartup(mode: SessionStartupMode): void {
  void write({ key: 'session.startup', value: mode })
}

/**
 * 预热是开/关能力（不是三选一）：用 switch 表达比分段控件更直接，也和下面「后台标签休眠」同构。
 * 中间档「自动」已于 2026-11-26 删除——常驻只要 5–9 MB，悬停预热换不来相应的收益。
 */
function togglePrewarm(): void {
  void write({ key: 'overlay.prewarm', value: prewarm.value === 'always' ? 'never' : 'always' })
}

/** 后台休眠本质是开/关能力，用 switch 比两个互斥选项更直接。 */
function toggleTabDiscard(): void {
  void write({ key: 'tab.discard', value: tabDiscard.value === 'auto' ? 'never' : 'auto' })
}

function chooseEngine(next: BrowserEngine): void {
  if (next === 'ppapi' && !flashReady.value) {
    focusFlashSection()
    return
  }
  void write({ key: 'engine.default', value: next })
}

/** 默认搜索引擎：与非 URL 输入的搜索回退是同一份目录（`shared/search.ts`）。 */
function chooseSearchEngine(next: SearchEngine): void {
  void write({ key: 'search.engine', value: next })
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

/**
 * 「关于」里的 Flash 只是摘要：把用户送到真正那张卡（导入 / 定位 / 自动发现说明都在那里）。
 * 切分区之后要等一帧——`:hidden` 的元素刚变为可见时还没有布局，`scrollIntoView` 会无效。
 */
function goFlashSection(): void {
  section.value = 'appearance'
  void nextTick(() => document.getElementById('flash-section')?.scrollIntoView({ block: 'center' }))
}

</script>

<template>
  <div class="settings-body">
    <nav class="settings-nav" aria-label="设置分类">
      <h1 class="nav-title">设置</h1>
      <!-- 左侧导航是真的分区切换（`:hidden` 只换内容，不重载文档）：每一项都有对应内容。 -->
      <button
        v-for="item in sections"
        :key="item.id"
        type="button"
        :aria-current="section === item.id ? 'page' : undefined"
        @click="section = item.id"
      >{{ item.label }}</button>
    </nav>

    <main class="settings-content">
      <p v-if="storage === 'unavailable'" class="warn" role="alert">
        设置存储不可用：本次修改不会保存，重启后回到默认值。
      </p>

      <section class="setting-section" :hidden="section !== 'appearance'" aria-labelledby="theme-title">
        <header class="section-heading">
          <h2 id="theme-title">主题</h2>
          <p class="section-caption">选择最适合当前环境的界面外观</p>
        </header>
        <div class="setting-card setting-card--row">
          <div class="preference-copy">
            <h3>整体外观</h3>
            <p>应用于标签页、页面、对话框和其他菜单</p>
          </div>
          <div class="segmented-control" role="radiogroup" aria-label="主题">
            <button
              v-for="mode in themeModes"
              :key="mode"
              type="button"
              class="segmented-option theme-stop"
              role="radio"
              :aria-checked="theme === mode"
              :aria-label="themeModeLabels[mode]"
              @click="chooseTheme(mode)"
            >
              <span class="theme-mode-icon" :data-mode="mode" aria-hidden="true"></span>
              <span class="segmented-option-label">{{ themeModeLabels[mode] }}</span>
            </button>
          </div>
        </div>
      </section>

      <section class="setting-section" :hidden="section !== 'appearance'" aria-labelledby="engine-title">
        <header class="section-heading">
          <h2 id="engine-title">默认引擎</h2>
          <p class="section-caption">决定 Flash 内容优先使用的运行方式</p>
        </header>
        <div class="setting-card">
          <div role="radiogroup" aria-label="默认引擎" class="choices">
            <button
              type="button"
              class="choice"
              role="radio"
              :aria-checked="engine === 'ppapi'"
              :aria-disabled="flashReady ? 'false' : 'true'"
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
              @click="chooseEngine('ruffle')"
            >
              <span class="radio" aria-hidden="true"></span>
              <span class="label">Ruffle</span>
            </button>
          </div>
        </div>
      </section>

      <section class="setting-section" :hidden="section !== 'appearance'" aria-labelledby="search-title">
        <header class="section-heading">
          <h2 id="search-title">搜索引擎</h2>
          <p class="section-caption">地址栏和新标签页里不像是网址的输入，用它来搜索</p>
        </header>
        <div class="setting-card">
          <div role="radiogroup" aria-label="搜索引擎" class="choices">
            <button
              v-for="item in SEARCH_ENGINES"
              :key="item"
              type="button"
              class="choice"
              role="radio"
              :aria-checked="searchEngine === item"
              @click="chooseSearchEngine(item)"
            >
              <span class="radio" aria-hidden="true"></span>
              <span class="label">{{ searchEngineLabels[item] }}</span>
            </button>
          </div>
          <p class="lead">输入带点号的网址（如 4399.com）仍然直接打开；其余文字按这里的选择搜索。</p>
        </div>
      </section>

      <section id="flash-section" class="setting-section" :hidden="section !== 'appearance'" aria-labelledby="flash-title">
        <header class="section-heading"><h2 id="flash-title">Flash 插件</h2></header>
        <div class="setting-card">
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
        </div>
      </section>

      <section class="setting-section" :hidden="section !== 'appearance'" aria-labelledby="startup-title">
        <header class="section-heading"><h2 id="startup-title">启动</h2></header>
        <div class="setting-card">
          <div role="radiogroup" aria-label="启动时" class="choices">
            <button
              v-for="mode in startupModes"
              :key="mode"
              type="button"
              class="choice"
              role="radio"
              :aria-checked="sessionStartup === mode"
              @click="chooseStartup(mode)"
            >
              <span class="radio" aria-hidden="true"></span>
              <span class="label">{{ sessionStartupLabels[mode] }}</span>
            </button>
          </div>
        </div>
      </section>

      <section class="setting-section" :hidden="section !== 'appearance'" aria-labelledby="perf-title">
        <header class="section-heading"><h2 id="perf-title">性能</h2></header>
        <div class="setting-card">
          <div class="toggle-row">
            <div class="preference-copy">
              <h3>飞窗预热</h3>
              <!-- 说明跟着开关走：静态一句「决定何时准备好」看不出现在到底会不会预热。 -->
              <p>{{ prewarmModeSummaries[prewarm] }}</p>
            </div>
            <button
              type="button"
              class="toggle"
              role="switch"
              :aria-checked="prewarm === 'always'"
              aria-label="飞窗预热"
              :title="prewarmToggleHint"
              @click="togglePrewarm"
            >
              <span class="toggle-knob" aria-hidden="true"></span>
            </button>
          </div>
          <div class="preference-divider" aria-hidden="true"></div>
          <div class="toggle-row">
            <div class="preference-copy">
              <h3>后台标签休眠</h3>
              <p>{{ discardModeLabels[tabDiscard] }}</p>
            </div>
            <button
              type="button"
              class="toggle"
              role="switch"
              :aria-checked="tabDiscard === 'auto'"
              aria-label="后台标签休眠"
              @click="toggleTabDiscard"
            >
              <span class="toggle-knob" aria-hidden="true"></span>
            </button>
          </div>
        </div>
      </section>

      <section class="setting-section" :hidden="section !== 'appearance'" aria-labelledby="language-title">
        <header class="section-heading"><h2 id="language-title">语言</h2></header>
        <div class="setting-card">
          <div class="value-row">
            <div class="preference-copy">
              <h3>界面语言</h3>
              <p>当前版本仅提供一种界面语言</p>
            </div>
            <span class="current-value">简体中文</span>
          </div>
        </div>
      </section>

      <section class="setting-section" :hidden="section !== 'privacy'" aria-labelledby="privacy-title">
        <header class="section-heading">
          <h2 id="privacy-title">浏览数据</h2>
          <p class="section-caption">清除保存在本机上的会话与站点规则</p>
        </header>
        <div class="setting-card">
          <div class="select-row">
            <span>已保存的会话</span>
            <button type="button" class="action" aria-label="清除已保存的会话" :disabled="sessionClearing" @click="clearSession">清除</button>
          </div>
          <p class="lead">删除上次退出时保存的标签记录与崩溃恢复提示。清除后本次运行不再记录会话，下次启动恢复记录。</p>
          <p v-if="dataNotice" role="status">{{ dataNotice }}</p>
          <div class="select-row">
            <span>站点引擎规则</span>
            <button type="button" class="action" aria-label="清除站点引擎规则" :disabled="rulesClearing" @click="clearEngineRules">清除</button>
          </div>
          <p class="lead">删除各站点「记住的引擎」规则；已打开的标签不会重新加载，来源回到默认。</p>
          <p v-if="rulesNotice" role="status">{{ rulesNotice }}</p>
        </div>
      </section>

      <section class="setting-section" :hidden="section !== 'about'" aria-labelledby="about-title">
        <header class="section-heading">
          <h2 id="about-title">版本信息</h2>
          <p class="section-caption">运行时版本与本机 Flash 插件状态</p>
        </header>
        <div class="setting-card">
          <div class="value-row">
            <div class="preference-copy">
              <h3>BaoFlashBrowser Next</h3>
              <p>自带 Flash（PPAPI）运行时的浏览器外壳</p>
            </div>
            <span class="current-value">v{{ runtime.app }}</span>
          </div>
          <div class="preference-divider" aria-hidden="true"></div>
          <div class="value-row">
            <div class="preference-copy">
              <h3>内核</h3>
              <p>Electron {{ runtime.electron }} · Chromium {{ runtime.chromium }}</p>
            </div>
          </div>
          <div class="preference-divider" aria-hidden="true"></div>
          <div class="value-row">
            <div class="preference-copy">
              <h3>Flash 插件</h3>
              <p :title="flash?.path">{{ flashStatusText }}</p>
            </div>
            <!-- 关于里只放状态摘要：导入/定位这些动作都在「外观与偏好 → Flash 插件」那张卡里，
                 两处各放一套按钮会让人以为功能分叉了（2026-11-26 反馈）。 -->
            <button type="button" class="action" aria-label="去 Flash 插件设置" @click="goFlashSection">Flash 插件设置</button>
          </div>
        </div>
      </section>

      <p v-if="error" class="error" role="status">{{ error }}</p>
    </main>
  </div>
</template>

<style>
:root {
  color-scheme: light;
  font: var(--size-body, 14px)/1.5 var(--shell-font);
  color: var(--text-primary);
  background: var(--surface-page);
}

:root[data-theme='dark'] { color-scheme: dark; }

* { box-sizing: border-box; }
html, body { height: 100%; overflow: hidden; }
/* 页面底色就是主题的 surface-page：去掉早期那圈紫色光晕——设置页要和外壳的中性面
   同一个体系，强调色只留给控件（radio/开关/链接/焦点环）。 */
body {
  margin: 0;
  background: var(--surface-page);
}
h1, h2, h3, p { margin: 0; }
button { font: inherit; color: inherit; }
button { border: 0; background: none; cursor: pointer; }
button:disabled { cursor: default; opacity: 0.6; }
/* 只有键盘操作才画焦点环：鼠标点选不该出现蓝框。
   环 = Chrome 同款（2px、外侧、跟随控件圆角），颜色取我们的 accent 62%。 */
:focus:not(:focus-visible) { outline: none; }
:focus-visible {
  outline: 2px solid var(--stroke-focus-ring);
  outline-offset: 1px;
}

.settings-content > .warn {
  padding: 6px 9px;
  border-radius: 7px;
  font-size: 12px;
  color: var(--text-error, #a82929);
  background: color-mix(in srgb, var(--text-error, #a82929) 10%, transparent);
}

.settings-body {
  display: grid;
  grid-template-columns: minmax(300px, 1fr) minmax(0, 860px) minmax(0, 1fr);
  align-items: start;
  height: 100vh;
  overflow-y: auto;
  scrollbar-gutter: stable;
}
.settings-nav {
  grid-column: 1;
  justify-self: start;
  position: sticky;
  top: 0;
  width: 300px;
  height: 100vh;
  padding: 30px 14px;
  overflow: auto;
  overscroll-behavior: contain;
}
.settings-nav .nav-title {
  margin: 0 12px 28px;
  font-size: 24px;
  font-weight: 650;
  line-height: 1.25;
  letter-spacing: -.02em;
}
.settings-nav button {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-height: 40px;
  padding: 0 13px;
  border-radius: 999px;
  font-size: 13px;
  text-align: left;
  transition: background var(--motion-fast), color var(--motion-fast);
}
.settings-nav button[aria-current='page'] {
  color: var(--engine-accent);
  background: color-mix(in srgb, var(--engine-accent) 11%, var(--surface-toolbar));
  color: var(--text-primary);
  font-weight: 600;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--engine-accent) 8%, transparent);
}
.settings-nav button[aria-current='page'] .shell-icon { color: var(--engine-accent); }
.settings-nav button:disabled { color: var(--text-secondary); opacity: 0.55; }
/* 分区切换只换内容，导航项保持同一个滚动容器：不跳滚动位置、不重排。 */
.settings-nav button[aria-current='page']:hover { background: color-mix(in srgb, var(--engine-accent) 14%, var(--surface-toolbar)); }

/* Chromium Settings 的核心是稳定的单列扫描路径；宽屏只增加两侧留白，不重排设置顺序。 */
.settings-content {
  grid-column: 2;
  display: flex;
  flex-direction: column;
  gap: 22px;
  width: 100%;
  padding: 32px 12px 48px;
}
.setting-section {
  flex: none;
  min-width: 0;
}
.section-heading {
  padding: 0 12px 10px;
}
.setting-card {
  padding: 18px 22px;
  border: 1px solid color-mix(in srgb, var(--stroke-control) 70%, transparent);
  border-radius: 14px;
  background: color-mix(in srgb, var(--surface-toolbar) 96%, transparent);
  box-shadow: 0 1px 2px rgb(0 0 0 / 5%), 0 3px 10px rgb(0 0 0 / 2%);
  overflow: hidden;
}
.settings-content h2 { font-size: 16px; line-height: 1.3; font-weight: 650; }
.settings-content .section-caption {
  margin-top: 3px;
  color: var(--text-secondary);
  font-size: 12px;
}
.settings-content .lead { font-size: 12px; color: var(--text-secondary); margin-bottom: 10px; }
.settings-content code {
  padding: 0 3px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--text-secondary) 12%, transparent);
  font-size: 11px;
}

.setting-card--row,
.preference-block {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 32px;
}

.segmented-control {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  flex: none;
  width: min(54%, 330px);
  padding: 4px;
  border: 1px solid var(--stroke-control);
  border-radius: 14px;
  background: color-mix(in srgb, var(--surface-page) 72%, var(--surface-toolbar));
  box-shadow: 0 1px 3px rgb(0 0 0 / 8%);
}
.segmented-option {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-width: 0;
  min-height: 38px;
  padding: 6px 10px;
  border-radius: 10px;
  color: var(--text-primary);
  font-size: 13px;
  white-space: nowrap;
  transition: background var(--motion-fast), box-shadow var(--motion-fast), color var(--motion-fast);
}
/* 文本容器自己兜住溢出：三等分网格里任何一档变长都只在这格内省略，绝不画到圆角外面去。 */
.segmented-option-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.segmented-option:hover:not(:disabled):not([aria-checked='true']) { background: var(--surface-hover); }
.segmented-option[aria-checked='true'] {
  background: var(--surface-toolbar);
  font-weight: 600;
  box-shadow: 0 1px 3px rgb(0 0 0 / 12%);
}
.segmented-option:disabled { opacity: .6; cursor: default; }

.theme-mode-icon {
  position: relative;
  display: block;
  flex: none;
  width: 16px;
  height: 16px;
}
.theme-mode-icon[data-mode='system']::before {
  content: '';
  position: absolute;
  inset: 2px 1px 4px;
  border: 1.5px solid currentColor;
  border-radius: 2px;
}
.theme-mode-icon[data-mode='system']::after {
  content: '';
  position: absolute;
  right: 4px;
  bottom: 1px;
  left: 4px;
  height: 1.5px;
  border-radius: 1px;
  background: currentColor;
}
.theme-mode-icon[data-mode='light']::before {
  content: '☼';
  position: absolute;
  inset: 0;
  font-size: 18px;
  font-weight: 400;
  line-height: 15px;
  text-align: center;
}
.theme-mode-icon[data-mode='dark']::before {
  content: '☾';
  position: absolute;
  inset: -1px 0 0;
  font-size: 19px;
  font-weight: 500;
  line-height: 16px;
  text-align: center;
}

.choices { display: grid; gap: 2px; }
.choice {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 44px;
  padding: 7px 11px;
  border: 1px solid transparent;
  border-radius: 8px;
  font-size: 13px;
  text-align: left;
}
.choice:hover:not([aria-disabled='true']) { background: var(--surface-hover); }
.choice[aria-disabled='true'] { opacity: .55; cursor: default; }
.choice[aria-checked='true'] {
  /* 选中行用中性选中面 + 紫色圆点：整行铺品牌色在深色下就是一块紫斑，不像这个主题。 */
  background: var(--surface-selected);
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

.preference-block { padding: 4px 10px 6px; }
.preference-copy { min-width: 0; }
.preference-copy h3 {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
}
.preference-copy p {
  margin-top: 2px;
  color: var(--text-secondary);
  font-size: 12px;
}
.preference-divider {
  height: 1px;
  margin: 12px 10px;
  background: var(--stroke-divider);
}
.toggle-row,
.value-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  min-height: 58px;
  padding: 4px 10px;
}
.toggle {
  position: relative;
  flex: none;
  width: 40px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--stroke-control);
  border-radius: 999px;
  background: var(--text-secondary);
  transition: background var(--motion-fast), border-color var(--motion-fast);
}
.toggle[aria-checked='true'] {
  border-color: var(--engine-accent);
  background: var(--engine-accent);
}
.toggle-knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--surface-toolbar);
  box-shadow: 0 1px 2px rgb(0 0 0 / 28%);
  transition: translate var(--motion-fast);
}
.toggle[aria-checked='true'] .toggle-knob { translate: 18px 0; }
.current-value {
  flex: none;
  padding: 5px 11px;
  border-radius: 999px;
  color: var(--text-secondary);
  background: var(--surface-hover);
  font-size: 12px;
}

.select-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  min-height: 44px;
  padding: 7px 10px;
  border-radius: 8px;
  font-size: 13px;
}
.select-row:hover { background: var(--surface-hover); }

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
  flex: none; min-height: 32px; padding: 4px 12px; border: 1px solid var(--stroke-control); border-radius: 9px;
  background: var(--surface-toolbar); font-size: 12px; cursor: pointer;
  box-shadow: 0 1px 1px rgb(0 0 0 / 3%);
  transition: background var(--motion-fast), border-color var(--motion-fast), transform var(--motion-fast);
}
.action:hover:not(:disabled) { background: var(--surface-hover); border-color: var(--brand-stroke); transform: translateY(-1px); }
.action:disabled { opacity: .6; cursor: default; }

@media (max-width: 1100px) {
  .settings-body { grid-template-columns: 260px minmax(0, 1fr); }
  .settings-nav { width: 260px; }
  .settings-content {
    grid-column: 2;
    width: 100%;
    padding: 32px 28px 48px 40px;
  }
}

@media (max-width: 720px) {
  .settings-body { grid-template-columns: 1fr; }
  .settings-nav { display: none; }
  .settings-content { grid-column: 1; width: auto; margin: 0; padding: 18px 16px 28px; gap: 12px; }
  .setting-card { padding: 18px 16px; border-radius: 14px; }
  .setting-card--row,
  .preference-block { align-items: stretch; flex-direction: column; gap: 16px; }
  .segmented-control { width: 100%; }
  .flash-row { flex-wrap: wrap; }
  .flash-path { order: 4; flex-basis: 100%; }
}

@media (forced-colors: active) {
  .choice[aria-checked='true'] { outline: 1px solid Highlight; outline-offset: -1px; }
}
</style>
