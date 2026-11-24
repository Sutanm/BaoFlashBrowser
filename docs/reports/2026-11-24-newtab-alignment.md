# M2 增量：新标签页对齐 Chromium（P0 行为 + P1 页面职责 v1 + P1.5 Back 回 NTP）

2026-11-24 · 对应[新标签页对齐方案](../discussions/2026-11-24-new-tab-page-alignment.md)的 **P0 + P1 + P1.5（D1 补充）**，以及[架构 §3 外壳](../discussions/2026-11-22-bfb-next-architecture.md#3-外壳标签与隔离)。

**触发**：新标签页此前是 `data:` 占位文档，且「打开设置页」会新开标签而不是把当前新标签页导航到设置页。

## 1. 交付范围与结论

| 项 | 结果 |
| --- | --- |
| 新标签页载体 | `bao://newtab/` 内部页（与 `bao://settings` 同一内部会话、不同 origin），`start-page.ts` 已删除 |
| 打开设置的语义 | 对齐 Chrome 的 `ShowSingletonTabOverwritingNTP`：已有设置标签 → 切过去；当前是 NTP → **就地覆盖**（标签 id/位置不变，历史项追加，可后退回 NTP）；否则新建 |
| 新标签页从不被复用成「第二个」 | `Ctrl+T` / 「+」/ 双击标签栏 / 关闭最后一个标签 → 一律新建一个 NTP（Chrome 同款） |
| NTP → 网页 | 同一个标签换成页面视图（内部会话永不承载 http(s)），标签 id/位置不变 |
| 页面职责 v1 | realbox（本标签导航）、设置入口、原生 Flash 状态；**没有真实数据源（历史/书签）的板块不画** |
| 撤销关闭 | 只有一条导航且就是 NTP 的标签不入栈（Chrome 的 `IsTabInteresting`）；NTP → 设置 → 后退的标签仍可恢复 |
| 复制 / 崩溃重建 / 休眠 | 复制出同类内部页；崩溃重建回到 `bao://newtab/`；休眠扫描仍排除内部页 |
| 焦点 | NTP 激活时焦点交给外壳并由外壳聚焦地址栏（`Ctrl+T`、`+`、Back 回 NTP 一致） |
| **Back 回 NTP**（补充） | 网页标签走到最早一条历史再按 Back → **同一个标签**重建 NTP 视图；停在 NTP 时 Forward → 重新打开那个网页 |

**Back 回 NTP 的代价（已登记）**：`bao://newtab` 不在页面视图的历史里（内部会话永不承载 http(s)，进出 NTP 必须换 WebContents），所以 Back 是「重建 NTP 视图」而不是历史回放：页面状态随旧 WebContents 丢弃，Forward 重新加载该地址。`canGoBack` 由标签标记 `fromNewTab` 补齐，UI 的返回按钮在最早一条历史时也是可用的。

## 2. 改了哪些文件

新增：

| 文件 | 作用 |
| --- | --- |
| `app/src/renderer/newtab.html` / `newtab.ts` / `NewTabPage.vue` | 新标签页文档：realbox、设置入口、Flash 状态；主题跟随 `prefers-color-scheme` 与 `baoNtp` 快照 |
| `app/src/renderer/ntp-env.d.ts` | `window.baoNtp` 类型 |
| `app/src/shared/ntp.ts` | NTP 窄通道、快照与桥类型 |
| `app/tests/smoke/newtab.test.cjs` | 6 条合同用例 |
| `docs/design/renders/newtab-page-light.png`、`newtab-page-dark.png` | 真实渲染截图（出厂内核 `capturePage`） |

修改：

| 文件 | 改动 |
| --- | --- |
| `app/src/main/internal-pages.ts` | `NEWTAB_HOST/NEWTAB_URL`、`InternalKind`、`internalKindOf/isInternalUrl/isNewTabUrl/parseInternalAddress`；handler 按 host 分派入口文件；开发态代理按 host |
| `app/src/main/browser-window.ts` | `Tab.internal` 联合类型；`openInternalTab(kind)`、`openNewTab()`、`controlInternal()`、`openSettingsTab()` 三层优先级、`navigateTab()`、`leaveNewTab()`；**P1.5**：`Tab.fromNewTab/newTabForwardUrl`、`returnToNewTab()`、`back/forward` 补齐、`describe` 的 `canGoBack/canGoForward`；`describe/revive/rebuild/reloadTab/duplicateTab/rememberClosed/undoClose/restoreHistory/select` 适配；NTP 发送者校验 + `ntp:*` IPC + NTP 快照广播 |
| `app/src/preload/internal.ts` | 同一 preload 额外暴露 `baoNtp`（read/run/subscribe），两种内部页共用 |
| `app/src/shared/browser.ts` | `BrowserTab.internal` 改为 `'newtab' \| 'settings'` |
| `app/src/renderer/App.vue` | NTP 标签用页面图标（齿轮只给设置页）；NTP 激活时聚焦地址栏 |
| `app/electron.vite.config.ts` | renderer 增加 `newtab` 入口 |
| `app/src/main/start-page.ts` | **删除**（由 `bao://newtab/` 取代） |
| `app/scripts/test.cjs` | smoke 列表加入 `newtab.test.cjs` |

用例适配（行为变化导致的必要修改，意图不变）：

| 用例 | 原因 |
| --- | --- |
| `internal-page.test.cjs` | 原断言「Ctrl+, 后标签数 1→2」，改为「就地覆盖同 id、标签数不变、可后退回 NTP」 |
| `engine-rules.test.cjs` | 起始页现在是内部页：改为断言「无引擎胶囊 + `remember-engine` 返回 `no-site`」，其余流程先导航到网页 |
| `engine-broker.test.cjs` | 引擎胶囊只在网页标签上出现：先导航再切 Ruffle |
| `tearoff.test.cjs` | NTP→网页是换视图、NTP 不进历史：补充第二次站内导航后才断言「历史随标签迁移」 |
| `internal-address.test.ts` | 新增 `isNewTabUrl` / `internalKindOf` / `parseInternalAddress` 用例（10 条） |

## 3. Back 回 NTP 的补法（P1.5）

NTP 不在页面视图的历史里，所以用两个标签字段把这一层补出来：

| 字段 | 含义 | 生命周期 |
| --- | --- | --- |
| `fromNewTab` | 这个标签的第一个文档是网页，但它是从 NTP 进来的 | 进入网页时置位；复制标签、撤销关闭、休眠唤醒都随标签保留 |
| `newTabForwardUrl` | Back 回 NTP 后，Forward 要重开的网页地址 | `returnToNewTab` 记下当前地址；在 NTP 里发生任何真实导航（输入新地址、进设置）即作废 |

- `describe()`：网页标签的 `canGoBack = history.canGoBack() || fromNewTab`；NTP 标签的 `canGoForward = history.canGoForward() || newTabForwardUrl`。UI 的返回/前进按钮据此启用。
- `back`：页内历史优先；历史到头且 `fromNewTab` → `returnToNewTab()`（换回内部视图、记下当前 URL、焦点落到地址栏）。
- `forward`：NTP 上有历史（例如 NTP → 设置 → 后退）优先走历史；否则按 `newTabForwardUrl` 重新进网页（`leaveNewTab`）。
- 已知限制：Back 是「重建 NTP 视图」，页面状态不保留；Forward 重新加载该地址。若 Back 回 NTP 后直接关标签，撤销关闭只能恢复 NTP 本身（网页那条历史不在 NTP 视图里，也不值得为此保活一个渲染进程）。

用例：`newtab.test.cjs` 的「网页上 Back 回到 NTP，Forward 重新打开该网页」覆盖 A→B→Back→Back→NTP（标签 id 不变、地址栏为空、`canGoBack=false`、`canGoForward=true`、引擎胶囊消失、焦点在地址栏）→Forward→A（`canGoBack=true`）→Back→NTP→输入新地址后 `canGoForward=false`。

## 4. 两个实现教训（值得记住）

1. **两种内部页必须共用同一个 preload。** 第一版按 kind 给 NTP 不挂 preload、给设置页挂 `internal.js`，结果「NTP 就地变成设置页」后设置页拿不到 `baoSettings`（preload 是按文档执行的，就地导航不会换 WebContents）。现在共用 `internal.js`，权限完全由主进程按「标签身份 ∧ 主帧 ∧ 文档 URL」判定：NTP 调 `baoSettings.read/write` 返回空/`forbidden-sender`，设置页调 `baoNtp.run` 同样被拒（用例覆盖）。
2. **NTP 里的动作要在回完 IPC 之后再换文档。** `open-settings` 和 `navigate` 都会让发送方文档消失，`runNtp` 先返回结果、再 `setImmediate` 执行，避免回复打在已销毁的帧上。

## 5. 验证

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | ✅ 通过 |
| `node scripts/test.cjs unit` | ✅ **105/105**（12 个文件） |
| `node scripts/test.cjs smoke` | ✅ **21 个文件、0 失败**，45.8 s（含新增 `newtab` 7 条；`internal-page` 4 条全过） |
| 真实渲染截图 | `docs/design/renders/newtab-page-light.png`、`newtab-page-dark.png`（1650×1014） |

`newtab.test.cjs` 覆盖：

1. 启动即是 `bao://newtab/`：`origin === 'bao://newtab'`、标题「新标签页」、地址栏空、无引擎胶囊；`baoBrowser/baoOverlay/require` 均不存在；`baoSettings` 存在但读空、写被拒；`baoNtp.read()` 的字段与主题正确、非法地址返回 `invalid-address`；
2. NTP 地址栏输入 http(s) → 同一个标签变成网页（id 不变）、引擎胶囊出现；页面会话 `fetch('bao://newtab/')` 失败；
3. 复制 NTP 得到 NTP；关闭纯 NTP 不入撤销栈（`undoCount` 不变）；
4. 页面里的设置入口：同标签就地打开设置；设置页用 `baoNtp` 被 `forbidden-sender` 拒绝；后退回 NTP 后用 realbox 在同标签导航；
5. realbox 输入非 URL：行内提示，页面不跳转；
6. 已有设置标签时 `Ctrl+,` 只切过去，NTP 保留；
7. 网页上 Back：站内历史优先，历史到头回 NTP（同标签、地址栏空、焦点在地址栏），Forward 重新打开该网页；从 NTP 输入新地址后 Forward 作废。

`internal-page.test.cjs` 的第 1 条现在验证「就地覆盖 + 后退回 NTP + 不重复建标签」，其余桥面/主题同步/边界用例不变。

## 6. 未验证 / 不承诺

1. **打包产物**未跑：`newtab.html` 已进 renderer 构建清单，但 `smoke:packaged` 需要重新 `pack:win` 后另行验收。
2. **开发态（Vite dev server）代理**未单独跑：`bao://newtab/` 与设置页走同一套「按 host 映射入口文件」的代理，验证依赖 `npm run dev` 的前台环境。
3. **会话恢复**未实现（M2 剩余范围）：重启后 NTP 按新标签页重开，历史栈不跨重启。
4. **realbox 搜索**不承诺：非 URL 输入只给提示；等「默认搜索引擎」设置项落地再增强。
5. **快捷方式 / 最近访问**未做：依赖历史与书签（M2 未完成清单），按「没有数据源就不画板块」处理。
6. **多窗口**的设置标签复用仅在单窗口内验证（与 Chrome 行为一致：跨窗口只在当前窗口无法开标签时发生）。
7. **Back 回 NTP 的页面状态**不保留（重建视图 + Forward 重载），与 Chrome 的历史回放不同；这是「内部会话永不承载 http(s)」的既定代价。
8. `Ctrl+,` 在 Chromium Windows 上并不存在（仅 macOS），我们沿用产品既有绑定，未做跨平台论证。
