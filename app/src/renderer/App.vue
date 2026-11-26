<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { TAB_BAR_HEIGHT, TOOLBAR_HEIGHT, BOOKMARK_BAR_HEIGHT } from '../shared/browser'
import type { BrowserCommand, BrowserTab } from '../shared/browser'
import {
  BOOKMARK_BAR_ROOT, bookmarkForAddress, childrenOf, isBookmarkableAddress
} from '../shared/bookmarks'
import type { BookmarkNode } from '../shared/bookmarks'
import { engineLabels, engineSourceLabels } from '../shared/engine'
import type { OverlayBounds, QuickView } from '../shared/overlay'
import {
  ENGINE_PANEL_INITIAL_HEIGHT, OVERLAY_GUTTER_X, TOAST_HEIGHT, TOAST_WIDTH, flyoutBounds,
  panelBounds as enginePanelBounds
} from '../shared/overlay-geometry'
import type { FlyoutAnchor } from '../shared/overlay-geometry'
import ShellIcon from './ShellIcon.vue'
import { applyShellTheme } from './theme'
import { useBrowserStore } from './stores/browser'
import { dropSlotIndex, finalDropIndex } from './tab-drag'

const DRAG_THRESHOLD = 6

const shellStyle = {
  '--tab-bar-height': `${TAB_BAR_HEIGHT}px`,
  '--toolbar-height': `${TOOLBAR_HEIGHT}px`,
  // 横条高度（横条本身用 `v-if` 整行拿掉；变量供错误页的 `min-height` 计算用）。
  '--bookmark-bar-height': `${BOOKMARK_BAR_HEIGHT}px`
}

const store = useBrowserStore()
const { snapshot: state, message, active } = storeToRefs(store)
const address = ref('')
const addressField = ref<HTMLInputElement>()
const tabStrip = ref<HTMLElement>()

interface TabDrag {
  id: number
  startX: number
  startY: number
  screenX: number
  screenY: number
  moved: boolean
}

let tabDrag: TabDrag | undefined
let suppressSelect = false
const draggingId = ref<number>()

/**
 * 地址栏里是否有**用户自己敲的、尚未提交**的草稿。
 *
 * 为什么需要它：外壳启动后的首份状态广播可能晚于用户输入。实测（常驻预热档，
 * `scripts/probe-overlay-navigation*.cjs` + 应用内埋点）：填好地址 → 状态广播到达 →
 * 输入框被重置成 `active.address`（新标签页是空串）→ 回车等于导航到空地址，
 * 标签永远停在新标签页。症状在外壳套件里表现为整片 30 s 超时、现场 `active:''`，
 * 一度被误判为「共享浮层抢焦点」。
 *
 * 判定刻意用"用户是否敲过"而不是"值是否与上次同步不同"：后者分不清"用户输入"与
 * "程序化切标签/导航"，会把切标签后的地址栏也钉在旧值上（实测把 Ctrl+,→设置页那条用例钉死）。
 */
const addressDirty = ref(false)

/** 把输入框同步回当前标签的地址（提交后、离开输入框时用）。 */
function syncAddressFromActive(): void {
  addressDirty.value = false
  address.value = active.value?.address ?? ''
}

watch([() => active.value?.id, () => active.value?.address], () => {
  // 用户有未提交草稿时不覆盖；其余一律跟随标签状态。
  if (!addressDirty.value) address.value = active.value?.address ?? ''
  message.value = ''
})

watch([() => active.value?.id, () => active.value?.internal], ([id]) => {
  tabStrip.value?.querySelector('.selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  /**
   * 新标签页：焦点进地址栏（Chrome 的 `ShouldFocusLocationBarByDefault`）。
   * 主进程把焦点交给了外壳（NTP 视图不抢焦点），这里补上「输入框」这一步；
   * `Ctrl+T`、`+`、从网页 Back 回 NTP 因此行为一致。
   */
  const tab = state.value?.tabs.find((item) => item.id === id)
  if (tab?.internal === 'newtab') {
    void nextTick(() => {
      if (document.activeElement !== addressField.value) addressField.value?.focus({ preventScroll: true })
    })
  }
}, { flush: 'post' })

watch(() => state.value?.theme, (theme) => {
  if (theme) applyShellTheme(theme)
})

/** 地址栏回车：提交即视为「草稿已交出去」，之后跟随标签状态。 */
function submitAddress(): void {
  addressDirty.value = false
  void run({ type: 'navigate', address: address.value })
}

function run(command: BrowserCommand): Promise<boolean> {
  return store.run(command)
}

/**
 * 引擎按钮（2026-11-26 重做）：**一个按钮**，点开就是引擎飞窗。
 *
 * 之前是「胶囊（内联开关 Flash ⇄ Ruffle）+ 下箭头（开飞窗）」两块拼起来，跟工具栏其它
 * 图标按钮尺寸/形状都不一样。现在照 Edge 的扩展按钮：统一 32×32、图标表示当前引擎、
 * 点击展开飞窗——切换引擎这件事本来就该在飞窗里做（那里还有「记住当前引擎」和来源说明）。
 *
 * 内部页（`bao://newtab`、`bao://settings`）**禁用而不是隐藏**：隐藏会让工具栏宽度随标签
 * 来回变，视觉上像在跳；置灰 + 点了没反应（也不弹飞窗）语义更清楚。
 */
const engineSwitchable = computed(() => Boolean(active.value && !active.value.internal))
const engineTitle = computed(() => {
  const tab = active.value
  if (!tab) return ''
  if (tab.internal) return '新标签页没有可切换的站点引擎'
  const current = `渲染引擎：${engineLabels[tab.engine]}`
  return tab.pinnedEngine
    ? `${current} · 站点已记住 ${engineLabels[tab.pinnedEngine]}`
    : `${current}（${engineSourceLabels[tab.engineSource]}）`
})

const enginePanelOpen = ref(false)
const engineRoot = ref<HTMLButtonElement>()

/**
 * 收藏夹星标（M2 收藏夹第一轮）：**页面级**状态——当前页有没有收藏过。
 *
 * 内部页（`bao://newtab`、`bao://settings`）不是站点，星标**禁用而不是隐藏**：
 * 隐藏会让工具栏宽度随标签来回变（与引擎按钮同一条约定），置灰 + 点了没反应语义更清楚。
 *
 * "有没有收藏"由主进程的收藏夹投影算（`bookmarkForAddress` 按完整地址比对，与 Chromium 一致）：
 * 界面不自己缓存一份，也就不会出现"删了收藏星标还亮着"。
 */
const bookmarkable = computed(() => {
  const tab = active.value
  return Boolean(tab && !tab.internal && isBookmarkableAddress(tab.address))
})
const bookmarked = computed(() => {
  const tab = active.value
  if (!tab || tab.internal) return undefined
  return bookmarkForAddress(state.value?.bookmarks ?? [], tab.address)
})
const bookmarkTitle = computed(() => {
  const tab = active.value
  if (!tab) return ''
  // 内部页（新标签页/设置页）都没有站点：这里说的是"这个页面"，不假定是哪一个。
  if (tab.internal) return '这个页面没有可收藏的地址'
  if (bookmarked.value) return `已收藏：${bookmarked.value.title}`
  return `收藏此页面：${tab.title}`
})
const toast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | undefined
let detachOverlay: (() => void) | undefined

/**
 * 齿轮快捷设置飞窗（M2 增量 2 下半）。
 *
 * 定位：顶边压在齿轮按钮下沿（0 缝）、右边缘与按钮对齐；横向与高度都交给主进程按窗口
 * 内容区夹取（`shell-overlays.ts` 的 `clampBounds`），所以飞窗**永远在窗口内**，内容超出
 * 时由面板自己滚动。宽 320 是 Chromium 菜单的常见宽度，外面留 16 px 给投影。
 */
/**
 * 飞窗挂在按钮下方：右边缘与按钮右缘对齐、顶边贴住按钮下沿。
 * 视图尺寸 = 面板尺寸（没有给投影预留的透明留白，否则会看到一条「光影」）。
 *
 * 同一只飞窗有三个内容页（快捷设置 / 收藏夹 / 编辑收藏夹，见 `shared/overlay.ts` 的
 * `QuickView`）：宽度各给一个值，高度只给初始值（打开后第一帧就会被 `resize-quick` 纠正）。
 */
const QUICK_WIDTH = 320
const QUICK_INITIAL_HEIGHT = 320
/** 收藏夹（树）与快捷设置同宽：三只飞窗挂在一起，宽度不同会显得像三套东西。 */
const BOOKMARKS_WIDTH = 320
const BOOKMARKS_INITIAL_HEIGHT = 300
/** 编辑收藏夹气泡：与快捷设置同宽（Chromium 的气泡也就 320–380 的量级）。 */
const BUBBLE_WIDTH = 320
const BUBBLE_INITIAL_HEIGHT = 260
/** 完整编辑器（气泡里的「更多」）：更高更宽，但仍然是一只锚在星标下的飞窗。 */
const EDITOR_WIDTH = 400
const EDITOR_INITIAL_HEIGHT = 520
const gearRoot = ref<HTMLButtonElement>()
/** 工具栏「收藏夹」按钮（Edge 那颗）：打开收藏夹树，与星标不是一回事。 */
const bookmarksRoot = ref<HTMLButtonElement>()
/** 地址栏里的星标：收藏当前页 + 展开编辑气泡。 */
const bookmarkRoot = ref<HTMLButtonElement>()
const quickOpen = ref(false)
/**
 * 飞窗当前画哪一页——同时也是「飞窗挂在哪颗按钮下」：
 * 打开时按它算锚点，关闭后按它把焦点还给那颗按钮。
 */
const quickView = ref<QuickView>('settings')

/** 每个内容页的锚点按钮（星标在地址栏里，另外两个是工具栏按钮）。 */
function quickAnchorFor(view: QuickView): HTMLButtonElement | undefined {
  // 横条上的文件夹按钮：面板从**那颗**按钮下面展开（不是工具栏的收藏夹按钮）。
  // 没有覆盖时才落回默认锚点。
  if (view === 'bookmarks' && barFolderAnchor.value) return barFolderAnchor.value
  if (view === 'bookmarks') return bookmarksRoot.value
  if (view === 'bookmark-edit' || view === 'bookmark-editor') return bookmarkRoot.value
  return gearRoot.value
}

function quickGeometry(view: QuickView): { width: number; height: number } {
  if (view === 'bookmarks') return { width: BOOKMARKS_WIDTH, height: BOOKMARKS_INITIAL_HEIGHT }
  if (view === 'bookmark-edit') return { width: BUBBLE_WIDTH, height: BUBBLE_INITIAL_HEIGHT }
  if (view === 'bookmark-editor') return { width: EDITOR_WIDTH, height: EDITOR_INITIAL_HEIGHT }
  return { width: QUICK_WIDTH, height: QUICK_INITIAL_HEIGHT }
}

function quickBounds(view: QuickView): OverlayBounds | null {
  const rect = quickAnchorFor(view)?.getBoundingClientRect()
  if (!rect) return null
  const { width, height } = quickGeometry(view)
  return flyoutBounds(anchorOf(rect), width, height)
}

/** 锚点：按钮右缘 + 按钮下缘——飞窗紧贴按钮展开（顶边不再落到工具栏下沿）。 */
function anchorOf(rect: { right: number; bottom: number; left?: number }): FlyoutAnchor {
  return {
    anchorRight: rect.right,
    anchorBottom: rect.bottom,
    viewportWidth: window.innerWidth,
    // 右边放不下时飞窗改成左对齐（横条上的文件夹按钮就属于这种位置）。
    anchorLeft: rect.left
  }
}

/**
 * 打开飞窗的指定页（不管当前开没开）。
 *
 * 换页（齿轮里点「收藏夹」、列表开着时点星标）= **同一个视图换内容并重新锚定**，
 * 不销毁文档、不重新预热——这正是"一个视图多个内容页"换来的收益。
 */
async function openQuick(view: QuickView): Promise<void> {
  const bounds = quickBounds(view)
  if (!bounds) return
  if (!quickOpen.value) closeEnginePanel()
  await ensureSharedOverlay()
  quickView.value = view
  quickOpen.value = true
  if (!await window.baoOverlay.setQuick(bounds, view)) quickOpen.value = false
}

/** 按钮式开关：同页再点一次 = 关。 */
async function toggleQuick(view: QuickView): Promise<void> {
  if (quickOpen.value && quickView.value === view) {
    closeQuick(true)
    return
  }
  // 工具栏按钮打开的收藏夹面板必须锚回工具栏；横条文件夹的锚点只对那一次点击有效。
  if (view === 'bookmarks') barFolderAnchor.value = undefined
  await openQuick(view)
}

/**
 * 收藏夹横条（M2 收藏夹第二轮）：工具栏下面那第三行。
 *
 * 内容只平铺「收藏夹栏」根下的**一层**（Chromium 的横条也是这一层）：
 * - 网址项：点一下就在当前标签打开（`open-bookmark` 按 id 取地址，界面拿不到任意导航）；
 * - 文件夹：点开的是**收藏夹面板**（锚在那颗按钮下），里层在面板里展开——横条下方
 *   弹出的文件夹菜单需要一只独立的弹出层，见 `docs/reports/2026-11-26-bookmarks-store.md` §6。
 *
 * **显示与否由主进程给**（`state.bookmarkBarShown`）：规则本体是 `showsBookmarkBar()`，
 * 但还带时序（导航途中按住，见 `Tab.barHold`）——外壳自己拿 `settings` 算会把横条画早收早。
 */
const barEl = ref<HTMLElement>()
/** 横条上的文件夹按钮：面板的临时锚点（关闭后清掉）。 */
const barFolderAnchor = ref<HTMLButtonElement>()

const barVisible = computed(() => state.value?.bookmarkBarShown === true)
const barItems = computed<BookmarkNode[]>(() => childrenOf(state.value?.bookmarks ?? [], BOOKMARK_BAR_ROOT))

/**
 * 放不下的项从第几个开始隐藏（Chromium 的 `first_hidden_node_idx_`）。
 *
 * 为什么用 `visibility` 而不是 `v-if`：**隐藏的项必须继续占布局**，否则"先全部排出来量一次、
 * 再藏掉放不下的"这套测量会在第二次收敛时把已被藏起来的项当成"宽度为 0、能放下"。
 * 布局稳定 + 一次测量即可收敛，不会有来回抖动的正反馈。
 */
const barClippedFrom = ref(Number.POSITIVE_INFINITY)
/**
 * 右侧给「更多」预留的宽度：24px 按钮 + 6px 右边距（`inset-inline-end`）+ 2px 与最后一项的间隙。
 *
 * 必须**无条件预留**再量：不预留的话，"刚好放满"时会多出一个按钮、把最后一项挤出去，
 * 而按钮出现与否又会改变量到的宽度 —— 那就是一个来回抖动的正反馈。
 */
const BAR_OVERFLOW_RESERVE = 32

function measureBar(): void {
  const element = barEl.value
  if (!element || barItems.value.length === 0) {
    barClippedFrom.value = Number.POSITIVE_INFINITY
    return
  }
  const limit = element.clientWidth - BAR_OVERFLOW_RESERVE
  let count = 0
  for (const child of element.querySelectorAll<HTMLElement>('.bar-item:not(.bar-overflow)')) {
    // `offsetLeft` 相对横条（它是 position: relative 的定位祖先）且含自身左内边距。
    if (child.offsetLeft + child.offsetWidth > limit) break
    count += 1
  }
  barClippedFrom.value = count
}

/**
 * 网址项：在当前标签打开（地址由主进程按 id 从库里取）。
 *
 * 失败不用自己提示：`store.run()` 会把稳定错误码的文案写进 `message`，那条 watch 已经
 * 负责弹提示条——这里再弹一次就是两条。
 */
async function openBarItem(node: BookmarkNode): Promise<void> {
  if (node.kind !== 'url') return
  await run({ type: 'open-bookmark', id: node.id })
}

/** 文件夹项：面板从那颗按钮下面展开（再点一次收起）。 */
async function toggleBarFolder(node: BookmarkNode, event: MouseEvent): Promise<void> {
  const button = event.currentTarget as HTMLButtonElement
  if (quickOpen.value && quickView.value === 'bookmarks' && barFolderAnchor.value === button) {
    closeQuick(true)
    return
  }
  barFolderAnchor.value = button
  await openQuick('bookmarks')
}

/**
 * 地址栏星标（Chromium 的 `BookmarkCurrentTab`）：**先落库，再弹气泡**。
 *
 * 源码依据 `chrome/browser/ui/browser_commands.cc:1634`：命令里先
 * `AddIfNotBookmarked(model, url, title)`，紧接着 `ShowBookmarkBubble(url, was_bookmarked)`；
 * 所以**第一次点击也会弹气泡**（标题「已添加收藏夹」），再点才是「编辑收藏夹」。
 * 气泡只负责改名字/换文件夹/删除，不负责"创建"——创建在点下去那一刻就完成了。
 */
async function toggleBookmarkBubble(): Promise<void> {
  if (!bookmarkable.value) return
  if (quickOpen.value && quickView.value === 'bookmark-edit') {
    closeQuick(true)
    return
  }
  if (!bookmarked.value && !await run({ type: 'bookmark-page' })) return
  await openQuick('bookmark-edit')
}

/** 共享进程模式探测结果（只问一次）。 */
let sharedOverlayMode: boolean | undefined
/** 已经打开的浮层窗口句柄；窗口被关掉（closed）才重新开。 */
let sharedOverlayWindow: Window | null = null
/** 正在进行的开窗动作（单飞）：预热事件与点击兜底可能几乎同时调用它。 */
let sharedOverlayOpening: Promise<void> | undefined

/**
 * 共享进程模式（proto）：浮层由外壳自己 `window.open` 产生，复用外壳的渲染进程。
 *
 * 注意**不能**每次都 `window.open(url, name)`：同名窗口会被复用，但会`navigate`到该 URL，
 * 也就是把浮层文档整个重新加载（实测：预热先开窗、点击再来一次 → 文档重载 → 已订阅的
 * 监听器、DOM 状态全丢，飞窗打开后既收不到 `quick-opened` 也没有焦点）。
 * 因此这里缓存 WindowProxy，窗口还活着就直接返回，只做幂等的「保证存在」
 * （主进程把文档关掉后 `.closed` 变 true，自然会重新开一份）。
 *
 * 而且必须**单飞**：预热事件与紧随其后的点击间隔十几毫秒，
 * 两个调用会同时看到 `sharedOverlayWindow === null` → 连开两次同名窗口（第二次把第一次
 * 导航掉）→ 飞窗文档刚好在 `setQuick` 那一刻被重载，视图亮着但内容/订阅全空。
 * 见 docs/discussions/2026-11-25-overlay-shared-process-demo.md
 */
function ensureSharedOverlay(): Promise<void> {
  sharedOverlayOpening ??= openSharedOverlay().finally(() => { sharedOverlayOpening = undefined })
  return sharedOverlayOpening
}

async function openSharedOverlay(): Promise<void> {
  if (sharedOverlayMode === undefined) sharedOverlayMode = await window.baoOverlay.sharedMode()
  if (!sharedOverlayMode) return
  if (sharedOverlayWindow && !sharedOverlayWindow.closed) return
  try {
    const url = new URL(location.href)
    url.search = '?baoOverlay=overlay'
    sharedOverlayWindow = window.open(url.href, 'bao-overlay', 'width=600,height=520')
  } catch (error) {
    sharedOverlayWindow = null
  }
}
/**
 * 预热（设置项 `overlay.prewarm` 打开时，默认开）：文档建好后就一直在，**第一次点开也是热的**。
 *
 * 触发权在主进程（`overlay-prewarm` 事件）：共享模式下建文档要由外壳 `window.open` 完成，
 * 而"该不该建"取决于主进程独占的信息（设置项、自动化/后台模式、策略覆盖）。
 *
 * 时机是**立刻**，不等空闲：主进程在 `window.show()` **之前**推这个事件，那时窗口还不可见，
 * 用户不可能正在输入，因此"建文档"与"用户打字"不可能重叠。这一条是被实测逼出来的——
 * 放在空闲时刻建时，开窗恰好落在"用户填好地址、还没敲回车"的窗口里，回车被吞（见 §7.4）。
 * 价格实测每窗口 5–9 MB（共享进程），代价是启动期多付一次开窗（~40 ms 量级）。
 */
function prewarmSharedOverlay(): void {
  void ensureSharedOverlay()
}

function closeQuick(restoreFocus = false): void {
  if (!quickOpen.value) return
  quickOpen.value = false
  // 外壳侧关闭走 `set-quick(null)`：`close-quick` 是飞窗自己（quick 角色）用来关闭并
  // 请求焦点归还的命令，外壳调用会被发送者校验拒绝。
  void window.baoOverlay.setQuick(null)
  // 焦点要先还给**打开它的那颗**按钮，再清掉横条文件夹的临时锚点。
  if (restoreFocus) quickAnchor()?.focus()
  barFolderAnchor.value = undefined
}

/** 焦点归还目标：飞窗挂在哪颗按钮下就还给谁（星标 ↔ 收藏夹 ↔ 齿轮）。 */
function quickAnchor(): HTMLButtonElement | undefined {
  return quickAnchorFor(quickView.value)
}

/**
 * 崩溃恢复气泡（M2 会话恢复第二轮，2026-11-26）：Chromium 的 `SessionCrashedBubbleView`。
 *
 * 与 11-24 那版的区别只有一个：**载体从外壳 DOM 的提示条换成叠加层气泡**。理由有两条：
 * - 与 Chrome / Edge 一致（源码 `chrome/browser/ui/views/session_crashed_bubble_view.cc`：
 *   警示对话框锚在工具栏最右那颗按钮下，失焦不关，一个「恢复」+ 右上角 ×）；
 * - 提示条要占 36px 布局高度、把页面整体下推，回答完再跳回去；气泡浮在页面上，不动布局。
 *
 * 为什么不能画在外壳 DOM 里：页面是独立的 WebContentsView，压在外壳视图之上，
 * 气泡往页面区一伸就被截掉。所以走飞窗那套叠加层视图（同一个渲染进程，不新增进程）。
 */
const SESSION_BUBBLE_WIDTH = 340
const SESSION_BUBBLE_INITIAL_HEIGHT = 120
const sessionBubbleOpen = ref(false)
/** 气泡文案里的标签数：投影里 `sessionPrompt.tabs`，回答后随投影一起消失。 */
const sessionBubbleTabs = computed(() => state.value?.sessionPrompt?.tabs ?? 0)

/**
 * 锚点 = 工具栏**最右那颗**按钮（Chromium 用应用菜单 `GetAppMenuButton()`，我们最右是齿轮）。
 *
 * 拿不到按钮矩形时（极端窄窗/首帧）退回"窗口右缘、工具栏下沿"，宁可位置略糙也不要不显示：
 * 这是"上次崩溃了，要不要恢复"的唯一入口。
 */
function sessionBubbleBounds(): OverlayBounds {
  const rect = gearRoot.value?.getBoundingClientRect()
  if (rect) return flyoutBounds(anchorOf(rect), SESSION_BUBBLE_WIDTH, SESSION_BUBBLE_INITIAL_HEIGHT)
  return {
    x: Math.max(0, window.innerWidth - SESSION_BUBBLE_WIDTH - OVERLAY_GUTTER_X),
    y: TAB_BAR_HEIGHT + TOOLBAR_HEIGHT,
    width: SESSION_BUBBLE_WIDTH,
    height: SESSION_BUBBLE_INITIAL_HEIGHT
  }
}

async function openSessionBubble(): Promise<void> {
  await ensureSharedOverlay()
  sessionBubbleOpen.value = true
  const bounds = sessionBubbleBounds()
  if (await window.baoOverlay.setBubble(bounds, sessionBubbleTabs.value)) return
  /**
   * 共享进程模式下，叠加层文档是外壳刚 `window.open` 出来的：主进程接管与这条
   * `set-bubble` 可能撞在同一刻，视图还没就绪就会返回 false。接管是同步完成的，
   * 让一帧再试一次就够——不留重试的话，气泡要等到下一次投影变化才出现（可能就是永远不出现）。
   */
  await new Promise((done) => setTimeout(done, 120))
  if (!await window.baoOverlay.setBubble(sessionBubbleBounds(), sessionBubbleTabs.value)) {
    sessionBubbleOpen.value = false
  }
}

/** 提示消失了（已回答/被清除）：收起气泡。**收起不等于回答**，回答走 `close-bubble`。 */
function closeSessionBubble(): void {
  if (!sessionBubbleOpen.value) return
  sessionBubbleOpen.value = false
  void window.baoOverlay.setBubble(null, 0)
}

/**
 * 气泡是投影的一部分：`sessionPrompt` 在，气泡就该在（外壳重载后也会自己回来）。
 *
 * 盯的是**标签数**而不是整个 `sessionPrompt` 对象：主进程每次广播都会新建投影对象，
 * 盯对象会让每次状态变化都重发一遍 `set-bubble`。
 */
watch(() => state.value?.sessionPrompt?.tabs, (tabs) => {
  if (tabs === undefined) {
    closeSessionBubble()
    return
  }
  if (sessionBubbleOpen.value) {
    // 已经在显示：只把标签数与锚点刷新一遍（窗口缩放、多窗口会话并回后重开提示）。
    void window.baoOverlay.setBubble(sessionBubbleBounds(), tabs)
    return
  }
  void openSessionBubble()
}, { immediate: true })

function panelBounds(): OverlayBounds | null {
  const rect = engineRoot.value?.getBoundingClientRect()
  if (!rect) return null
  return enginePanelBounds(anchorOf(rect), ENGINE_PANEL_INITIAL_HEIGHT)
}

async function toggleEnginePanel(): Promise<void> {
  // 内部页没有站点可切：按钮是禁用态，点了也不该弹飞窗（2026-11-26）。
  if (!engineSwitchable.value) return
  if (enginePanelOpen.value) {
    closeEnginePanel()
    return
  }
  closeQuick(false)
  const bounds = panelBounds()
  if (!bounds) return
  await ensureSharedOverlay()
  enginePanelOpen.value = true
  if (!await window.baoOverlay.setPanel(bounds)) enginePanelOpen.value = false
}

function closeEnginePanel(): void {
  if (!enginePanelOpen.value) return
  enginePanelOpen.value = false
  void window.baoOverlay.setPanel(null)
}

/** 网页与浮层有独立 WebContents；这里只处理外壳范围内的点击。 */
function onShellPointerDown(event: PointerEvent): void {
  if (!(event.target instanceof Node)) return
  // 四颗入口（星标/收藏夹/引擎/齿轮）自己的点击由它们的 handler 负责开关：
  // 在这里先关一次会让「点星标」变成"先关再开"，多一次往返还会闪一下。
  // 横条上的文件夹按钮同理——它是**当时**那条飞窗的锚点。
  const anchor = [bookmarkRoot.value, bookmarksRoot.value, engineRoot.value, gearRoot.value, barFolderAnchor.value]
    .some((element) => element?.contains(event.target as Node))
  if (anchor) return
  closeEnginePanel()
  closeQuick(false)
}

function clearToast(): void {
  clearTimeout(toastTimer)
  toast.value = ''
}

function showToast(text: string): void {
  clearTimeout(toastTimer)
  toast.value = text
  const bounds = {
    x: 0,
    // 提示条贴住页面区域上沿：横条显示时它跟着下移，否则会压在横条上。
    y: TAB_BAR_HEIGHT + TOOLBAR_HEIGHT + (barVisible.value ? BOOKMARK_BAR_HEIGHT : 0),
    width: TOAST_WIDTH,
    height: TOAST_HEIGHT
  }
  // 共享模式：提示条也可能在没有任何预热的情况下出现（关掉预热时），先确保浮层文档存在。
  void ensureSharedOverlay().then(() => window.baoOverlay.setToast({ bounds, text }))
  toastTimer = setTimeout(() => {
    clearToast()
    void window.baoOverlay.setToast(null)
  }, 6500)
}

watch(message, (text) => { if (text) showToast(text) })
let lastNoticeId = 0
watch(() => active.value?.notice, (notice) => {
  if (notice && notice.id > lastNoticeId) {
    lastNoticeId = notice.id
    showToast(notice.message)
  }
})
watch(() => active.value?.id, closeEnginePanel)
watch(() => active.value?.id, () => closeQuick(false))

function onShellResize(): void {
  // Close anchored settings rather than leave them detached from the trigger.
  closeEnginePanel()
  closeQuick(false)
  // 气泡跟着锚点按钮走（Chromium 的 bubble 会随窗口重锚），不关——它还在等回答。
  if (sessionBubbleOpen.value) void openSessionBubble()
}

onMounted(() => {
  // 共享模式探测提前问一次（点击路径里不要再等一次 IPC）。这里**不**顺手开窗：
  // 开窗时机只由主进程的 `overlay-prewarm` 事件决定（窗口 show 之前那一刻，用户不可能正在输入）。
  // 见 docs/discussions 2026-11-25 飞窗共享进程。
  void window.baoOverlay.sharedMode().then((mode) => { sharedOverlayMode = mode })
  detachOverlay = window.baoOverlay.subscribe((event) => {
    if (event.type === 'panel-closed') {
      enginePanelOpen.value = false
      if (event.restoreFocus) engineRoot.value?.focus()
    } else if (event.type === 'quick-closed') {
      quickOpen.value = false
      if (event.restoreFocus) quickAnchor()?.focus()
    } else if (event.type === 'bubble-closed') {
      // 气泡已经收起（用户回答、被别的浮层顶掉、或提示被清除）。不还焦点：
      // 回答完该落到恢复出来的页面/标签上，由主进程的 `select()` 决定焦点。
      sessionBubbleOpen.value = false
    } else if (event.type === 'bookmarks-requested') {
      // 飞窗里的「收藏夹」入口：锚点与开关都在外壳这边。
      void toggleQuick('bookmarks')
    } else if (event.type === 'bookmark-editor-requested') {
      // 气泡里的「更多」：换到完整编辑器（锚点仍是星标）。
      void openQuick('bookmark-editor')
    } else if (event.type === 'toast-closed') clearToast()
    else if (event.type === 'overlay-prewarm') prewarmSharedOverlay()
    else if (event.type === 'failure') showToast(event.text)
  })
  document.addEventListener('pointerdown', onShellPointerDown, true)
  window.addEventListener('resize', onShellResize)
})
onBeforeUnmount(() => {
  detachOverlay?.()
  clearToast()
  barObserver?.disconnect()
  document.removeEventListener('pointerdown', onShellPointerDown, true)
  window.removeEventListener('resize', onShellResize)
})

/**
 * 横条放不下的项由「排一次、藏掉超出的」收口（见 `measureBar`）。
 *
 * 三个触发源：横条出现/消失、项数变化、横条宽度变化（窗口缩放）。
 * `flush: 'post'` 保证测量时 DOM 已经按新的项数排好——不然量到的是上一帧的布局。
 */
let barObserver: ResizeObserver | undefined
watch([barVisible, barItems], () => { void nextTick(measureBar) }, { flush: 'post' })
watch(barEl, (element) => {
  barObserver?.disconnect()
  barObserver ??= new ResizeObserver(() => measureBar())
  if (element) barObserver.observe(element)
}, { flush: 'post' })

/** 拖出窗口（架构 §3「拖出窗口」）：指针捕获保证移出窗口后仍能拿到释放点。 */
function startTabDrag(tab: BrowserTab, event: PointerEvent): void {
  suppressSelect = false
  if (event.button !== 0) return
  if ((event.target as HTMLElement | null)?.closest('.close-tab')) return
  tabDrag = {
    id: tab.id,
    startX: event.screenX,
    startY: event.screenY,
    screenX: event.screenX,
    screenY: event.screenY,
    moved: false
  }
  draggingId.value = tab.id
  try {
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  } catch {
    // 合成事件或指针已释放：不阻断拖动逻辑
  }
}

function moveTabDrag(event: PointerEvent): void {
  if (!tabDrag) return
  tabDrag.screenX = event.screenX
  tabDrag.screenY = event.screenY
  if (!tabDrag.moved &&
      Math.hypot(event.screenX - tabDrag.startX, event.screenY - tabDrag.startY) >= DRAG_THRESHOLD) {
    tabDrag.moved = true
  }
}

async function endTabDrag(event: PointerEvent): Promise<void> {
  const drag = tabDrag
  tabDrag = undefined
  draggingId.value = undefined
  const target = event.currentTarget
  if (target instanceof HTMLElement) {
    try {
      target.releasePointerCapture(event.pointerId)
    } catch {
      // 捕获已释放
    }
  }
  if (!drag?.moved) return
  suppressSelect = true
  const screenX = event.screenX || drag.screenX
  const screenY = event.screenY || drag.screenY
  const index = dropIndex(screenX, screenY, drag.id)
  if (index !== undefined) {
    await run({ type: 'move', id: drag.id, index })
    return
  }
  await run({ type: 'tearoff', id: drag.id, screenX, screenY })
}

function selectTab(tab: BrowserTab, event: MouseEvent): void {
  if ((event.target as HTMLElement | null)?.closest('.close-tab')) return
  if (suppressSelect) {
    suppressSelect = false
    return
  }
  void run({ type: 'select', id: tab.id })
}

/** 中键关闭（Chrome 式目标，架构 §3 商标交互）。 */
function onTabAuxClick(tab: BrowserTab, event: MouseEvent): void {
  if (event.button !== 1) return
  event.preventDefault()
  void run({ type: 'close', id: tab.id })
}

/** 双击标签栏空白处新建标签。 */
function onStripDoubleClick(event: MouseEvent): void {
  if ((event.target as HTMLElement | null)?.closest('.tab')) return
  // 标签栏空白双击在 Chrome 里是新建标签页，这里保持；窗口最大化只走标题栏其余空白处。
  event.stopPropagation()
  void addTab()
}

/** 方向键切换标签：切完把焦点留在标签栏，才能连续用方向键浏览（审计 P2）。 */
async function cycleTab(step: number): Promise<void> {
  const list = state.value?.tabs ?? []
  if (list.length < 2) return
  const current = list.findIndex((tab) => tab.id === active.value?.id)
  const next = (current + step + list.length) % list.length
  await run({ type: 'select', id: list[next].id })
  await nextTick()
  const strip = tabStrip.value
  const selected = strip?.querySelector<HTMLElement>('.tab.selected .tab-title')
  selected?.focus()
}

/** 双击标题栏最大化/还原：系统按钮只管点击，双击语义要自己转发（A5）。 */
function onTitlebarDoubleClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null
  // 标签、按钮上双击有自己的语义，不触发窗口最大化。
  if (target?.closest('.tab, button, input')) return
  void window.baoWindowControl.toggleMaximize()
}

function onTabStripKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  void cycleTab(event.key === 'ArrowRight' ? 1 : -1)
}

/** 指针被系统取消（触摸被抢走、手势中断等）：丢弃这次拖动，不提交排序或拖出。 */
function cancelTabDrag(event: PointerEvent): void {
  if (!tabDrag) return
  tabDrag = undefined
  draggingId.value = undefined
  suppressSelect = true
  const target = event.currentTarget
  if (target instanceof HTMLElement) {
    try {
      target.releasePointerCapture(event.pointerId)
    } catch {
      // 捕获已释放
    }
  }
}

/**
 * 释放点在标签栏内时给出目标序号；栏外（横或纵）返回 undefined，交给 tearoff 判定。
 *
 * 返回值符合 `move` IPC 的语义：**移除被拖项之后的最终索引**。指针落点本身数的是
 * 「含被拖项」的插槽，向右拖时会多算被拖项自己那一格，所以必须用 `finalDropIndex`
 * 换算一次（否则横向拖拽会偏一位）。
 */
function dropIndex(screenX: number, screenY: number, id: number): number | undefined {
  const strip = tabStrip.value
  if (!strip) return undefined
  const rect = strip.getBoundingClientRect()
  const clientX = screenX - window.screenX
  const clientY = screenY - window.screenY
  // 审计 P2：原实现只看 X，竖直拖出会被当成排序。两个轴都要在标签栏范围内。
  if (clientY < rect.top - 4 || clientY > rect.bottom + 4) return undefined
  if (clientX < rect.left - 4 || clientX > rect.right + 4) return undefined
  const items = [...strip.querySelectorAll<HTMLElement>('.tab')]
  const boxes = items.map((item) => {
    const box = item.getBoundingClientRect()
    return { left: box.left, width: box.width }
  })
  const slot = dropSlotIndex(boxes, clientX)
  // 渲染顺序与主进程 `tabs` 一致：用快照里的位置把插槽换算成移除后的最终索引。
  // 取不到（拖动途中标签被关掉）时按列表首位处理，越界由主进程的 `unknown-tab` 兜底。
  const from = state.value?.tabs.findIndex((tab) => tab.id === id) ?? -1
  return finalDropIndex(slot, from)
}

async function addTab(): Promise<void> {
  await run({ type: 'add' })
  await nextTick()
  addressField.value?.focus()
}

applyShellTheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')

onMounted(() => store.connect())
onBeforeUnmount(() => store.disconnect())
</script>

<template>
  <header class="shell" :style="shellStyle" :data-bookmark-bar="String(barVisible)">
    <div class="titlebar" @dblclick="onTitlebarDoubleClick">

      <div
        ref="tabStrip"
        class="tabs"
        aria-label="标签页"
        @dblclick="onStripDoubleClick"
        @keydown="onTabStripKeydown"
      >
        <div
          v-for="(tab, index) in state?.tabs"
          :key="tab.id"
          class="tab"
          :class="{ selected: tab.id === active?.id, crashed: tab.crashed, dragging: tab.id === draggingId, pinned: tab.pinned, muted: tab.muted, sleeping: tab.discarded, awake: tab.keepAwake }"
          @pointerdown="startTabDrag(tab, $event)"
          @pointermove="moveTabDrag"
          @pointerup="endTabDrag"
          @pointercancel="cancelTabDrag"
          @click="selectTab(tab, $event)"
          @auxclick="onTabAuxClick(tab, $event)"
          @contextmenu.prevent="run({ type: 'tab-menu', id: tab.id })"
        >
          <span v-if="index > 0" class="tab-separator" aria-hidden="true"></span>
          <button
            type="button"
            class="tab-title"
            :aria-pressed="tab.id === active?.id"
            :aria-busy="tab.loading"
            :title="tab.title"
          >
            <span v-if="tab.internal === 'settings'" class="site-icon settings-icon" aria-hidden="true"><ShellIcon name="gear" /></span>
            <span v-else class="glyph page site-icon" :class="{ loading: tab.loading }" aria-hidden="true"></span>
            <span v-if="!tab.pinned" class="tab-label">{{ tab.title }}</span>
            <span v-if="tab.keepAwake" class="awake-mark" aria-hidden="true" title="保持活跃（不自动休眠）"></span>
            <span v-if="tab.muted" class="muted-mark" aria-hidden="true">
              <svg viewBox="0 0 16 16">
                <path d="M8.6 2.6v10.8L5.3 10.5H2.6V5.5h2.7L8.6 2.6Z" fill="currentColor" />
                <path d="m10.6 6.2 3 3.6m0-3.6-3 3.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </svg>
            </span>
          </button>
          <button
            v-if="!tab.pinned"
            type="button"
            class="icon-button close-tab"
            :aria-label="`关闭标签页：${tab.title}`"
            @click="run({ type: 'close', id: tab.id })"
          ><span class="glyph cross" aria-hidden="true"></span></button>
        </div>
      </div>
      <div class="add-tab-slot">
        <button type="button" class="icon-button add-tab" aria-label="新建标签页" @click="addTab"><span class="glyph plus" aria-hidden="true"></span></button>
      </div>
    </div>

    <form class="toolbar" aria-label="导航工具栏" @submit.prevent="submitAddress">
      <button
        type="button"
        class="icon-button"
        title="后退"
        aria-label="后退"
        :disabled="!active?.canGoBack"
        @click="run({ type: 'back' })"
      ><span class="glyph arrow" aria-hidden="true"></span></button>
      <button
        type="button"
        class="icon-button"
        title="前进"
        aria-label="前进"
        :disabled="!active?.canGoForward"
        @click="run({ type: 'forward' })"
      ><span class="glyph arrow forward" aria-hidden="true"></span></button>
      <button
        type="button"
        class="icon-button"
        title="重新加载"
        aria-label="重新加载"
        :disabled="!active"
        @click="run({ type: 'reload' })"
      ><span class="glyph refresh" aria-hidden="true"></span></button>
      <div class="address-bar">
        <input
          ref="addressField"
          v-model="address"
          aria-label="地址栏"
          placeholder="输入网址或搜索"
          autocomplete="off"
          spellcheck="false"
          @input="addressDirty = true"
          @blur="syncAddressFromActive"
        >
        <!-- 星标在**地址栏内部右端**（Chromium 的 StarView 是 location bar 的 page action）：
             内部页不显示它（Chromium 对 chrome:// 页同样不显示；地址栏是弹性的，隐藏不会改工具栏宽度）。 -->
        <button
          v-if="bookmarkable"
          ref="bookmarkRoot"
          type="button"
          class="bookmark-star"
          :class="{ bookmarked: Boolean(bookmarked) }"
          :aria-expanded="quickOpen && quickView === 'bookmark-edit'"
          aria-haspopup="dialog"
          :aria-label="bookmarked ? '编辑收藏夹' : '收藏此页面'"
          :title="bookmarkTitle"
          @click="toggleBookmarkBubble"
        ><ShellIcon :name="bookmarked ? 'star-filled' : 'star'" /></button>
      </div>
      <!-- 收藏夹（Edge 那颗独立的按钮）：打开收藏夹树。它和星标是两件事——
           星标是"这一页收藏了没有"，这颗按钮是"我的收藏都在哪"。 -->
      <button
        ref="bookmarksRoot"
        type="button"
        class="icon-button bookmarks-button"
        :aria-expanded="quickOpen && quickView === 'bookmarks'"
        aria-haspopup="dialog"
        aria-label="收藏夹"
        title="收藏夹"
        @click="toggleQuick('bookmarks')"
      ><ShellIcon name="bookmarks" /></button>
      <!-- 引擎按钮：与齿轮同一尺寸/同一套 hover，图标表示当前引擎，点击展开飞窗。
           内部页禁用（灰）而不是隐藏——隐藏会让工具栏宽度随标签来回变。 -->
      <button
        ref="engineRoot"
        type="button"
        class="icon-button engine-button"
        :class="active ? `engine-${active.engine}` : ''"
        :disabled="!engineSwitchable"
        :aria-expanded="enginePanelOpen"
        aria-haspopup="dialog"
        :aria-label="engineSwitchable ? '引擎设置' : '新标签页没有可切换的站点引擎'"
        :title="engineTitle"
        @click="toggleEnginePanel"
      >
        <span class="engine-mark" :class="active?.pinnedEngine && active.pinnedEngine !== active.engine ? 'overridden' : (active?.engine ?? 'ppapi')" aria-hidden="true">
          <ShellIcon :name="active?.engine === 'ruffle' ? 'ruffle' : 'flash'" />
        </span>
      </button>
      <button
        ref="gearRoot"
        type="button"
        class="icon-button gear-button"
        :aria-expanded="quickOpen && quickView === 'settings'"
        aria-haspopup="dialog"
        aria-label="快捷设置"
        title="快捷设置"
        @click="toggleQuick('settings')"
      ><ShellIcon name="gear" /></button>
    </form>
    <!--
      收藏夹横条（工具栏下面那第三行）：内容 = 「收藏夹栏」根下的一层。
      右键是原生菜单（`bookmark-bar-menu`）：横条自己的显示开关必须有除了设置页之外的入口。
      空的时候照 Edge 留一行提示条，而不是像 Chrome 那样整条消失（产品裁决见
      docs/reports/2026-11-26-bookmarks-store.md §1）。
    -->
    <div
      v-if="barVisible"
      ref="barEl"
      class="bookmark-bar"
      role="toolbar"
      aria-label="收藏夹栏"
      @contextmenu.prevent="run({ type: 'bookmark-bar-menu' })"
    >
      <template v-if="barItems.length > 0">
        <button
          v-for="(item, index) in barItems"
          :key="item.id"
          type="button"
          class="bar-item"
          :class="{ folder: item.kind === 'folder', clipped: index >= barClippedFrom }"
          :title="item.kind === 'folder' ? `打开文件夹：${item.title}` : (item.url ?? item.title)"
          :aria-hidden="index >= barClippedFrom"
          :tabindex="index >= barClippedFrom ? -1 : 0"
          @click="item.kind === 'folder' ? toggleBarFolder(item, $event) : openBarItem(item)"
        >
          <span class="bar-icon" aria-hidden="true"><ShellIcon :name="item.kind === 'folder' ? 'folder' : 'page'" /></span>
          <span class="bar-label">{{ item.title }}</span>
        </button>
        <!-- 放不下的项：这里不自己画菜单，直接打开收藏夹面板（那里是完整的树）。 -->
        <button
          v-if="barClippedFrom < barItems.length"
          type="button"
          class="bar-item bar-overflow"
          title="其余收藏夹"
          aria-label="其余收藏夹"
          @click="openQuick('bookmarks')"
        ><span class="bar-more" aria-hidden="true">»</span></button>
      </template>
      <p v-else class="bar-hint">
        <span>把常用网址收藏到这里，随时一键打开。</span>
        <button type="button" class="bar-hint-action" @click="openQuick('bookmarks')">立即管理收藏夹</button>
      </p>
    </div>
    <!--
      崩溃恢复气泡（Chrome 的「恢复页面」警示对话框）不在这里画：它由叠加层视图显示，
      锚在工具栏最右那颗按钮下方——外壳 DOM 会被页面 WebContentsView 压住，气泡伸进页面区
      就看不见。见 docs/reports/2026-11-26-session-bubble.md。
    -->
  </header>  <p class="sr-only" role="status">{{ toast }}</p>
  <main v-if="active?.error" class="page-error" aria-labelledby="page-error-title">
    <div>
      <ShellIcon name="error" />
      <h1 id="page-error-title">{{ active.error }}</h1>
      <button type="button" class="page-retry" @click="run({ type: 'reload' })">重试</button>
    </div>
  </main>
</template>

<style>
:root {
  font: var(--size-body)/1.4 var(--shell-font);
  color: var(--text-primary);
  background: var(--surface-page);
}

* { box-sizing: border-box; }
body { margin: 0; }
button, input { font: inherit; color: inherit; }
button { border: 0; background: transparent; }
button:not(:disabled) { cursor: pointer; }
button:focus-visible { outline: 2px solid var(--stroke-focus-ring); outline-offset: 1px; }

.titlebar {
  display: flex;
  align-items: center;
  height: var(--tab-bar-height);
  padding-inline: 0 calc(100vw - env(titlebar-area-width, calc(100vw - 144px)) + 36px);
  background: var(--surface-window);
  -webkit-app-region: drag;
  user-select: none;
}

.tabs {
  display: flex;
  align-self: end;
  padding-inline: var(--tab-foot);
  scroll-padding-inline: var(--tab-foot);
  min-width: 0;
  width: max-content;
  overflow-x: auto;
  scrollbar-width: none;
  -webkit-app-region: no-drag;
}

.tab {
  position: relative;
  isolation: isolate;
  display: flex;
  align-items: center;
  flex: 0 1 180px;
  min-width: 88px;
  width: 180px;
  height: var(--tab-height);
  padding-inline-end: var(--space-xs);
  border: var(--shell-stroke) solid transparent;
  border-bottom: 0;
  border-radius: var(--tab-radius) var(--tab-radius) 0 0;
  color: var(--text-secondary);
  font-size: var(--size-caption);
}

.tab:hover { background: var(--surface-hover); }

/* 标签之间的小竖线：选中/悬停时让位（Edge、Chrome 同款处理） */
.tab-separator {
  position: absolute;
  left: -0.5px;
  top: 50%;
  translate: 0 -50%;
  width: 1px;
  height: 16px;
  /* 比 --stroke-divider（Fluent stroke2）深一档：直接用它几乎看不见 */
  background: color-mix(in srgb, var(--text-primary) 30%, transparent);
  pointer-events: none;
}
.tab.selected .tab-separator,
.tab:hover .tab-separator,
.tab.selected + .tab .tab-separator,
.tab:hover + .tab .tab-separator { opacity: 0; }
.tab.dragging { opacity: .6; }
.tab.selected {
  z-index: 1;
  color: inherit;
  background: transparent;
}

.tab.selected::before,
.tab.selected::after {
  /* One contour for the sides and feet keeps the open bottom free of seams. */
  --inset: 0px;
  --side: calc(var(--tab-foot) + var(--inset));
  --foot-radius: calc(var(--tab-foot) + var(--inset));
  --top-radius: calc(var(--tab-radius) - var(--inset));
  --top-join: calc(var(--tab-foot) + var(--tab-radius));

  position: absolute;
  z-index: -1;
  inset: calc(-1 * var(--shell-stroke)) calc(-1 * (var(--tab-foot) + var(--shell-stroke))) 0;
  pointer-events: none;
  background: var(--tab-outline, var(--stroke-divider));
  content: "";
  clip-path: shape(
    from 0 calc(100% + var(--inset)),
    arc to var(--side) calc(100% - var(--tab-foot)) of var(--foot-radius) ccw,
    line to var(--side) var(--tab-radius),
    arc to var(--top-join) var(--inset) of var(--top-radius) cw,
    hline to calc(100% - var(--top-join)),
    arc to calc(100% - var(--side)) var(--tab-radius) of var(--top-radius) cw,
    line to calc(100% - var(--side)) calc(100% - var(--tab-foot)),
    arc to 100% calc(100% + var(--inset)) of var(--foot-radius) ccw,
    close
  );
}

.tab.selected::after {
  --inset: var(--shell-stroke);
  background: var(--surface-toolbar);
}

.tab-title {
  display: flex;
  align-items: center;
  gap: var(--space-s);
  flex: 1;
  min-width: 0;
  height: 100%;
  text-align: start;
  padding: 0 var(--space-xs) 0 var(--space-m);
  border-radius: var(--tab-radius) 0 0 0;
}

.tab.selected .tab-title { font-weight: 600; }
.tab-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.site-icon { color: var(--text-secondary); }
.settings-icon { display: inline-flex; align-items: center; }
.settings-icon .shell-icon { width: 14px; height: 14px; }
.tab.selected .site-icon { color: var(--brand-stroke); }
.tab.crashed .site-icon { color: var(--text-error); }
.glyph.page.loading::before { inset: 2px; border-radius: 50%; border-inline-end-color: transparent; }
.glyph.page.loading::after { content: none; }

@media (prefers-reduced-motion: no-preference) {
  .tab, .icon-button { transition: background-color var(--motion-fast) ease; }
  .address-bar { transition: border-color var(--motion-normal) ease; }
}

.icon-button {
  display: grid;
  place-items: center;
  flex: none;
  width: 32px;
  height: 32px;
  padding: 0;
  border-radius: var(--button-radius);
  color: var(--text-secondary);
  -webkit-app-region: no-drag;
}

.icon-button:hover:not(:disabled) { color: inherit; background: var(--surface-hover); }
.icon-button:disabled { color: var(--text-disabled); }
/* 齿轮：打开时保持按下色，与飞窗形成「同一块」的视觉延续。 */
.gear-button { margin-inline-start: 2px; }
.gear-button[aria-expanded='true'] { color: var(--text-primary); background: var(--surface-pressed); }
.close-tab { width: 22px; height: 22px; opacity: 0; }

/* 固定标签（架构 §3「标签操作」）：只留站点图标，排在最左，没有关闭按钮。 */
.tab.pinned { flex: 0 0 auto; min-width: 0; width: 44px; }
.tab.pinned .tab-title { padding: 0; justify-content: center; border-radius: calc(var(--tab-radius) - var(--inset)); }
.tab.pinned .muted-mark { position: absolute; right: 7px; bottom: 5px; }

/* 静音标记：与站点图标同色的喇叭加斜杠。 */
.muted-mark { display: inline-flex; align-items: center; color: var(--text-secondary); }
/* 保持活跃标记：一个小圆点，不抢标题长度。 */
.awake-mark { width: 6px; height: 6px; border-radius: 50%; background: var(--engine-accent); opacity: .75; flex: none; }
/* 已休眠：标题弱化，点击即唤醒。 */
.tab.sleeping .tab-label { opacity: .55; }
.muted-mark svg { width: 12px; height: 12px; }
.tab.selected .muted-mark { color: var(--brand-stroke); }
.tab:hover .close-tab,
.tab.selected .close-tab,
.tab:focus-within .close-tab { opacity: 1; }
@media (forced-colors: active) { .close-tab { opacity: 1; } }
.tab:not(.selected) .close-tab:hover {
  color: var(--text-primary);
  background: var(--surface-pressed);
}

.add-tab-slot {
  display: grid;
  align-items: center;
  align-self: end;
  flex: none;
  height: var(--tab-height);
  /*
   * Chromium 142 的 NTB 同样是 28px，位置由 12px 标签底角与 6px strip padding
   * 共同计算。这里的标签脚更小，回收半个脚宽即可；完整回收会让图标贴住轮廓。
   */
  margin-inline-start: -2px;
  border-block-start: var(--shell-stroke) solid transparent;
}
.add-tab { width: var(--new-tab-button-size); height: var(--new-tab-button-size); }

.glyph {
  position: relative;
  display: inline-block;
  flex: none;
  width: 16px;
  height: 16px;
}
.glyph::before, .glyph::after { position: absolute; content: ""; }
.glyph.plus::before, .glyph.cross::before { inset: 7px 2px; background: currentColor; }
.glyph.plus::after, .glyph.cross::after { inset: 2px 7px; background: currentColor; }
.glyph.cross { width: 14px; height: 14px; transform: rotate(45deg); }
.glyph.cross::before { inset: 6px 2px; }
.glyph.cross::after { inset: 2px 6px; }
.glyph.arrow::before { top: 7px; left: 2px; width: 12px; border-top: 1.5px solid; }
.glyph.arrow::after {
  top: 4px;
  left: 2px;
  width: 7px;
  height: 7px;
  border-top: 1.5px solid;
  border-left: 1.5px solid;
  transform: rotate(-45deg);
}
.glyph.forward { transform: rotate(180deg); }
.glyph.page::before { inset: 2px 3px; border: 1.5px solid; border-radius: 2px; }
.glyph.page::after { inset: 6px 5px auto; border-top: 1px solid; }
.glyph.refresh::before { inset: 2px; border: 1.5px solid; border-right-color: transparent; border-radius: 50%; }
.glyph.refresh::after { top: 2px; right: 1px; width: 5px; height: 5px; border-right: 1.5px solid; border-bottom: 1.5px solid; }

.toolbar {
  display: flex;
  align-items: center;
  gap: var(--nav-gap);
  height: var(--toolbar-height);
  padding: 0 var(--space-s);
  background: var(--surface-toolbar);
  border-bottom: var(--shell-stroke) solid var(--stroke-divider);
}

/*
 * 收藏夹横条（工具栏下面那第三行）。高度由 `--bookmark-bar-height` 统一，
 * 主进程按同一个常量（`BOOKMARK_BAR_HEIGHT`）让页面视图下移。
 *
 * 放不下的项用 `visibility: hidden` 藏：**布局必须保留**，否则"排出来量一次、藏掉超出的"
 * 那套测量会在第二次收敛时把已藏的项当成宽度 0（见 `measureBar`）。
 */
.bookmark-bar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 2px;
  height: var(--bookmark-bar-height);
  padding: 0 var(--space-s);
  background: var(--surface-toolbar);
  border-bottom: var(--shell-stroke) solid var(--stroke-divider);
  overflow: hidden;
}
.bar-item {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  flex: none;
  max-width: 200px;
  height: 24px;
  padding: 0 var(--space-s);
  border-radius: 5px;
  font-size: 12px;
  color: var(--text-primary);
  -webkit-app-region: no-drag;
}
.bar-item:hover { background: var(--surface-hover); }
.bar-item:focus-visible { outline: 2px solid var(--stroke-focus-ring); outline-offset: -1px; }
.bar-item.clipped { visibility: hidden; }
.bar-icon { display: grid; place-items: center; flex: none; color: var(--text-secondary); }
.bar-icon .shell-icon { width: 13px; height: 13px; }
.bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 「其余收藏」：绝对定位到右端，不参与 flex 排布——它的宽度由测量预留（`BAR_OVERFLOW_RESERVE`）。 */
.bar-overflow {
  position: absolute;
  inset-inline-end: var(--space-xs);
  top: 4px;
  justify-content: center;
  width: 24px;
  padding: 0;
  color: var(--text-secondary);
}
.bar-more { font-size: 14px; line-height: 1; }
/* 空态（Edge 的提示条）：一行灰字 + 一个动作，不占额外高度。 */
.bar-hint {
  display: flex;
  align-items: center;
  gap: var(--space-s);
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
}
.bar-hint-action { padding: 0 4px; border-radius: 4px; font-size: 12px; color: var(--accent); }
.bar-hint-action:hover { text-decoration: underline; }
/*
 * 横条出现时工具栏**不再画自己的下边框**：只有整条 chrome 的最下面一道线，否则
 * 工具栏与横条之间会多出一条分隔线（Edge 实测只有横条底部那条）。宽度保留 1px，
 * 工具栏高度不受影响。
 */
.shell[data-bookmark-bar='true'] .toolbar { border-bottom-color: transparent; }

.address-bar {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  height: 32px;
  margin-inline-start: var(--space-xs);
  padding: 0 var(--space-m);
  border: var(--shell-stroke) solid var(--stroke-control);
  border-radius: var(--address-radius);
  background: var(--surface-toolbar);
}
.address-bar:focus-within {
  background: var(--surface-toolbar);
  border-color: var(--brand-stroke);
  box-shadow: inset 0 0 0 1px var(--brand-stroke);
}
.address-bar input { flex: 1; width: 0; padding: 0; border: 0; outline: none; background: transparent; }
.address-bar input::placeholder { color: var(--text-secondary); opacity: 1; }
/* 收藏夹星标（地址栏内部右端）：24×24，不做成工具栏图标按钮——它在圆角地址栏里面，
   尺寸与内边距跟着输入框走（Chromium 的 StarView 同样在 location bar 内）。 */
.bookmark-star {
  display: grid;
  place-items: center;
  flex: none;
  width: 24px;
  height: 24px;
  margin-inline-end: -6px;
  padding: 0;
  border-radius: 5px;
  color: var(--text-secondary);
  -webkit-app-region: no-drag;
}
.bookmark-star:hover { color: var(--text-primary); background: var(--surface-hover); }
.bookmark-star[aria-expanded='true'] { color: var(--text-primary); background: var(--surface-pressed); }
/* 已收藏：实心 + 强调色（Chromium 的 kStarActiveChromeRefreshIcon 同一语义）。 */
.bookmark-star.bookmarked, .bookmark-star.bookmarked:hover { color: var(--accent); }
.bookmark-star:focus-visible { outline: 2px solid var(--stroke-focus-ring); outline-offset: -1px; }
.bookmark-star .shell-icon { width: 15px; height: 15px; }
/* 收藏夹按钮：与引擎/齿轮同一套 32×32 图标按钮，排在地址栏右侧第一个。 */
.bookmarks-button { margin-inline-start: 2px; }
.bookmarks-button[aria-expanded='true'] { color: var(--text-primary); background: var(--surface-pressed); }
/* 引擎按钮：与齿轮同一个 `.icon-button` 尺寸（32×32），图标表示当前引擎。
   之前是"胶囊（内联开关）+ 下箭头"两块拼起来的，跟其它图标按钮不同尺寸/不同形状。 */
.engine-button { margin-inline-start: 2px; }
.engine-button[aria-expanded='true'] { color: var(--text-primary); background: var(--surface-pressed); }
.engine-button:disabled { color: var(--text-disabled); cursor: default; }
.engine-mark { width: 16px; height: 16px; flex: none; display: grid; place-items: center; }
.engine-mark .shell-icon { width: 16px; height: 16px; }
.engine-mark.ppapi { color: var(--engine-flash); }
.engine-mark.ruffle { color: var(--engine-ruffle); }
.engine-mark.overridden { color: var(--engine-override); }
/* 禁用态整颗变灰：图标颜色必须一起压掉，否则"灰按钮 + 彩色图标"看起来还能点。 */
.engine-button:disabled .engine-mark { color: var(--text-disabled); }
.sr-only { position: absolute; width: 1px; height: 1px; margin: 0; overflow: hidden; clip-path: inset(50%); }
.page-error { min-height: calc(100vh - var(--tab-bar-height) - var(--toolbar-height)); display: grid; place-items: center; text-align: center; padding: 24px; }
/* 横条也占高度：错误页要让开那一行，否则内容会被顶得偏下（页面视图由主进程同样让位）。 */
.shell[data-bookmark-bar='true'] ~ .page-error {
  min-height: calc(100vh - var(--tab-bar-height) - var(--toolbar-height) - var(--bookmark-bar-height));
}
.page-error .shell-icon { width: 24px; height: 24px; color: var(--text-error); }
.page-error h1 { margin: 6px 0 10px; font-size: 16px; }
.page-retry { padding: 4px 12px; border: 1px solid var(--stroke-control); border-radius: 7px; color: var(--engine-accent); background: var(--engine-selection); }
.page-retry:hover { background: var(--surface-hover); }

@media (forced-colors: active) {
  .tab.selected { --tab-outline: Highlight; }
  .tab.selected::before, .tab.selected::after { forced-color-adjust: none; }
  .tab.selected::after { background: Canvas; }
  .address-bar:focus-within { outline: 2px solid Highlight; outline-offset: -2px; }
}
</style>
