# M2 增量 2（上半）：`bao://settings` 内部设置页

2026-11-23 · 对应[架构 §3 外壳与 IPC](../discussions/2026-11-22-bfb-next-architecture.md#3-外壳标签与隔离)、[§4 数据](../discussions/2026-11-22-bfb-next-architecture.md#4-数据和基础模块)，以及用户确认的设置入口形态（**独立设置页 + 齿轮叠加层，双入口同源同步，对齐 Edge/Chrome**）。本增量交付**设置页**；齿轮叠加层在下一增量。

## 1. 决定与依据（含实测）

| 决策 | 选择 | 依据（2026-11-23 实测） |
| --- | --- | --- |
| 内部页载体 | 自定义特权 scheme `bao://settings` | `file://` 的 origin 恒为 `file://` 且页面会话也能加载任意本地文件；`bao://settings` 有独立 origin、`isSecureContext: true`，且只在我们绑定 handler 的内部会话里能加载（页面会话 `loadURL` → `ERR_FAILED`，`fetch` 全拒绝） |
| privileges | `standard + secure + supportFetchAPI`，**不开 `corsEnabled`** | 不开 `standard` 时 `location.origin` 为 `null`、没有存储；开了 `corsEnabled` 会让同一会话里的其它文档也能读 `bao://` 资源 |
| 会话 | 新建 `persist:bao-next-internal` | 与页面/外壳分区隔离；`localStorage` 这类纯 UI 偏好可留；权限策略与下载拒绝复用，`bao:` origin 连 `fullscreen` 都拿不到 |
| 桥 | 只有 `baoSettings = { read, write, subscribe }` | 内部页**没有** `baoBrowser` / `baoOverlay` / `baoWindowControl`；发送者按「本窗口标签表 ∧ 主帧 ∧ 文档 URL ∈ bao://settings/*」三条件判定 |
| 沙箱 | `sandbox/contextIsolation/nodeIntegration` 与页面视图**完全一致** | 内部页不是特权渲染进程，只是一个沙箱文档 + 一条窄 IPC |
| 入口（本增量） | `Ctrl+,` 与地址栏 `bao://settings` | 齿轮叠加层是下一增量；已存在则复用（Edge 语义） |
| 地址栏行为（P2） | 设置页里输入 http(s) **新开标签** | 内部会话永远不承载网页：实测绑定了 handler 的会话里加载的网页可以 `fetch('bao://settings/…')` 拿到 200 |

## 2. 改了哪些文件

新增：

| 文件 | 作用 |
| --- | --- |
| `app/src/main/internal-pages.ts` | scheme 描述符、`protocol.handle`（只绑内部会话）、URL 判定与地址解析、CSP 响应头、路径越界防护 |
| `app/src/preload/internal.ts` | 内部页 preload：只暴露 `baoSettings`（read/write/subscribe） |
| `app/src/renderer/settings.html` / `settings.ts` / `SettingsPage.vue` / `settings-env.d.ts` | 设置页（Edge 式左导航 + 主题卡片 + 默认引擎 + 语言） |
| `app/tests/smoke/internal-page.test.cjs` | 2 条合同用例 |

修改：

| 文件 | 改动 |
| --- | --- |
| `app/src/main/sessions.ts` | 新增 `getInternalSession()`（`persist:bao-next-internal`） |
| `app/src/main/browser-window.ts` | 标签加 `internal`；`createInternalView()`；`guardContents` 的 `allow` 从写死 http(s) 改成按标签传入；`openInternalTab()/openSettingsTab()`；`navigate` 的内部页分支（P2）；引擎命令对内部页拒绝；`ownsContents/internalSender/internalSnapshot/broadcastSettings`；设置 IPC 校验 + 广播；`Ctrl+,` |
| `app/src/main/index.ts` | **合并成一次** `registerSchemesAsPrivileged`（Ruffle + 内部页） |
| `app/src/main/ruffle.ts` | `registerRuffleScheme()` → `ruffleSchemePrivileges()`（只导出描述符，避免二次登记） |
| `app/src/preload/...`、`app/src/shared/settings.ts` | 新增 `settingsChannels` / `SettingsSnapshot` / `SettingsBridge` / `SettingsWriteResult` |
| `app/src/shared/browser.ts` | `BrowserTab.internal`、`{type:'open-settings'}` |
| `app/src/renderer/App.vue`、`ShellIcon.vue` | 内部页标签用齿轮图标、隐藏引擎胶囊；`ShellIcon` 加 `gear` |
| `app/src/renderer/theme.ts` | 幂等键从 `data-theme` 改为独立标记（见 §4），并写 `data-theme` |
| `app/electron.vite.config.ts` | 渲染层两个入口（`index` / `settings`）、preload 加 `internal` |
| `app/package.json` | smoke 用例列表加入 `internal-page.test.cjs` |

## 3. 实跑命令与结果

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | ✅ 通过 |
| `npm run smoke` | ✅ **26/26 通过**，46.98 s（新增内部页 2 条：2.20 s / 1.47 s；其余 24 条无回归） |
| `npm run test:data` | ✅ 6/6，8.94 s |
| 真实渲染截图（出厂内核 `capturePage`） | 设置页浅色/深色两张，见 §5 |

内部页用例覆盖：

1. `Ctrl+,` 打开设置标签（`internal: 'settings'`、地址 `bao://settings/`、标题「设置」）→ 再按一次**复用**而不是新建；
2. 桥面：`baoSettings` 的 `read/write` 是函数，`baoBrowser/baoOverlay/baoWindowControl/require/process` **全部 undefined**；
3. 页面写 `theme.mode=dark` → 主进程落库 → **外壳与设置页同时重绘**（`dataset.theme`）、选中态跟着变、`nativeTheme.themeSource === 'dark'`；
4. 普通页面没有 `baoSettings`；页面标签导航到 `bao://settings/` 返回 `invalid-address`；
5. 设置页里输入 http(s)：**新开标签**，设置页原地不动（P2）；外壳 UI 上设置标签显示齿轮、无引擎胶囊；
6. 关闭设置标签后 `undo-close` 能恢复，且恢复后 `getURL() === 'bao://settings/'`；
7. 页面会话 `fetch('bao://settings/')` 失败（协议没绑在该会话）。

## 4. 本增量踩到的两个坑（都已修，都值得记住）

1. **`protocol.registerSchemesAsPrivileged` 多次调用会覆盖，不是追加。** 我一开始让 Ruffle 与内部页各自登记一次，结果 Ruffle 的两条用例（`ruffle-cors`、`ruffle-input`）挂掉——Ruffle 的资源协议失去了 `standard/secure/corsEnabled`，页面注入失败、画布不出现。改成 `index.ts` 里**一次登记全部 scheme**（`[...ruffleSchemePrivileges(), ...internalSchemePrivileges()]`）后恢复。**以后再加自定义 scheme，只能往这一个数组里加。**
2. **`applyShellTheme` 的幂等键用了 `data-theme`**，而设置页的 HTML 预置了 `data-theme="light"` → 首次调用直接早退，CSS 变量（`--brand-stroke` 等）从没写入，选中卡片没有高亮。改成独立的 `data-shell-theme` 标记后正常（两张截图可见）。

另外一处行为修正：内部页在首帧加载完成前 `getURL()` 为空，地址栏会短暂空白；`describe()` 对内部页回落到 `SETTINGS_URL`（Chrome 同样立刻显示 `chrome://settings`）。

## 5. 视觉证据

设置页真实渲染（出厂内核，非设计稿）：`docs/design/renders/settings-page-light.png`、`docs/design/renders/settings-page-dark.png`。

## 6. 未验证 / 明确不承诺

1. **齿轮叠加层未做**（下一增量）：目前入口只有 `Ctrl+,` 与地址栏。
2. **打包产物内未验证**：`bao://settings` 的资源从 `app.asar/out/renderer` 读取，开发态验证过，`smoke:packaged` 未跑。
3. **`Ctrl+,` 与站点快捷键的冲突**未在真实站点（4399/淘米）里验证——它在 `before-input-event` 上执行，会先于页面拿到按键。
4. **设置页的拖出窗口 / 崩溃重建**没有单独用例（撤销关闭覆盖了「重建内部视图」的主路径）。
5. **多窗口语义**（每窗口一个设置标签）没有双窗口用例。
6. **`localStorage` 与 `service worker`** 在 `bao://` 下的长期行为只验证到「可用/跨进程保留」，没有做容量与清理。
7. **`stream: true`** 对内部页是否必要未单独隔离测试（当前用 `Response(Uint8Array)`，不需要）。

## 7. 下一步

增量 2（下半）：工具栏齿轮 + `quick` 叠加层（主题/默认引擎/语言三项 + 「全部设置」链接），复用现有叠加层机制；与设置页共用同一 store，并用用例验证「叠加层改主题 → 设置页立刻跟着变，反之亦然」。
