/**
 * 「改动 → 该跑哪些冒烟用例」的映射表。
 *
 * 为什么需要：全量隐藏冒烟 ~80 s、前台 ~165 s，而日常改动通常只碰一两个模块。
 * 实测并行度已经不是杠杆（4 并发 79–88 s，8 并发 84 s——瓶颈是每个用例都要冷启动
 * 一个 Electron 应用，不是 CPU），所以省时间的唯一方向是**少跑**。
 *
 * 两条硬规则：
 * 1. **拿不准就全量**：命中不了任何规则、或路径属于"改了就影响一切"的那几类，直接返回全部用例。
 * 2. **宁可多跑**：规则命中时给的是"可能受影响的集合"，不是精确依赖图。少跑一条漏掉的用例
 *    比多跑三条更贵。
 *
 * 这张表是**手写的近似依赖**，不是自动推导的：自动推导（扫 require / 启动引用图）在
 * Electron + IPC + 渲染层三张网里并不可靠，而手写表能被审阅、也能和产品结构一起演进。
 * 结构变了就改这里——它是开发期提速工具，不是正确性保证。
 */

/** `null` 代表"必须全量"。 */
const ALL = null

/** 用例名（`tests/smoke/<name>.test.cjs`）。 */
const RULES = [
  {
    // 入口 / 状态投影 / 桥面 / 构建配置：改了它们，任何用例都可能受影响。
    match: [
      /^src\/main\/index\.ts$/,
      /^src\/main\/automation\.ts$/,
      /^src\/shared\/browser\.ts$/,
      /^src\/shared\/runtime\.ts$/,
      /^src\/preload\/index\.ts$/,
      /^src\/renderer\/main\.ts$/,
      /^src\/renderer\/index\.html$/,
      /^src\/renderer\/env\.d\.ts$/,
      /^electron\.vite\.config\.ts$/,
      /^package\.json$/,
      /^tsconfig[^/]*\.json$/,
      /^build\//,
      // 测试基础设施自身（调度器/映射表）不改变产品行为，不算"影响用例"。
      /^scripts\/(?!test\.cjs$|test-map\.cjs$|windows-test-spawn\.cjs$|smoke-file\.cjs$)/
    ],
    tests: ALL
  },
  {
    // 窗口控制器：标签、工具栏、快捷键、弹窗、浮层、自愈全在这里接线。
    match: [/^src\/main\/browser-window\.ts$/],
    tests: ALL
  },
  {
    // 叠加层（飞窗）：视图/角色/预热/度量/几何/宿主文档。
    match: [
      /^src\/main\/shell-overlays\.ts$/,
      /^src\/main\/overlay-metrics\.ts$/,
      /^src\/shared\/overlay\.ts$/,
      /^src\/shared\/overlay-geometry\.ts$/,
      /^src\/renderer\/overlay-layout\.ts$/,
      /^src\/renderer\/OverlayHost\.vue$/,
      /^src\/renderer\/QuickSettings\.vue$/,
      /^src\/renderer\/BookmarksPanel\.vue$/,
      /^src\/renderer\/BookmarkEditPanel\.vue$/,
      /^src\/renderer\/BookmarkEditorPanel\.vue$/,
      /^src\/renderer\/ShellOverlay\.vue$/
    ],
    tests: ['overlay-prewarm-hidden', 'overlay-prewarm-policy', 'quick-settings', 'bookmarks', 'bookmark-bar',
      'favorites', 'theme', 'engine', 'shell-crash-heal']
  },
  {
    // 外壳 UI 主体（标签栏/工具栏/地址栏/飞窗入口）。
    match: [/^src\/renderer\/App\.vue$/, /^src\/renderer\/ShellIcon\.vue$/],
    tests: ['tabs', 'tab-ops', 'tearoff', 'quick-settings', 'bookmarks', 'bookmark-bar', 'favorites', 'favicon', 'engine',
      'theme', 'titlebar', 'newtab', 'internal-page', 'input', 'overlay-prewarm-hidden',
      'overlay-prewarm-policy']
  },
  {
    // 页面视图生命周期 + 标签拖拽。
    match: [/^src\/main\/page-views\.ts$/, /^src\/renderer\/tab-drag\.ts$/],
    tests: ['tabs', 'tab-ops', 'tab-discard', 'tearoff', 'input']
  },
  {
    // 会话 / 存储。
    match: [/^src\/main\/storage\.ts$/, /^src\/main\/sessions\.ts$/, /^src\/shared\/session\.ts$/,
      // 业务库（收藏夹表也在这里）与收藏夹的纯逻辑。
      /^src\/main\/db\/store\.ts$/, /^src\/shared\/bookmarks\.ts$/],
    tests: ['session-restore', 'data-cleanup', 'isolation', 'internal-page', 'bookmarks']
  },
  {
    // 设置模型与内部设置页。
    match: [
      /^src\/shared\/settings\.ts$/,
      /^src\/renderer\/SettingsPage\.vue$/,
      /^src\/renderer\/settings\.ts$/,
      /^src\/preload\/internal\.ts$/
    ],
    tests: ['internal-page', 'data-cleanup', 'theme', 'tab-discard', 'quick-settings', 'newtab']
  },
  {
    // 引擎选择与站点规则。
    match: [/^src\/main\/engine-rules\.ts$/, /^src\/shared\/engine\.ts$/, /^src\/shared\/site\.ts$/],
    tests: ['engine', 'engine-switch', 'engine-rules', 'tab-ops', 'link-target', 'tabs']
  },
  {
    // 观测量（心跳 / 浮层长任务）：只在诊断文件里体现，但用例是唯一证据。
    match: [
      /^src\/main\/heartbeat\.ts$/,
      /^src\/shared\/heartbeat\.ts$/,
      /^src\/main\/shell-overlays\.ts$/,
      /^src\/renderer\/OverlayHost\.vue$/
    ],
    tests: ['heartbeat', 'quick-settings', 'overlay-prewarm-policy']
  },
  {
    // 引擎网络 broker（跨域读）。
    match: [/^src\/main\/net-broker\.ts$/, /^src\/main\/broker-token\.ts$/, /^src\/main\/crossdomain\.ts$/],
    tests: ['engine-broker', 'ruffle-cors']
  },
  {
    // Ruffle 注入与协议。
    match: [/^src\/main\/ruffle\.ts$/],
    tests: ['ruffle-input', 'ruffle-cors', 'engine', 'tab-duplicate-ruffle']
  },
  {
    // 原生 Flash 插件（发现/扫描/PE 解析/注册）。
    match: [
      /^src\/main\/flash-[^/]*\.ts$/,
      /^src\/main\/pe-[^/]*\.ts$/,
      /^src\/main\/plugin-file\.ts$/,
      /^src\/main\/plugins\.ts$/
    ],
    tests: ['flash', 'plugin-input', 'startup']
  },
  {
    // 内部页 / 新标签页。
    match: [
      /^src\/main\/internal-pages\.ts$/,
      /^src\/shared\/ntp\.ts$/,
      /^src\/renderer\/newtab\.[^/]+$/,
      /^src\/renderer\/NewTabPage\.vue$/
    ],
    tests: ['internal-page', 'newtab']
  },
  {
    /*
     * 收藏夹管理页（`bao://favorites`）。
     *
     * 它同时碰三样东西：内部页接线（internal-pages / preload / vite 入口）、收藏夹数据
     * （shared/favorites 的窄合同）、以及收藏夹本体的展示口径，所以三条用例都跑。
     */
    match: [
      /^src\/renderer\/FavoritesPage\.vue$/,
      /^src\/renderer\/favorites\.[^/]+$/,
      /^src\/renderer\/favorites-env\.d\.ts$/,
      /^src\/shared\/favorites\.ts$/,
      /^src\/shared\/bookmark-import\.ts$/
    ],
    tests: ['favorites', 'bookmarks', 'bookmark-bar', 'internal-page', 'data-cleanup']
  },
  {
    // 窗口外观：主题、标题栏、窗口按钮。
    match: [
      /^src\/main\/window-control\.ts$/,
      /^src\/shared\/shell-theme\.ts$/,
      /^src\/renderer\/theme\.ts$/,
      /^src\/renderer\/theme-clock\.ts$/,
      /^src\/renderer\/ThemeSwitch[^/]*\.vue$/
    ],
    tests: ['theme', 'titlebar']
  },
  {
    // 样式：配色/间距类断言分布在这几个用例里。
    match: [/^src\/renderer\/[^/]*\.css$/],
    tests: ['theme', 'titlebar', 'newtab', 'internal-page', 'quick-settings', 'bookmarks']
  },
  {
    // 收藏夹导入的样本文件：只有 `favorites` 用例读它们。
    match: [/^tests\/smoke\/fixtures\/bookmarks-/],
    tests: ['favorites']
  },
  {
    // 弹窗与页面 preload。
    match: [/^src\/main\/popup-chrome\.ts$/, /^src\/preload\/popup-chrome\.ts$/],
    tests: ['popup']
  },
  {
    match: [/^src\/preload\/page\.ts$/],
    tests: ['isolation', 'permissions', 'link-target', 'popup']
  },
  {
    // 活动租约（保持活跃 / 休眠豁免 / 拖出后保留）。
    match: [/^src\/main\/activity-lease\.ts$/],
    tests: ['tab-discard', 'tearoff']
  },
  {
    // Capability 合同与校验器（A1-a）：运行时还没有导入方，但它将是标签动作的统一入口，
    // 一旦接线就落在 browser-window（已映射为全量），所以这里只跑受它约束的两条行为用例。
    match: [/^src\/shared\/capability\.ts$/, /^src\/main\/capability-contract\.ts$/],
    tests: ['tab-ops', 'tab-discard']
  },
  {
    // 地址/文档身份判断：地址栏导航、外壳页识别（同文档）、内部页、链接目标分配都吃它。
    match: [/^src\/main\/address\.ts$/],
    tests: ['tabs', 'tab-ops', 'internal-page', 'newtab', 'link-target', 'popup', 'overlay-prewarm-policy']
  },
  {
    // Flash 内容判定：休眠硬门禁与插件可用性两条线。
    match: [/^src\/main\/flash-probe\.ts$/],
    tests: ['tab-discard', 'flash']
  },
  {
    // 标签身份与代际（A1-b）：休眠/唤醒、引擎切换、拖出移交、会话恢复都会推进代际。
    match: [/^src\/main\/tab-registry\.ts$/],
    tests: ['tab-discard', 'tearoff', 'engine-switch', 'session-restore', 'tab-ops']
  },
  {
    // 引用来源头。
    match: [/^src\/shared\/referer\.ts$/],
    tests: ['link-target']
  }
]

/** 只影响文档/记忆/工具产物的路径：改了它们不需要跑冒烟。 */
const IGNORED = [
  /^docs\//, /^\.workbuddy\//, /^\.cache\//, /^\.runtime\//, /^out\//,
  /^[^/]*\.md$/, /^tests\/smoke\/_[^/]*$/,
  // 用例自身：由下面的 SELF 规则按文件名处理。
  /^tests\/smoke\/[^/]+\.test\.cjs$/
]

const SELF = /^tests\/smoke\/([^/]+)\.test\.cjs$/

/**
 * 把改动路径映射成该跑的用例名。
 *
 * @param {string[]} changedPaths 相对 `app/` 的路径（正斜杠）
 * @returns {{ tests: string[] | null, reason: string }} `tests === null` 表示必须全量；
 *   `reason` 给命令行打印用（命中规则 / 全量 / 无需跑）。
 */
function selectTests(changedPaths) {
  const picked = new Set()
  const unmatched = []

  for (const path of changedPaths) {
    const normalized = path.replace(/\\/g, '/')
    const self = SELF.exec(normalized)
    if (self) {
      // 改了哪个用例就跑哪个。
      picked.add(self[1])
      continue
    }
    if (IGNORED.some((pattern) => pattern.test(normalized))) continue

    let hit = false
    for (const rule of RULES) {
      if (!rule.match.some((pattern) => pattern.test(normalized))) continue
      hit = true
      if (rule.tests === ALL) return { tests: null, reason: `${normalized} 影响全局` }
      for (const name of rule.tests) picked.add(name)
    }
    if (!hit) unmatched.push(normalized)
  }

  if (unmatched.length > 0) {
    // 落在 `src/` 里却没写规则的（新模块）：宁可全量，也别静默漏测。
    const risky = unmatched.filter((path) => path.startsWith('src/'))
    if (risky.length > 0) return { tests: null, reason: `${risky[0]} 没有映射规则` }
  }

  return { tests: [...picked].sort(), reason: picked.size ? '按映射表' : '改动不需要跑冒烟' }
}

module.exports = { selectTests, RULES, IGNORED }
