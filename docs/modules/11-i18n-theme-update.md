# 11 · 界面语言、主题与更新检查

> 状态：按 **1.1.2（2026-11-02）** 源码核对。本文为 1.1.2 新增模块（旧版模块文档没有
> 这三块能力）。首次启动语言门的挂载时机见 01。

## 1 范围与目标

三件围绕"外壳表现"的能力：

- **界面语言**：渲染层 typesafe-i18n 与主进程 `uiText()` 双轨，经 `ui:set-language`
  同步；
- **主题**：渲染层解析 `system/light/dark`，主进程把模式交给 `nativeTheme`，由 Chromium
  传播到所有 BrowserView；
- **更新检查**：手动查询 GitHub 稳定版 Release，只提示不自动下载。

## 2 静态结构

| 路径 | 职责 |
| --- | --- |
| `src/main/modules/ui-language.ts` | `getUiLanguage` / `uiText` / `ui:get-language` / `ui:set-language` 与广播 |
| `src/main/ipc/theme.ipc.ts` | `theme:set-source` → `nativeTheme.themeSource` |
| `src/main/modules/app-update.ts` | GitHub `releases/latest` 查询、版本比较、15s 超时 |
| `src/main/ipc/app-update.ipc.ts` | `app:version` / `app:check-update` / `app:open-release`；启动自动检查 + 桌面通知 |
| `src/shared/types/app-update.ts` | `AppUpdateResult` |
| `src/renderer/i18n/` | typesafe-i18n 生成代码 + `zh-CN`（baseLocale）/ `en` 词典 |
| `src/renderer/hooks/useTheme.ts` | 主题解析、`matchMedia` 监听、`body.dark` |
| `src/renderer/components/overlays/FirstRunLanguageGate.tsx` | 首次启动语言选择 |
| `src/renderer/components/panels/SettingsPanel.tsx` | 语言下拉、主题切换、更新检查 UI |

## 3 界面语言

### 3.1 两套状态与同步链

| 层 | 存储 | 用途 |
| --- | --- | --- |
| 渲染层 | IndexedDB `settings.language` | typesafe-i18n 的 locale、UI 文案、首次启动判断 |
| 主进程 | `config.uiLanguage` | `uiText()` 生成的菜单/对话框标题、`ui:get-language` |

同步链：

```text
setLocale / 首次启动选择
  → AppInner 的 effect: invoke('ui:set-language', locale)
  → 主进程校验 event.sender 是主窗口，写 config.uiLanguage
  → 向所有未销毁 webContents 广播 'ui:language-changed'
  → BrowserView preload 收到后，原生助手销毁并重建（实时换语言）
```

`ui:set-language` 只接受主窗口的 sender；语言值只接受 `en` / `zh-CN`，其他直接抛错。

### 3.2 使用约定

- 渲染层 UI 一律用 `LL.xxx()`；主进程文案用 `uiText('中文', 'English')`，不要在 IPC
  或 dialog 里硬编码中文。
- 新增主进程文案时，中英两份都要写在 `uiText` 调用点，不要依赖运行时查表。
- 助手的英文版由构建期 `native-assistant-i18n.mjs` 生成；新增中文文案必须同步
  `assistant-ui-en.json`，否则构建失败（见 03）。
- baseLocale 固定 `zh-CN`；`loadAllLocales()` 在 App 首次渲染前同步加载。

## 4 主题

- `useTheme` 解析：`system` 跟随 `prefers-color-scheme`，`light/dark` 直接使用；切换
  顺序为 `light → dark → system`。
- 渲染层通过 `document.body.classList.toggle('dark', …)` 应用样式。
- `App` 把**模式**（不是解析后的颜色）发给 `theme:set-source`；主进程设置
  `nativeTheme.themeSource`，Chromium 自动传播到所有 BrowserView，包括 CSS
  `prefers-color-scheme` 与 `matchMedia` 监听。
- 必须传模式：传 `light`/`dark` 会让 `system` 永久覆盖系统设置，用户改系统主题后
  网页不再跟随。

## 5 更新检查

`app:check-update` → `checkAppUpdate(app.getVersion())`：

1. `GET https://api.github.com/repos/Sutanm/BaoFlashBrowser/releases/latest`，
   `User-Agent: BaoFlashBrowser`、`Accept: application/vnd.github+json`；
2. 非 200、响应超过 **1 MiB**、15 秒总超时、JSON 解析失败 → `status:'error'`；
3. 拒绝 `draft` / `prerelease`；`tag_name` 必须匹配 `v?x.y.z`；
4. `isNewerVersion` 逐段比较 major/minor/patch（不处理预发布后缀）；
5. 结果 `{ status: 'available'|'current'|'error', currentVersion, latestVersion?,
   releaseUrl? }`。

IPC 层：

- 并发请求合并：同一时刻只有一个 `pending` Promise，多个调用共享结果；
- `releaseUrl` 缓存最近一次成功结果，`app:open-release` 用它打开浏览器；没有成功结果时
  回退 `RELEASES_URL`；
- `app:version` 供设置页显示当前版本。

启动自动检查：

- `config.updateCheckMode`（`auto` 默认 / `manual`）决定是否在启动时自动查询；设置页
  「启动时自动检查更新」开关写入该字段（随主配置保存）；
- `runStartupUpdateCheck()` 在 `app.whenReady` 的延迟区块内调用，**每次启动只查询一次**
  （与手动检查共用同一个并发合并 Promise），网络请求不阻塞首屏；`manual` 模式直接返回；
- 结果为 `available` 且系统支持通知时弹一次桌面通知（`Notification`），点击打开该版本
  Release 页；`current` / `error` 静默，不弹通知。

UI 三态：`current` 显示"已是最新"，`available` 显示新版本号 + "下载"按钮，
`error` 显示失败提示。**没有自动下载、没有静默更新、没有轮询**。

## 6 安全与雷区

1. **两套语言状态必须同步**：只改渲染层 IndexedDB 而不 invoke `ui:set-language`，原生
   菜单/对话框会停留在旧语言。
2. **主题必须传模式**：`system` 依赖 `nativeTheme.themeSource='system'` 移除覆盖。
3. **`ui:set-language` 校验 sender**：允许任意 webContents 调用会让网页篡改应用语言。
4. 更新检查只读 GitHub API，不上传任何本地信息；不要加入设备标识或使用统计。
5. 保持"只提示、不自动安装"：无签名校验与增量更新机制，自动安装风险不可控。
6. 不要轮询 GitHub API；仅**启动时查询一次** + 用户点击时查询，避免限流与无谓网络请求。
7. 预发布版本永不提示；`tag_name` 校验失败一律按 error 处理，不要"猜"版本。

## 7 验证

- `npm test -- --run tests/first-run-language.test.tsx`（首次启动门）。
- `npm run test:e2e -- tests/e2e/first-run-language.spec.ts`（需先构建）。
- 主题：`tests/theme-toggle.test.tsx`。
- 更新检查：`tests/app-update.test.ts`（版本比较、draft/prerelease、超时与错误路径）。
