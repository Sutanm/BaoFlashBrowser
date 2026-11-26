# M2 增量：崩溃恢复（用户确认）与 schema v2

> **部分条款已被推翻（2026-11-26）**：§2 里「提示形态 = 外壳顶部 infobar」这条不再有效，
> 提示已改为**叠加层警示气泡**（与 Chromium `SessionCrashedBubbleView` 对齐），
> 见 [2026-11-26 崩溃恢复气泡](2026-11-26-session-bubble.md)。本文其余部分（退出标记三态、
> 载荷校验、写盘挂起、恢复策略）仍然有效。

2026-11-24 · 对应 M2 剩余范围「会话恢复」（[m2-beta §3](../kickoff/m2-beta.md#3-剩余范围)），
以及[架构 §7 生命周期](../agent-automation-architecture.md#7-标签生命周期与活动租约)。
代码：`app/src/shared/session.ts`、`app/src/main/db/store.ts`（schema v2）、
`app/src/main/storage.ts`、`app/src/main/browser-window.ts`、`app/src/main/index.ts`、
`app/src/renderer/App.vue`（提示条）。

## 0. 决策修正（同日，第一版被推翻）

第一版实现成了「**正常退出后重启自动恢复**上次会话」。产品侧裁决（2026-11-24）不采纳：

> 正常退出后重启**不**恢复；只有异常退出才考虑恢复，且必须**由用户选择**才恢复。

这正是 Chrome/Edge 的默认契约（`On startup: Open the New Tab page` + 崩溃后的「恢复页面」气泡）。
第一版的问题有两个：打扰用户（每次关闭再打开都回到一堆旧标签），以及把「恢复」变成了不可拒绝的
默认行为。修正后的行为：

| 场景 | 行为 |
| --- | --- |
| 正常退出（`before-quit` 能跑到）→ 重启 | 只有一个新标签页，**没有**任何提示 |
| 异常退出（硬杀/崩溃，标记停在 `crash`）→ 重启 | 只有新标签页 + 外壳顶部提示条「上次未正常退出，可以恢复 N 个标签页」，**不动会话** |
| 用户点「恢复标签页」 | 才把上次的标签建出来（含置顶/引擎/静音/保持活跃），活动标签立即加载、其余休眠 |
| 用户点「忽略」 | 丢弃该会话，下次启动不再提示 |
| 命令行显式带网址 | 不提示（用户当下要打开的东西优先） |

## 1. 本增量做什么 / 不做什么

| 做 | 不做（明确留后） |
| --- | --- |
| 崩溃检测：`meta` 表 `session.last-exit` 启动时武装、正常退出写 `clean` | 崩溃弹窗/系统通知、崩溃次数统计 |
| 崩溃恢复提示条（外壳内 infobar，页面视图让开其高度） | 「启动时：继续上次会话」作为可配置策略（设置项） |
| 用户确认后恢复标签：地址/标题/引擎/置顶/静音/保持活跃/活动标签 | 滚动位置、表单内容、导航栈（前进/后退） |
| 多窗口会话并回当前窗口恢复（上限 10 窗口 / 200 标签） | 窗口布局/位置/尺寸的恢复 |
| 后台标签以 `discarded` 状态恢复，切回才建渲染进程 | 标签分组、书签/历史联动 |
| 会话写入在用户回答前**挂起**（否则提示还在、内容已被覆盖） | 会话数据的手动清理 UI（属 M2「存储清理」项） |

## 2. 决定

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 存哪里 | 业务库 SQLite，`session` 表**单行 JSON 载荷**（schema v2） | 会话是整体替换的可重建数据；单行写入原子，恢复只需一次读；复用已有库、WAL 与迁移备份 |
| 退出方式怎么记 | `meta` 表 `session.last-exit`（`clean` / `crash`），与会话载荷**分开** | 武装发生在启动早期、载荷还没准备好；两者生命周期不同，混在一起每次武装都要重写整份会话 |
| 检测方式 | 启动时先写 `crash`（武装），`before-quit` 写 `clean`；硬杀来不及写 | 进程被杀时唯一还能留下信息的时刻就是上一次启动 |
| 恢复时机 | **只有**用户点「恢复标签页」 | 产品裁决：恢复必须是用户的显式选择 |
| 提示形态 | 外壳顶部 infobar（`INFOBAR_HEIGHT`），页面视图下移 | 外壳 DOM 被页面 WebContentsView 覆盖，弹窗式浮层会看不见；infobar 在 chrome 区天然可见，且 Playwright 可断言 |
| 写入挂起 | 提示未回答前 `sessionHeld` 禁止写盘 | 否则启动后第一次 `publish()` 的 800 ms 节流写会用空白新标签页覆盖待恢复会话 |
| 恢复的加载策略 | 活动标签立即加载，其余 `discarded` | 恢复 N 个标签的成本≈1 个；不一次拉起一堆渲染进程 |
| 载荷校验 | `shared/session.ts` 纯函数，任何不合格的标签整条丢弃 | 载荷来自磁盘不可信；坏版本/坏结构/截断必须进内存前处理，且可脱机单测 |
| 版本不兼容 | `SESSION_VERSION` 不匹配即整份丢弃 | 会话是舒适度数据，不值得为它写迁移器（设置才值得） |
| 「保持活跃」 | 恢复时重建同一条 `user` 租约（`keep-awake-<新 tabId>`） | 用户标记是长期意图；这也是活动租约的第二个写入路径 |

### 为什么仍然没有 `session-restore` 租约生产者

恢复是**同步**构造标签：后台标签根本没有 WebContents（`sweepDiscard()` 第一道守卫就跳过），
活动标签在同一个同步流程里被 `select()`，中间不存在"可丢弃但正在恢复"的时刻。
此时申请租约只是永远为真的装饰。按架构 §18 A1「不为没有真实消费者的能力提前建空壳」，
等恢复引入异步阶段（后台预热/延迟加载）再作为真实生产者接入。

## 3. 实现要点

| 位置 | 内容 |
| --- | --- |
| `shared/session.ts` | `SessionSnapshot / SessionWindow / SessionTab`、`SESSION_VERSION=1`、`sanitizeSession()` / `sanitizeSessionTab()` / `sessionFromPayload()` / `sessionTabCount()`；上限 10 窗口 / 200 标签；只认 `true` 布尔；地址必须 http(s) 且无凭据；内部页只允许 `newtab` |
| `shared/browser.ts` | `INFOBAR_HEIGHT`、`BrowserState.sessionPrompt`、命令 `restore-session` / `dismiss-session`、错误码 `no-session` |
| `db/store.ts` | `SCHEMA_VERSION = 2`；迁移改成按版本递增的步骤表；`migrateToV2()` 建 `session` 表；`readSession` / `writeSession`（写入前再校验）；`readSessionExit` / `writeSessionExit`；遗留规则归档名改用 `LEGACY_IMPORT_VERSION`，与 schema 版本解耦 |
| `storage.ts` | `session()` / `saveSession()` / `sessionExit()` / `markSessionExit()`；失败只记日志，不阻断浏览与退出 |
| `browser-window.ts` | 模块级 `sessionWindows` + `scheduleSessionSave()` 节流 + `holdSession()` / `releaseSessionHold()` / `flushSession()`；窗口内 `crashSession` / `sessionPromptOf()` / `createRestoredTab()` / `restoreCrashSession()` / `dismissCrashSession()`；`layout()` 为提示条让出 `INFOBAR_HEIGHT`；`describe()` 在导航提交前回落到 `lastUrl`（唤醒瞬间不再闪空白地址） |
| `index.ts` | 启动读 `sessionExit() === 'crash'` + 会话是否非空 → 决定是否挂起并交付提示；启动即武装 `crash`；`before-quit` → `flushSession()` + `markSessionExit('clean')` |
| `renderer/App.vue` | infobar 标记与样式、`--infobar-height` 令牌、两个动作按钮 |

## 4. 验证

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | ✅ |
| `node scripts/test.cjs unit` | ✅ 14 文件 / **140 通过**（`session.test.ts` 16 条；`settings.test.ts` 覆盖新键的取值与默认值） |
| `node scripts/test.cjs data` | ✅ 2 文件 / **11 通过**（`session-store.test.cjs` 4 条） |
| `node scripts/test.cjs smoke` | ✅ **23 文件 / 0 失败**（`session-restore.test.cjs` 4 条，约 22 s；`data-cleanup.test.cjs` 1 条） |

### 存储层（`tests/data/session-store.test.cjs`，真库 + 真进程）

1. **v1 → v2 升级**：手写 v1 库 → 启动后 `user_version=2`、`session` 表存在、旧设置/规则保留、
   `db/backups/` 生成 `browser-v1-*.sqlite3`、遗留导入的幂等标记未被清掉；
2. **载荷往返与坏载荷容错**：导航后退出一行载荷（版本、地址、`newtab`、唯一 `active`）；
   正常退出后 `session.last-exit = clean` 且**重启不恢复**；把载荷改成坏 JSON 后重启启动正常、
   退出时写回合法载荷；
3. **硬杀 → 提示 → 用户确认恢复**：硬杀后标记停在 `crash`；重启后只有 1 个新标签页 +
   `sessionPrompt.tabs = 2`；`restore-session` 后提示消失、标签回到原地址、空白 NTP 被覆盖而不多留；
   再次调用返回 `no-session`；随后正常退出写回 `clean`，再启动无提示。

### 行为层（`tests/smoke/session-restore.test.cjs`，真实 Electron 跨进程）

1. **正常退出后重启**：只有新标签页、`sessionPrompt` 为空、DOM 里没有 `.session-infobar`；
2. **异常退出后重启**：提示条出现并含「上次未正常退出」、标签未自动恢复 → 点「恢复标签页」后
   提示消失、A 仍在最左且 `pinned` + `discarded`、B 为活动标签且 `keepAwake`/`engine=ruffle`/
   `engineSource=manual` 全部保留 → 再正常退出重启不再提示；
3. **异常退出后点「忽略」**：不恢复任何标签，下次启动不再提示；
4. **`session.startup=continue`**：设置后正常退出再启动，直接恢复（不提示），
   置顶/休眠状态/保持活跃一并恢复，且设置本身跨重启保留。

用例里"硬杀前必须等会话按期望落盘"（地址 + 引擎 + 保持活跃三者同时满足）——只等地址会在标记
生效前就把进程杀掉，这是实现过程中真实踩到的坑。

## 5. 未覆盖与风险

1. **崩溃恢复提示只在第一个窗口显示**：多窗口会话并回当前窗口恢复，窗口布局/位置不还原。
2. **不恢复滚动/表单/导航栈**：恢复后的标签是"同一地址的新文档"（与 Chrome 丢弃/恢复语义一致，
   但对多步表单场景是可见损失）。
3. **提示只在启动时出现一次**：用户在提示条上没有任何操作就关闭窗口，会按正常退出处理
   （会话被丢弃）；没有"稍后恢复"的入口（Chrome 有历史菜单里的「最近关闭」）。
   想要"总是恢复"的用户需要主动把 `session.startup` 改成 `continue`。
4. **崩溃标记只有一次机会**：`before-quit` 之后若进程卡在退出流程里被强杀，标记仍是 `clean`，
   下次不会提示（宁可漏提示，也不要误提示）。
5. **会话数据没有清理入口**：属 M2「存储清理」项。
6. **并行 smoke 既有脆弱点**：`engine-rules.test.cjs` 在 4 并发下偶发超时（与本增量无关，
   单独重跑通过），会让全量绿灯出现假阴性。
7. **单窗口证据**：多窗口会话恢复只有载荷层校验，没有"两个窗口崩溃后并回一个窗口"的自动化。

## 6. 代码位置

| 内容 | 位置 |
| --- | --- |
| 会话合同与校验 | `app/src/shared/session.ts` |
| 提示条投影与命令 | `app/src/shared/browser.ts`（`INFOBAR_HEIGHT` / `BrowserState.sessionPrompt` / `restore-session` / `dismiss-session`） |
| 迁移与载荷读写 | `app/src/main/db/store.ts`（`SCHEMA_VERSION` / `MIGRATIONS` / `migrateToV2` / `readSession` / `writeSession` / `readSessionExit` / `writeSessionExit`） |
| 存储门面 | `app/src/main/storage.ts`（`session` / `saveSession` / `sessionExit` / `markSessionExit`） |
| 提示、恢复与保存接线 | `app/src/main/browser-window.ts`（`sessionWindows` / `scheduleSessionSave` / `holdSession` / `releaseSessionHold` / `flushSession` / `createRestoredTab` / `applySession` / `restoreCrashSession` / `dismissCrashSession` / `sessionPromptOf`） |
| 启动与退出 | `app/src/main/index.ts` |
| 提示条 UI | `app/src/renderer/App.vue`（`.session-infobar`） |
| 测试 | `app/tests/unit/session.test.ts`、`app/tests/unit/settings.test.ts`、`app/tests/data/session-store.test.cjs`、`app/tests/smoke/session-restore.test.cjs` |

## 7. 后续增量（同日）：启动策略设置项 `session.startup`

上表是默认行为（Chrome 的 `Open the New Tab page`）。想让"总是恢复"的用户也有正式入口，
补一个设置项，语义照着 Chrome 的 `On startup`：

| 值 | 行为 |
| --- | --- |
| `newtab`（**默认**） | 正常退出 → 新标签页、无提示；异常退出 → 提示条，用户确认后才恢复 |
| `continue` | 每次启动都恢复上次会话（用户已主动选择，不再提示）；命令行显式带网址时仍不恢复 |

实现要点：

- `shared/settings.ts` 新增键 `session.startup`（`Settings.sessionStartup`，`DEFAULT_SETTINGS.sessionStartup = 'newtab'`），
  走同一套 `sanitizeSetting`（只认 `newtab` / `continue`，其它值整体拒绝）；
- `db/store.ts` 的 `settingValue()` 补一个分支（键值表不需要迁移：它是 key-value 结构）；
- 设置页新增「启动」分区的一个下拉；
- `index.ts`：`session.startup === 'continue'` 且存有会话时，把会话作为 `initialSession`
  交给窗口；窗口用与崩溃恢复**同一个** `applySession()` 建标签（不弹提示、不挂起写盘）。
  两条路共用一套恢复逻辑，避免出现"提示恢复"和"自动恢复"两套实现漂移。

验证：`settings.test.ts` 增加合法/非法取值与默认值用例；`session-store.test.cjs` 增加
"continue 模式下正常退出重启直接恢复、不提示"；`session-restore.test.cjs` 增加同场景的
真实 Electron 跨进程用例（含置顶/休眠/保持活跃恢复断言，见 §4）。

控件形态（2026-11-24 后续调整，对齐 Chrome/Edge 的 `On startup`）：设置页的「启动时」不是下拉，
而是**单选项**，文案**不带括号说明**（`打开新标签页` / `打开上一个会话中的标签页`）；
"崩溃后才提示恢复"这类细节留在文档里，不进控件标签。
`internal-page.test.cjs` 增加一条 UI 用例：断言单选组形态、两个选项的文案（无括号）、
默认选中第一项，并验证点击第二项会写入 `session.startup` 且单选状态跟随更新。

## 8. 后续增量（同日）：会话数据清理入口

M2 退出条件里的「存储清理」要求**分类清理**。本节只做最小的一档：**会话数据**。

- 入口：`bao://settings` 的「数据」分区 → 「已保存的会话」→「清除」；
- 主进程：`settingsChannels.sessionClear`（只有本窗口内部设置页主帧能调，与设置写通道同构）
  → `clearStoredSession()`：`clearSession()` 在一个事务里删掉 `session` 行与
  `meta.session.last-exit`，然后**挂起本次运行的会话记录**并清掉仍挂着的崩溃恢复提示；
- 语义（UI 文案里也写明）：清除后本次运行不再记录会话，**下次启动恢复记录能力**。
  不这么做的话，800 ms 后的一次节流写会把当前标签又写回去，用户会以为按钮没生效；
- 失败语义：存储不可用或写库失败返回 `false`，页面显示"清除失败，会话数据未改动"，不动现有数据。

验证：`tests/smoke/data-cleanup.test.cjs`（真实 Electron + 真库）——
点「清除」后 `session` 行与退出标记都消失、页面显示结果；正常退出后库里仍然没有会话
（证明写盘确实挂起）；重启只有一个新标签页且无恢复提示；再逛一次并退出，会话重新出现
（证明"下次启动恢复记录能力"）。**未覆盖**：站点规则、设置项、缓存与 Flash 插件的清理
（分类清理的其余档位，属 M2 剩余工作）。

## 9. 后续增量（同日）：站点引擎规则清理（存储清理第二档）

「数据」分区加第二行：**站点引擎规则 → 清除**。

- 主进程：新增窄通道 `settings:engine-rules-clear`（与其它设置通道同构，只接受本窗口
  内部设置页主帧）；`clearEngineRulesData()` 执行 `DELETE FROM engine_rules` 并同步内存规则快照；
- 语义：**只删规则，不动标签**。已打开的标签保持当前引擎（不重载），但引擎来源按新规则重算
  （胶囊从「已记住 Ruffle」变为「默认」）；之后的新导航/新标签回到默认引擎；
- 清完立刻让每个窗口重新投影（`refreshProjection()`），否则胶囊会停在旧来源上；
- 失败语义与会话清理一致：返回 false，页面显示「清除失败，规则未改动」。

验证：`tests/smoke/data-cleanup.test.cjs` 新增一条端到端——
造一条真实规则（切 Ruffle → 「记住当前引擎」→ 断言 `engineSource = site-rule` 且落库）→
设置页点「清除站点引擎规则」→ 页面提示、`engine_rules` 表清空、已打开标签引擎不变但来源
回到 `default`、再次导航不再出现 `site-rule` → 重启后规则表仍为空。
