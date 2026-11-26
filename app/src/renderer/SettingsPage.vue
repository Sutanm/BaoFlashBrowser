<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  SESSION_STARTUP_MODES, THEME_MODES, bookmarkBarHint, bookmarkBarModeLabels, discardModeLabels,
  prewarmModeSummaries, prewarmToggleHint, sessionStartupLabels, themeModeLabels
} from '../shared/settings'
import type { SessionStartupMode, SettingKey, SettingsSnapshot, ThemeMode } from '../shared/settings'
import { BOOKMARK_BAR_MODES } from '../shared/bookmarks'
import type { BookmarkBarMode } from '../shared/bookmarks'
import type { FlashPluginState } from '../shared/settings'
import { DEFAULT_SEARCH_ENGINE, SEARCH_ENGINES, searchEngineLabels } from '../shared/search'
import type { SearchEngine } from '../shared/search'
import type { BrowserEngine } from '../shared/engine'
import { engineLabels } from '../shared/engine'
import ShellIcon from './ShellIcon.vue'
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
const bookmarkBar = computed(() => current.value?.bookmarkBar ?? 'ntp')
const themeModes = THEME_MODES
const startupModes = SESSION_STARTUP_MODES
const bookmarkBarModes = BOOKMARK_BAR_MODES
const storage = computed(() => snapshot.value?.storage ?? 'ready')

/**
 * 左侧分区：照 Edge 的切法与顺序（2026-11-26），但**只列我们真有东西的项**。
 *
 * 映射关系（Edge → 我们）：
 *   外观 → 外观（主题）；隐私、搜索和服务 → 搜索（默认搜索引擎）+ 浏览数据；
 *   启动 → 启动；系统和性能 → 性能；语言 → 语言；关于 → 关于。
 * 不列：个人资料 / 密码和自动填充 / 默认浏览器 / 下载 / 辅助功能 / 重置设置 / 扩展
 * ——这些我们没有任何数据源或能力（下载按安全策略整体拒绝，见 `main/sessions.ts`
 * 的 `denyDownloads`），列出来就是假 UI。
 *
 * `group` 只控制左栏的视觉分组（Edge 用空行分开三组），不影响内容。
 */
const sections = [
  { id: 'appearance', label: '外观', icon: 'palette', group: 1 },
  { id: 'engine', label: '引擎', icon: 'flash', group: 1 },
  { id: 'privacy', label: '隐私、搜索和服务', icon: 'shield', group: 2 },
  { id: 'startup', label: '启动', icon: 'home', group: 2 },
  { id: 'performance', label: '性能', icon: 'gauge', group: 2 },
  { id: 'language', label: '语言', icon: 'translate', group: 3 },
  { id: 'about', label: '关于', icon: 'info', group: 3 }
] as const
type SettingsSection = (typeof sections)[number]['id']
const section = ref<SettingsSection>('appearance')

/** 按 `group` 切成视觉组（空行由模板里的 `.nav-gap` 画）。 */
const navGroups = sections.reduce<Array<Array<(typeof sections)[number]>>>((groups, item) => {
  const last = groups[groups.length - 1]
  if (last && last[0].group === item.group) last.push(item)
  else groups.push([item])
  return groups
}, [])

/**
 * 切换分区：内容区是**同一个滚动容器**，切到更短的分区时停在旧位置会看到一片空白，
 * 所以每次切换都把内容滚回顶部（与 Chrome/Edge 一致）。
 */
function selectSection(next: SettingsSection): void {
  if (section.value === next) return
  section.value = next
  document.querySelector('.settings-body')?.scrollTo({ top: 0 })
}

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

/** 「引擎」分区第三档：站点引擎规则（列表 + 单条忘记 + 全部清除，都不重载已打开的标签）。 */
const rulesClearing = ref(false)
const rulesNotice = ref('')
/** 正在删除的站点（逐行显示忙碌态，避免重复点击）。Set 在 Vue 3 里是响应式的。 */
const forgetting = ref(new Set<string>())

/** 快照里按 host 排好序的规则投影。 */
const engineRules = computed(() => snapshot.value?.engineRules ?? [])

/** 超过这个条数才显示过滤框：少量规则时多一个输入框只是噪音。 */
const RULE_FILTER_THRESHOLD = 8
const ruleQuery = ref('')

/** 过滤（纯前端）：按 host 子串匹配，大小写不敏感。 */
const filteredRules = computed(() => {
  const query = ruleQuery.value.trim().toLowerCase()
  if (!query) return engineRules.value
  return engineRules.value.filter((rule) => rule.host.toLowerCase().includes(query))
})

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

/**
 * 忘记单个站点：只删这一条，已打开的标签不重载（与「全部清除」同一语义）。
 *
 * 成功后不手动改本地快照——主进程会 `refreshAllWindows()` 推一份新快照过来，
 * 列表跟着那次广播消失（页面不持有权威状态，这是全站一致的写法）。
 */
async function forgetRule(host: string): Promise<void> {
  if (forgetting.value.has(host)) return
  forgetting.value.add(host)
  rulesNotice.value = ''
  try {
    const forgotten = await window.baoSettings.forgetEngineRule(host)
    rulesNotice.value = forgotten ? `已忘记 ${host}` : `忘记 ${host} 失败，规则未改动`
  } catch {
    rulesNotice.value = `忘记 ${host} 失败，规则未改动`
  } finally {
    forgetting.value.delete(host)
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
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  window.addEventListener('scroll', onDocumentScrollOrResize, true)
  window.addEventListener('resize', onDocumentScrollOrResize)
  await loadFlash()
  // 首帧分区是隐藏的（`:hidden`），量出来是 0：切到「隐私、搜索和服务」时再量一次。
  void nextTick(measureTrigger)
  // 字体就绪后再量一次：Web 字体换掉系统字体时字宽会变，早量出来会偏窄（标签被截成"Go…"）。
  void document.fonts?.ready.then(() => measureTrigger())
})

/** 分区切换后重量一次：隐藏的分区量不出宽度（`getBoundingClientRect()` 全是 0）。 */
watch(section, (next) => {
  if (next === 'privacy') void nextTick(measureTrigger)
})

onBeforeUnmount(() => {
  detach?.()
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  window.removeEventListener('scroll', onDocumentScrollOrResize, true)
  window.removeEventListener('resize', onDocumentScrollOrResize)
})

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

/** 收藏夹横条的三档（Edge 的「显示收藏夹栏」）：直写，写成功才更新本地快照。 */
function chooseBookmarkBar(mode: BookmarkBarMode): void {
  void write({ key: 'bookmark.bar', value: mode })
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

/**
 * 默认搜索引擎：与非 URL 输入的搜索回退是同一份目录（`shared/search.ts`）。
 *
 * 形态是**下拉框**（2026-11-26 反馈）：竖排单选把六项铺成六行，占掉半屏却没有信息量；
 * 下拉里**当前选中的排第一行**——打开就能看见"我现在选的是谁"，不用先扫一遍找勾。
 */
const searchEngineOptions = computed<SearchEngine[]>(() => [
  searchEngine.value,
  ...SEARCH_ENGINES.filter((item) => item !== searchEngine.value)
])
const engineMenuOpen = ref(false)
/** 键盘高亮项（鼠标悬停也会同步它）：不用鼠标也能选。 */
const engineMenuActive = ref(0)
const engineSelect = ref<HTMLElement>()
const engineTrigger = ref<HTMLButtonElement>()
const engineMenu = ref<HTMLElement>()
/**
 * 菜单用 `position: fixed` 挂在 `body` 上（Teleport）。
 *
 * 为什么不能就地绝对定位：`.setting-card` 有 `overflow: hidden`（圆角要裁），就地定位会被
 * 卡片裁掉——只露出第一项（2026-11-26 截图里就是这样）。改成 Teleport + fixed，菜单永远完整。
 */
const engineMenuStyle = ref<Record<string, string>>({})

/**
 * 按钮宽度**贴着最宽的引擎名**（2026-11-26 反馈："空白太多太空旷"）。
 *
 * 为什么用 JS 量：撑宽层若参与布局会顶高按钮，用 `position: absolute` 又不参与宽度计算——
 * 两边都不成立。所以用一个绝对定位的隐形副本量出文字宽度，写到 `min-width` 上，菜单取同一个值。
 *
 * 量不到（分区隐藏时 `getBoundingClientRect()` 全是 0）就**不加下限**：宁可让按钮先按内容
 * 显示，也不留一块空白——切到该分区、字体就绪、点开下拉时都会重量一次。
 */
const engineTriggerWidth = ref(0)

function measureTrigger(): void {
  const spans = engineSelect.value?.querySelectorAll<HTMLElement>('.engine-trigger-sizer > span')
  if (!spans || spans.length === 0) return
  const widest = Math.max(0, ...[...spans].map((el) => el.getBoundingClientRect().width))
  if (widest <= 0) return
  // 20 = 左右内距(10×2)、8 = 与箭头的间距、12 = 箭头、2 = 边框。
  engineTriggerWidth.value = Math.ceil(widest + 20 + 8 + 12 + 2)
}

function placeEngineMenu(): void {
  const rect = engineTrigger.value?.getBoundingClientRect()
  if (!rect) return
  // 先重量：分区刚切过来时 `min-width` 还没生效，用按钮的旧矩形算会偏窄（2026-11-26 实测）。
  measureTrigger()
  engineMenuStyle.value = {
    top: `${Math.round(rect.bottom + 4)}px`,
    // 右缘与触发按钮对齐（设置页在窗口右侧，右对齐不会顶出屏幕）。
    right: `${Math.max(8, Math.round(window.innerWidth - rect.right))}px`,
    // 宽度**与触发按钮一致**（2026-11-26 反馈）：菜单比按钮宽会显得两块东西不是一套。
    width: `${engineTriggerWidth.value || Math.round(rect.width)}px`
  }
}

function openEngineMenu(active = 0): void {
  placeEngineMenu()
  engineMenuOpen.value = true
  engineMenuActive.value = active < 0 ? searchEngineOptions.value.length - 1 : Math.min(active, searchEngineOptions.value.length - 1)
  void nextTick(() => {
    engineMenu.value?.querySelector<HTMLElement>('.engine-option.active')?.focus()
  })
}

/** 关掉下拉并把焦点还给触发按钮（键盘用户不该被丢在 document.body 上）。 */
function closeEngineMenu(restoreFocus = false): void {
  if (!engineMenuOpen.value) return
  engineMenuOpen.value = false
  if (restoreFocus) engineTrigger.value?.focus()
}

function toggleEngineMenu(): void {
  if (engineMenuOpen.value) closeEngineMenu(true)
  else openEngineMenu(0)
}

function chooseSearchEngine(next: SearchEngine): void {
  closeEngineMenu()
  void write({ key: 'search.engine', value: next })
}

function onEngineMenuKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeEngineMenu(true)
    return
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    engineMenuActive.value = (engineMenuActive.value + 1) % searchEngineOptions.value.length
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    engineMenuActive.value = (engineMenuActive.value - 1 + searchEngineOptions.value.length) % searchEngineOptions.value.length
    return
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    const next = searchEngineOptions.value[engineMenuActive.value]
    if (next) chooseSearchEngine(next)
  }
}

/**
 * 点外面收起（与飞窗同一手法：捕获阶段听 pointerdown，不受 stopPropagation 影响）。
 *
 * 菜单被 Teleport 到 `body` 之后**不再是**触发按钮的后代，所以两处都要判：
 * 否则点选项会先被判成"点外面"，菜单一关，click 就落空了。
 */
function onDocumentPointerDown(event: PointerEvent): void {
  if (!engineMenuOpen.value) return
  if (!(event.target instanceof Node)) return
  if (engineSelect.value?.contains(event.target) || engineMenu.value?.contains(event.target)) return
  closeEngineMenu()
}

/** 滚动/缩放时菜单会脱离触发按钮：直接收起（比重算位置简单且不会错位）。 */
function onDocumentScrollOrResize(): void {
  if (engineMenuOpen.value) closeEngineMenu()
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
 * 「关于」里的 Flash 只是摘要：把用户送到真正那张卡（导入 / 定位 / 自动发现说明都在那里，
 * 在「引擎」分区）。切分区之后要等一帧——`:hidden` 的元素刚变为可见时还没有布局，
 * `scrollIntoView` 会无效。
 */
function goFlashSection(): void {
  section.value = 'engine'
  void nextTick(() => document.getElementById('flash-section')?.scrollIntoView({ block: 'center' }))
}

</script>

<template>
  <div class="settings-body">
    <nav class="settings-nav" aria-label="设置分类">
      <h1 class="nav-title">设置</h1>
      <!-- 左侧导航是真的分区切换（`:hidden` 只换内容，不重载文档）：每一项都有对应内容。 -->
      <template v-for="(group, index) in navGroups" :key="index">
        <div v-if="index > 0" class="nav-gap" aria-hidden="true"></div>
        <button
          v-for="item in group"
          :key="item.id"
          type="button"
          :aria-current="section === item.id ? 'page' : undefined"
          @click="selectSection(item.id)"
        >
          <ShellIcon :name="item.icon" />
          <span>{{ item.label }}</span>
        </button>
      </template>
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

      <section class="setting-section" :hidden="section !== 'appearance'" aria-labelledby="bookmark-bar-title">
        <header class="section-heading">
          <h2 id="bookmark-bar-title">收藏夹栏</h2>
          <p class="section-caption">{{ bookmarkBarHint }}</p>
        </header>
        <!-- 三档用竖排单选（与「默认引擎」同一形态）：标签比主题那三档长得多，
             横排分段控件会把它压成"仅在新标签页…"。 -->
        <div class="setting-card">
          <div role="radiogroup" aria-label="显示收藏夹栏" class="choices">
            <button
              v-for="mode in bookmarkBarModes"
              :key="mode"
              type="button"
              class="choice"
              role="radio"
              :aria-checked="bookmarkBar === mode"
              @click="chooseBookmarkBar(mode)"
            >
              <span class="radio" aria-hidden="true"></span>
              <span class="label">{{ bookmarkBarModeLabels[mode] }}</span>
            </button>
          </div>
        </div>
      </section>

      <section class="setting-section" :hidden="section !== 'engine'" aria-labelledby="engine-title">
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

      <section class="setting-section" :hidden="section !== 'privacy'" aria-labelledby="search-title">
        <header class="section-heading">
          <h2 id="search-title">搜索引擎</h2>
          <p class="section-caption">地址栏和新标签页里不像是网址的输入，用它来搜索</p>
        </header>
        <div class="setting-card">
          <div class="select-row">
            <div class="preference-copy">
              <h3>地址栏中使用的搜索引擎</h3>
              <p>不像是网址的输入，用它来搜索</p>
            </div>
            <!-- 下拉框：当前选中的排第一行（打开就见"现在选的是谁"），点外面 / Esc 收起。 -->
            <div ref="engineSelect" class="engine-select">
              <button
                ref="engineTrigger"
                type="button"
                class="engine-trigger"
                role="combobox"
                aria-haspopup="listbox"
                aria-controls="search-engine-menu"
                :aria-expanded="engineMenuOpen"
                :aria-label="`搜索引擎：${searchEngineLabels[searchEngine]}`"
                :style="engineTriggerWidth ? { minWidth: `${engineTriggerWidth}px` } : undefined"
                @click="toggleEngineMenu"
                @keydown.down.prevent="openEngineMenu(0)"
                @keydown.up.prevent="openEngineMenu(-1)"
                @keydown.esc.prevent="closeEngineMenu(true)"
              >
                <span class="engine-trigger-label">{{ searchEngineLabels[searchEngine] }}</span>
                <!--
                  撑宽用的隐形副本（Edge 的做法）：取**最宽的那个引擎名**，这样切换选项时
                  按钮宽度不会跳，下拉也就不必比按钮宽出一截（2026-11-26 反馈）。
                -->
                <span class="engine-trigger-sizer" aria-hidden="true">
                  <span v-for="item in SEARCH_ENGINES" :key="item">{{ searchEngineLabels[item] }}</span>
                </span>
                <ShellIcon name="chevron" class="engine-chevron" />
              </button>
              <!-- 菜单 Teleport 到 body：`.setting-card` 的 `overflow: hidden` 会把它裁掉。 -->
              <Teleport to="body">
                <ul
                  v-if="engineMenuOpen"
                  id="search-engine-menu"
                  ref="engineMenu"
                  class="engine-menu"
                  role="listbox"
                  aria-label="搜索引擎"
                  :style="engineMenuStyle"
                  @keydown="onEngineMenuKeydown"
                >
                  <li v-for="(item, index) in searchEngineOptions" :key="item" role="presentation">
                    <button
                      type="button"
                      class="engine-option"
                      :class="{ active: index === engineMenuActive }"
                      role="option"
                      :aria-selected="searchEngine === item"
                      @click="chooseSearchEngine(item)"
                      @pointerenter="engineMenuActive = index"
                    >
                      <span class="engine-check" aria-hidden="true">
                        <ShellIcon v-if="searchEngine === item" name="check" />
                      </span>
                      <span class="label">{{ searchEngineLabels[item] }}</span>
                    </button>
                  </li>
                </ul>
              </Teleport>
            </div>
          </div>
        </div>
      </section>

      <section id="flash-section" class="setting-section" :hidden="section !== 'engine'" aria-labelledby="flash-title">
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

      <section class="setting-section" :hidden="section !== 'engine'" aria-labelledby="rules-title">
        <header class="section-heading">
          <h2 id="rules-title">站点引擎规则</h2>
          <p class="section-caption">
            各站点「记住的引擎」决定它下次打开用哪种渲染方式
          </p>
        </header>
        <div class="setting-card">
          <div class="select-row">
            <span>已记住 {{ engineRules.length }} 个站点</span>
            <button type="button" class="action" aria-label="清除站点引擎规则" :disabled="rulesClearing || engineRules.length === 0" @click="clearEngineRules">全部清除</button>
          </div>
          <p v-if="engineRules.length === 0" class="lead">还没有记住的站点。</p>
          <template v-else>
            <!-- 规则可能很多（每个站点一条）：超过阈值给过滤框，列表自身封顶滚动，
                 不把整页拉成几千像素（2026-11-26）。 -->
            <input
              v-if="engineRules.length > RULE_FILTER_THRESHOLD"
              v-model="ruleQuery"
              type="search"
              class="rule-filter"
              aria-label="按站点过滤规则"
              placeholder="按站点过滤"
              spellcheck="false"
            >
            <ul v-if="filteredRules.length" class="rule-list">
              <li v-for="rule in filteredRules" :key="rule.host" class="select-row rule-row">
                <span class="rule-host" :title="rule.host">{{ rule.host }}</span>
                <span class="rule-engine">{{ engineLabels[rule.engine] }}</span>
                <button
                  type="button"
                  class="action"
                  :aria-label="`忘记 ${rule.host} 的引擎规则`"
                  :disabled="forgetting.has(rule.host)"
                  @click="forgetRule(rule.host)"
                >忘记</button>
              </li>
            </ul>
            <p v-else class="lead">没有匹配「{{ ruleQuery }}」的站点。</p>
          </template>
          <p v-if="rulesNotice" role="status">{{ rulesNotice }}</p>
        </div>
      </section>

      <section class="setting-section" :hidden="section !== 'startup'" aria-labelledby="startup-title">
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

      <section class="setting-section" :hidden="section !== 'performance'" aria-labelledby="perf-title">
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

      <section class="setting-section" :hidden="section !== 'language'" aria-labelledby="language-title">
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
          <p class="section-caption">清除保存在本机上的浏览会话</p>
        </header>
        <div class="setting-card">
          <div class="select-row">
            <span>已保存的会话</span>
            <button type="button" class="action" aria-label="清除已保存的会话" :disabled="sessionClearing" @click="clearSession">清除</button>
          </div>
          <p class="lead">删除上次退出时保存的标签记录与崩溃恢复提示。清除后本次运行不再记录会话，下次启动恢复记录。</p>
          <p v-if="dataNotice" role="status">{{ dataNotice }}</p>
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
            <!-- 关于里只放状态摘要：导入/定位这些动作都在「引擎 → Flash 插件」那张卡里，
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
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 38px;
  padding: 0 12px;
  border-radius: 8px;
  font-size: 13px;
  text-align: left;
  color: var(--text-primary);
  transition: background var(--motion-fast), color var(--motion-fast);
}
.settings-nav button .shell-icon { color: var(--text-secondary); }
.settings-nav button:hover:not([aria-current='page']) { background: var(--surface-hover); }
/* 选中项照 Edge：中性选中面 + 左侧 3px 竖条（品牌色不再染整颗胶囊） */
.settings-nav button[aria-current='page'] {
  background: var(--surface-selected);
  font-weight: 600;
  box-shadow: none;
}
.settings-nav button[aria-current='page'] .shell-icon { color: var(--text-primary); }
.settings-nav button[aria-current='page']::before {
  content: '';
  position: absolute;
  left: 3px;
  top: 50%;
  translate: 0 -50%;
  width: 3px;
  height: 18px;
  border-radius: 2px;
  background: var(--text-primary);
}
.settings-nav button:disabled { color: var(--text-secondary); opacity: 0.55; }
/* Edge 用空行把导航分三组：这里只做视觉分隔，不参与点击/焦点。 */
.nav-gap { height: 14px; }

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
/*
 * 搜索引擎下拉框（2026-11-26 反馈：竖排单选把六项铺成六行，占半屏却没信息量）。
 *
 * 触发按钮与菜单都照 Edge 的「地址栏中使用的搜索引擎」：右侧一个小圆角浅灰按钮 + 下箭头，
 * 展开是一张带投影的浮层，当前项打勾。菜单**绝对定位**在触发按钮下方，不撑高卡片。
 */
.engine-select { position: relative; flex: none; }
.engine-trigger {
  display: inline-grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 0 10px;
  border: 1px solid var(--stroke-control);
  border-radius: 8px;
  background: var(--surface-page);
  font-size: 13px;
}
.engine-trigger:hover { background: var(--surface-hover); }
.engine-trigger[aria-expanded='true'] { background: var(--surface-pressed); }
.engine-trigger:focus-visible { outline: 2px solid var(--stroke-focus-ring); outline-offset: 1px; }
.engine-trigger-label,
.engine-trigger-sizer { grid-area: 1 / 1; }
.engine-trigger-label { justify-self: start; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 隐形量宽层：绝对定位（不参与布局），只用来量"最宽的引擎名"有多宽。 */
.engine-trigger-sizer {
  position: absolute;
  top: 0;
  left: 0;
  display: grid;
  visibility: hidden;
  pointer-events: none;
}
.engine-trigger-sizer > span { grid-area: 1 / 1; white-space: nowrap; }
.engine-chevron { grid-area: 1 / 2; width: 12px; height: 12px; flex: none; color: var(--text-secondary); }
.engine-menu {
  /* Teleport 到 body 之后用 fixed：位置与**宽度**由 `placeEngineMenu()` 按触发按钮的矩形算。 */
  position: fixed;
  z-index: 1000;
  box-sizing: border-box;
  max-height: 300px;
  margin: 0;
  padding: 4px;
  overflow-y: auto;
  list-style: none;
  border: 1px solid var(--stroke-control);
  border-radius: 10px;
  background: var(--surface-toolbar);
  box-shadow: 0 8px 24px rgb(0 0 0 / 14%), 0 2px 6px rgb(0 0 0 / 8%);
}
.engine-option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 34px;
  padding: 0 10px;
  border-radius: 7px;
  font-size: 13px;
  text-align: start;
}
.engine-option:hover, .engine-option.active { background: var(--surface-hover); }
.engine-option[aria-selected='true'] { background: var(--surface-selected); }
/* 宽度跟触发按钮走，长标签截断而不是把菜单撑宽。 */
.engine-option .label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.engine-check { display: grid; place-items: center; width: 14px; height: 14px; flex: none; }
.engine-check .shell-icon { width: 14px; height: 14px; }
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

/* 站点引擎规则列表：host 占满剩余宽度（超长省略），引擎是次要信息，忘记按钮固定右侧。
   列表**自身封顶滚动**：规则按站点一条，几百条时不该把整页拉长到几千像素。 */
.rule-list {
  margin: 0 0 8px;
  padding: 0;
  list-style: none;
  max-height: 264px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}
.rule-filter {
  width: 100%;
  min-height: 34px;
  margin: 2px 0 6px;
  padding: 0 12px;
  border: 1px solid var(--stroke-control);
  border-radius: 8px;
  background: var(--surface-toolbar);
  color: var(--text-primary);
  font: inherit;
  font-size: 13px;
}
.rule-filter::placeholder { color: var(--text-secondary); }
.rule-filter:focus-visible { outline: 2px solid var(--stroke-focus-ring); outline-offset: 1px; }
.rule-row { justify-content: flex-start; }
.rule-host {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rule-engine { flex: none; font-size: 12px; color: var(--text-secondary); }

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
