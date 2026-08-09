# 截图功能设计方案（v5）

> 本版基于 v1 方案审计与 v2/v3/v4 文档的审计回填（2026-08-07）：
>
> - v1–v16 demo 已删除，仓库现存 v17–v19 demo；旧版"隐藏位置/最小化截图"结论
>   无法被现存脚本复验，全部关键技术假设收敛到**验证门（v20 demo）**。
> - v2 审计（已内化）：P0 savePath 任意写入；P1 capturer size/stayHidden 盲区、
>   最小化首帧；P2 tabManager 公共 API、reveal 路径校验、IPC 接线、base64 回传浪费；
>   P3 同步 IO、配置同步处数、schema 对齐、无参通道校验、遗留断言、win===null。
> - v3 审计（已内化）：P1 tabId 注入 sanitize、savePath 扩展名白名单、set-dir 实现
>   细节；P2 stayHidden 配对、架构图签名、showItemInFolder 死代码、瞬态竞态、
>   SettingsPanel 先例、错误码缺口、注册时机、重名覆盖语义。
> - v4 审计（本版已内化）：P0 注册作用域（全部通道移入 registerScreenshotIPC 函数体）、
>   set-dir 双轨澄清；P1 SettingsPanel/save-config 全链路缺口、explicitPath 分支
>   sanitize、set-dir 错误包装；P2 captureTab 未按 isActive 分支、getContainerRect()
>   缺口、save-config 路径约束、Pictures fallback、getScreenshotDir export；P3 v20
>   通过标准精确化、symlink 归一化记录、REVEAL_FAILED 注释、DIR_DENIED。
>
> **v6 增补（2026-08-08 实施后回填）**：
> - v20 gate 实测全部通过：hidden 1×1 无参 capturer 即全尺寸（推翻"1×1 viewport
>   必然 1×1"假设）、最小化无需首帧等待、T4 最小化+hidden 非空（推翻旧"黑屏"结论）。
>   `HIDDEN_CAPTURE_ENABLED=true`、`HIDDEN_CAPTURE_STAY_HIDDEN=true`（T2c 侧证
>   `visibilityState=hidden`）、`FIRST_FRAME_DELAY_MS=0`。
> - 新增**调试 HTTP 口子（方案 A）**：AI/自动化从外部主动触发运行中实例截图，
>   见 §调试 HTTP 口子。
> - 已知限制：newtab/userscripts 页无 BrowserView → `NO_TAB`（TopBar 按钮 toast 可见
>   "no browser view"）；React 全窗口截图（含 UI 与 BrowserView 同框）未实现——拼合
>   方案为跨平台（Windows/Linux 一致）候选，desktopCapturer 仅 Windows 可靠。
>
> 历史参考（保留不删）：`tests/electron/screenshot-v17-flash-diagnostic.cjs`、
> `screenshot-v18-flash-fix.cjs`、`screenshot-v19-minimize-test.cjs`、
> `release/screenshot-test/` 下的诊断页与截图产物。

## 需求

1. **程序化截图（核心）**：IPC 接口，供自动化脚本与开发时（AI）调用。
2. **用户截图（次要）**：工具栏按钮，点击截当前标签页并自动存档。
3. 截取 BrowserView 内容（Flash / Ruffle 游戏画面）。
4. 窗口可见、隐藏标签页（-9999,-9999,1,1）、窗口最小化三种状态下能力分级明确。
5. **零闪烁**，完全无感。

## 已验证事实（现状基线）

| 事实 | 来源 |
|------|------|
| Chromium 87 加载 `.swf` 的内部插件页缺 `html{height:100%}`，body 塌缩到 SWF stage 高度，截图只出顶部一条 | v17 demo（v17-T1 vs T2，205KB vs 1.6MB） |
| 注入 CSS 修复后正常窗口/最大化截图完整（全幅 ~1.5MB） | v18-T2/T3、v19-T1/T3/T4 |
| **最小化时 `capturePage` 直接调用返回空图**（v17-T4/T5、v18-T4、v19-T2/T5 均无产物文件） | 全部最小化测试 |
| CSS 修复**不能**解决最小化空图问题 | 同上对照 |
| 高度塌缩修复已合入生产：`src/main/modules/tabs.ts:187-198`（dom-ready 对 `.swf` URL `insertCSS`，每次导航重新注入） | `swf-render-verify.cjs`（contextIsolation:true 镜像验证通过） |
| `insertCSS` 为每次 dom-ready 重新注入；定时 `executeJavaScript` 注入在导航后不可靠 | v18-T6（200KB ≈ 基线条状图） |
| `incrementCapturerCount(size?: Size, stayHidden?: boolean)` / `decrementCapturerCount(stayHidden?: boolean)`，Electron 11.5.0 存在；d.ts 注释：capturer count 非零时"窗口隐藏但页面视为可见"，`stayHidden:true` 保持 Page Visibility 为 hidden | `electron.d.ts:9874,10018` |
| `shell.showItemInFolder(fullPath: string): void` — **Electron 11 返回 void 不抛异常**，失败判定须前置 `fs.existsSync` | `electron.d.ts:7236` |
| `isPathWithinDirectory` / `availableSavePath` / `sanitizeDownloadFilename` 现成工具 | `src/main/utils/download-path.ts:4,20,30` |
| `download:set-dir` 用裸 `ipcMain.handle` + `BrowserWindow.getFocusedWindow() \|\| getMainWindow()` + `dialog.showOpenDialog`；download 默认目录 `path.join(app.getPath('downloads'), 'BaoFlashBrowser')` | `download.ipc.ts:54-69`、`download.ts:17` |
| 项目 IPC 模式：**所有通道注册在 `export function registerXIPC()` 函数体内**（tabs/download/password 一致） | `tabs.ipc.ts`、`download.ipc.ts`、`password.ipc.ts` |
| SettingsPanel 只有 `downloadEngine` 等 mainForm 字段，无目录选择先例；`save-config` schema 现无 downloadDir/screenshotDir 路径约束 | `SettingsPanel.tsx:136-147`、`config.ipc.ts:11-23` |

**待验证（v20 验证门）**：

| 假设 | 现状 |
|------|------|
| capturer + **visible bounds** + 窗口最小化 = 全尺寸成功 | 旧版文档结论，脚本已删，**未复验** |
| capturer + **hidden bounds**（1×1）= 全尺寸成功（size 参数） | 旧版文档结论，脚本已删，**未复验** |
| capturer 后最小化页面需要首帧等待（paint/延迟） | 未验证 |

## 架构

```
src/main/modules/screenshot.ts         新 — 截图核心
├─ captureWebContents(wc, { rect?, size?, stayHidden? })  纯捕获原语（try/finally 防泄漏，stayHidden 配对）
├─ captureTab(tabId, opts)             策略编排（状态判定 + 文件名 sanitize + 路径/扩展名校验）
└─ getScreenshotDir()                  export（config.screenshotDir → Pictures → userData/screenshots 兜底）
src/main/modules/tabs.ts               改 — 新增公共 API（见下方契约）
├─ getActiveId(): string | null
├─ getWebContents(tabId): Electron.WebContents | null
├─ isTabActive(tabId): boolean
└─ getContainerRect(): { x, y, width, height }   ← 激活时容器尺寸（hidden 捕获 size 参数的来源）
src/main/ipc/screenshot.ipc.ts         新 — 全部通道在 registerScreenshotIPC(getWin) 函数体内注册
src/main/ipc/config.ipc.ts             改 — save-config schema 补 screenshotDir（含路径 refine）
src/main/index.ts                      改 — 接线 registerScreenshotIPC(() => getMainWindow())（立即注册）
src/main/modules/config.ts             改 — 新增 screenshotDir（interface/DEFAULT/schema/load/save 五处）
src/preload/index.ts                   改 — ALLOWED_INVOKE_CHANNELS + electronAPI.screenshot
src/renderer/types/electron.d.ts       改 — 类型声明
src/renderer/components/layout/TopBar.tsx  改 — 截图按钮（returnData:false + save:true）
src/renderer/components/panels/SettingsPanel.tsx  改 — 截图目录行（自实现，见 §UI）
src/renderer/services/toast.ts         （复用，不加代码）
tests/electron/screenshot-v20-gate.cjs 新 — 验证门 demo
tests/screenshot-policy.test.ts        新 — 策略决策纯函数单测
```

**tabManager 新增公共 API 契约**（当前不存在，须新增；`activeId`/`rect` 为 private）：

- `getActiveId(): string | null` — 无活跃标签页返回 null。
- `getWebContents(tabId): Electron.WebContents | null` — tabId 不存在、
  `tab.browserView === null`（newtab/userscripts 页无 view）或 wc 已销毁时返回 null；
  **调用方必须处理 null**，不得用 `as any` 绕过。
- `isTabActive(tabId): boolean` — 按 `activeId` 判定。
- `getContainerRect(): ContainerRect` — 返回 `this.rect`（激活态视图的容器尺寸）。
  **用途**：hidden 捕获时 `capturer size` 应传"该标签页激活时应有的尺寸"
  （= `getContainerRect()` 的宽高），而不是 HIDDEN_BOUNDS 的 1×1（见 §捕获策略决策点 1）。

## 捕获策略

**判定依据**：`win.isMinimized()` + `tabManager.isTabActive(tabId)`。

| 目标 tab | 窗口状态 | 行为 | 依赖验证 |
|----------|----------|------|----------|
| active（visible bounds） | 正常 | capturer（无 size/stayHidden）→ capture → finally 递减 | 无需（v18 全幅已证） |
| active | 最小化 | capturer → **首帧等待**（v20 定延迟或 paint）→ capture | v20-T3 |
| inactive（hidden bounds） | 正常 | capturer（size = `getContainerRect()` 宽高；stayHidden 按 T2c）→ capture | v20-T2 系列 |
| inactive | 最小化 | 返回错误 `MINIMIZED_INACTIVE` | v20-T4 对照 |

**决策点（v20-T2/T3 回填）**：
1. **已回填（2026-08-08 v20 gate 实测）**：hidden 1×1 bounds 下，无参 capturer 即返回
   全尺寸（1920×1080 = 1280×720 × DPR 1.5），`size` 参数与 `stayHidden:true` 变体同样
   全尺寸，且 T2c 侧证 `document.visibilityState === 'hidden'`（stayHidden 生效，页面
   行为不被扰）。**结论：inactive 捕获无需"临时移 bounds"，capturer 即可零闪烁全尺寸**；
   实现采用 size = `getContainerRect()` + `stayHidden:true`（保持页面 visibility hidden，
   最保守）。`HIDDEN_CAPTURE_ENABLED = true`、`HIDDEN_CAPTURE_STAY_HIDDEN = true`。
2. **已回填**：T3a 最小化 + visible + capturer 立即 capture 即全尺寸（无需首帧等待），
   `FIRST_FRAME_DELAY_MS = 0`。T4 最小化 + hidden 实测非空（1920×1080）——推翻旧文档
   "hidden+最小化=黑屏"结论（可能为合成器缓存帧）；`MINIMIZED_INACTIVE` 策略**保留**
   （产品决策：最小化时只截 active tab，非技术限制）。

**防泄漏是核心**：`decrementCapturerCount` 必须进 `finally`，`capturePage` 抛异常也
不得泄漏（泄漏 = 该标签页永久持续渲染）。**`stayHidden` 必须 increment/decrement
配对一致**（只 increment 传 `stayHidden:true` 而 decrement 漏传，会把页面从 hidden
切回 visible，造成非预期可见性切换）。

```typescript
// src/main/modules/screenshot.ts
import fs from 'fs/promises';
import { accessSync, constants as fsConstants, existsSync } from 'fs';   // 同步探测仅限 getScreenshotDir（毫秒级）
import path from 'path';
import { app } from 'electron';
import log from 'electron-log';
import { getMainWindow } from './window';
import { tabManager } from './tabs';
import { loadConfig } from './config';
import { isPathWithinDirectory, sanitizeDownloadFilename } from '../utils/download-path';

export interface ScreenshotOptions {
  /** 区域截图（预留；本版不实现，仅 schema 预留） */
  rect?: { x: number; y: number; width: number; height: number };
  /** 是否落盘 PNG：true = 存默认目录；savePath 给出时存指定路径 */
  save?: boolean;
  /** 指定保存路径：必须位于截图目录内、扩展名为 .png（大小写不敏感）或自动追加 */
  savePath?: string;
  /** 是否回传 base64。false 时只返回 filePath/尺寸（UI 场景省数 MB IPC 载荷） */
  returnData?: boolean;
}

export interface ScreenshotResult {
  success: boolean;
  /** 失败错误码，见 §错误码 */
  code?: string;
  /** PNG base64（无 data: 前缀；returnData:false 时省略） */
  data?: string;
  filePath?: string;
  width?: number;
  height?: number;
  error?: string;
}

interface CapturerOptions {
  rect?: ScreenshotOptions['rect'];
  /** 捕获渲染尺寸（inactive 路径 = getContainerRect() 宽高，v20-T2 定稿回填） */
  size?: { width: number; height: number };
  /** 保持 Page Visibility hidden（仅 inactive 路径可能为 true） */
  stayHidden?: boolean;
}

async function captureWebContents(
  wc: Electron.WebContents,
  opts: CapturerOptions = {},
): Promise<{ image: Electron.NativeImage } | { error: string; code: string }> {
  wc.incrementCapturerCount(opts.size, opts.stayHidden);
  try {
    // 首帧等待策略（延迟/paint）由 v20-T3 定稿后回填此处
    const image = opts.rect ? await wc.capturePage(opts.rect) : await wc.capturePage();
    if (image.isEmpty()) return { code: 'EMPTY', error: 'Capture returned empty image' };
    return { image };
  } catch (e) {
    return { code: 'CAPTURE_FAILED', error: e instanceof Error ? e.message : String(e) };
  } finally {
    // stayHidden 必须与 increment 时配对一致（漏传会把页面从 hidden 切回 visible）
    wc.decrementCapturerCount(opts.stayHidden);
  }
}

export async function captureTab(tabId: string, opts: ScreenshotOptions): Promise<ScreenshotResult> {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return { success: false, code: 'NO_WINDOW', error: 'Main window is gone' };
  const wc = tabManager.getWebContents(tabId);
  if (!wc || wc.isDestroyed()) return { success: false, code: 'NO_TAB', error: 'Tab not found or has no BrowserView' };
  if (win.isMinimized() && !tabManager.isTabActive(tabId)) {
    return { success: false, code: 'MINIMIZED_INACTIVE', error: 'Cannot capture inactive tab while window is minimized' };
  }
  // 策略层在此决策 capturer 参数（不能写死无参，否则 v20-T2 验证通过的 size/stayHidden 不会被应用）：
  //   active（任意窗口状态）：无参 capturer；最小化时首帧等待内建于 captureWebContents（T3 定稿）
  //   inactive + 窗口可见：过门后 size = getContainerRect() 宽高、stayHidden = true（T2b/T2c 通过时）
  const isActive = tabManager.isTabActive(tabId);
  const capturerOpts: CapturerOptions = { rect: opts.rect };
  if (!isActive) {
    // 过门前（v20-T2 未定稿）：inactive 捕获不可用，显式报错而非返回 1×1 图；
    // 过门后替换为：
    //   capturerOpts.size = tabManager.getContainerRect() 宽高; capturerOpts.stayHidden = true
    return { success: false, code: 'HIDDEN_UNCAPTURABLE', error: 'Inactive tab capture pending v20 verification' };
  }
  const captured = await captureWebContents(wc, capturerOpts);
  if (!('image' in captured)) return { success: false, ...captured };
  const { image } = captured;
  const size = image.getSize();
  const result: ScreenshotResult = { success: true, width: size.width, height: size.height };
  if (opts.returnData !== false) result.data = image.toPNG().toString('base64');
  if (opts.save || opts.savePath) {
    const savePath = await resolveSavePath(tabId, opts.savePath);
    if (!savePath.ok) return { success: false, ...savePath };
    try {
      result.filePath = await writePng(image, savePath.value);
    } catch (e) {
      return {
        success: false, code: 'IO_ERROR',
        error: e instanceof Error ? e.message : String(e),
        width: size.width, height: size.height,
      };
    }
  }
  return result;
}

/** 截图目录：config.screenshotDir → Pictures/BaoFlashBrowser（存在且可写）→ userData/screenshots（兜底） */
export function getScreenshotDir(): string {
  const configured = loadConfig().screenshotDir;
  if (configured) return configured;
  try {
    const picDir = app.getPath('pictures');
    // 存在 + 可写双重探测：Pictures 可能是只读挂载（企业策略/光盘），落盘前必须确认
    if (picDir && existsSync(picDir)) {
      try { accessSync(picDir, fsConstants.W_OK); return path.join(picDir, 'BaoFlashBrowser'); } catch { /* 不可写，走兜底 */ }
    }
  } catch { /* getPath 不抛，兜底 */ }
  return path.join(app.getPath('userData'), 'screenshots');
}

/** 文件名 sanitize（不可信输入一律走） + 目录/扩展名校验。失败返回错误码（PATH_DENIED / INVALID_FILENAME）。 */
async function resolveSavePath(
  tabId: string,
  explicitPath?: string,
): Promise<{ ok: true; value: string } | { ok: false; code: string; error: string }> {
  const dir = getScreenshotDir();  // 单次求值，避免并发 set-dir 时拼接目录 ≠ 校验目录
  let fileName: string;
  if (explicitPath) {
    // 显式路径同样 sanitize：CON.png/NUL.png/控制字符会触发 EINVAL，错误码语义失真（v4 审计 P1）
    fileName = sanitizeDownloadFilename(path.basename(explicitPath));
    const ext = path.extname(fileName).toLowerCase();
    if (ext && ext !== '.png') {
      log.warn('[Screenshot] save path rejected (non-png):', path.basename(explicitPath));
      return { ok: false, code: 'INVALID_FILENAME', error: 'Save path must use .png extension' };
    }
    if (!ext) fileName += '.png';
  } else {
    // 默认文件名：tabId 来自 IPC，不可信输入，必须 sanitize（非法字符/保留名/长度）
    fileName = sanitizeDownloadFilename(`screenshot-${tabId}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
  }
  if (!fileName || fileName === 'download') {
    log.warn('[Screenshot] save filename invalid; tabId:', tabId.slice(0, 16));  // 脱敏：tabId 可能为注入串
    return { ok: false, code: 'INVALID_FILENAME', error: 'Sanitized filename is empty' };
  }
  const filePath = path.join(dir, fileName);
  if (!isPathWithinDirectory(dir, filePath)) {
    log.warn('[Screenshot] save path rejected (outside dir):', fileName);  // 只记录 basename，避免完整注入串
    return { ok: false, code: 'PATH_DENIED', error: 'Save path is outside the screenshot directory' };
  }
  return { ok: true, value: filePath };
}

async function writePng(image: Electron.NativeImage, filePath: string): Promise<string> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, image.toPNG());  // 指定 savePath 时直接覆盖同路径已有文件（见 §边界 12）
  return filePath;
}
```

> **P1 修复说明（v4 审计）**：默认文件名与显式 `savePath` 的 basename **一律**经
> `sanitizeDownloadFilename`（Windows 保留名 CON/NUL 等 → 前缀 `_`、控制字符 → `_`、
> 超长截断），扩展名白名单仅 `.png`（大小写不敏感），无扩展名自动追加；
> 目录越界 → `PATH_DENIED`（isPathWithinDirectory 的 realpathSync 归一化，
> `..`/symlink 逃逸在 join/realpath 阶段即被识别）。

## IPC 接口

`src/main/ipc/screenshot.ipc.ts`。**所有通道注册在 `registerScreenshotIPC(getWin)`
函数体内**（与 tabs/download/password 的 registerXIPC 模式一致；不允许模块顶层注册）。
`src/main/index.ts` 中**立即注册**（与 `registerWindowIPC` 同行；截图 IPC 无重型初始化，
不需 setImmediate 延迟）。

| 通道 | 入参 | 说明 |
|------|------|------|
| `screenshot:capture` | `{ tabId, save?, savePath?, returnData?, rect? }` | 任意标签页 |
| `screenshot:capture-active` | `{ save?, savePath?, returnData?, rect? }` | 便捷：内部取 activeId 后走 captureTab |
| `screenshot:reveal` | `{ filePath }` | 定位文件到资源管理器；filePath 须位于截图目录内且存在 |
| `screenshot:set-dir` | 无参（裸 `ipcMain.handle`） | 弹目录选择框 + 可写性/userData 探测，成功即持久化 |

```typescript
// src/main/ipc/screenshot.ipc.ts
import fs from 'fs';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import log from 'electron-log';
import { z } from 'zod';
import { createValidatedHandler } from '../utils/ipc-wrapper';
import { captureTab, getScreenshotDir } from '../modules/screenshot';
import { tabManager } from '../modules/tabs';
import { saveConfig } from '../modules/config';
import { isPathWithinDirectory } from '../utils/download-path';

const rectSchema = z.object({
  x: z.number().finite(), y: z.number().finite(),
  width: z.number().finite().min(1), height: z.number().finite().min(1),
});
const commonSchema = {
  save: z.boolean().optional(),
  savePath: z.string().max(32767).optional(),   // 对齐 download 上限
  returnData: z.boolean().optional(),
  rect: rectSchema.optional(),
};

export function registerScreenshotIPC(getWin: () => BrowserWindow | null): void {
  // 全部通道在函数体内注册（项目 registerXIPC 模式）
  createValidatedHandler('screenshot:capture',
    z.object({ tabId: z.string().min(1).max(128), ...commonSchema }).strict(),
    (args) => captureTab(args.tabId, args));
  createValidatedHandler('screenshot:capture-active',
    z.object(commonSchema).strict(),
    (args) => {
      const activeId = tabManager.getActiveId();
      if (!activeId) return { success: false, code: 'NO_ACTIVE_TAB', error: 'No active tab' };
      return captureTab(activeId, args);
    });

  // Electron 11: showItemInFolder 返回 void 不抛异常 → existsSync 前置（同步查询毫秒级，可接受）
  createValidatedHandler('screenshot:reveal',
    z.object({ filePath: z.string().min(1).max(32767) }).strict(),
    ({ filePath }) => {
      const dir = getScreenshotDir();
      if (!isPathWithinDirectory(dir, filePath)) {
        return { success: false, code: 'PATH_DENIED', error: 'Path outside screenshot directory' };
      }
      if (!fs.existsSync(filePath)) {
        return { success: false, code: 'REVEAL_FAILED', error: 'File does not exist' };
      }
      shell.showItemInFolder(filePath);
      return { success: true };
    });

  // set-dir 用裸 ipcMain.handle（与 download:set-dir 同模式）：需要 getWin 闭包（dialog 父窗口），
  // 且无参通道不需要 zod 校验。createHandler 的统一错误包装在此不生效 → 必须手动 try/catch + log。
  ipcMain.handle('screenshot:set-dir', async () => {
    try {
      const win = getWin() ?? BrowserWindow.getFocusedWindow();
      if (!win) {
        log.warn('[Screenshot] set-dir aborted (no window)');
        return { success: false, code: 'NO_WINDOW', error: 'No window available' };
      }
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: getScreenshotDir(),
        title: '选择截图保存目录',
      });
      if (result.canceled || !result.filePaths[0]) return { success: true, canceled: true };  // 用户取消，无需留痕
      const dir = result.filePaths[0];
      // 可写性探测：只读目录（如 C:\Program Files）后续 writePng 会全部 EPERM，必须当场拒绝
      try {
        await fs.promises.access(dir, fs.constants.W_OK);
      } catch {
        log.warn('[Screenshot] set-dir rejected (not writable):', dir);
        return { success: false, code: 'DIR_NOT_WRITABLE', error: 'Selected directory is not writable', dir };
      }
      // 禁止 userData 作为截图目录（防御性编码，见 §边界 8）
      if (isPathWithinDirectory(app.getPath('userData'), dir)) {
        log.warn('[Screenshot] set-dir rejected (within userData):', dir);
        return { success: false, code: 'DIR_DENIED', error: 'Screenshots directory cannot be within userData', dir };
      }
      saveConfig({ screenshotDir: dir });
      log.info('[Screenshot] directory changed to:', dir);
      return { success: true, dir };
    } catch (e) {
      log.error('[Screenshot] set-dir failed:', e instanceof Error ? e.message : e);
      return { success: false, code: 'SET_DIR_FAILED', error: e instanceof Error ? e.message : String(e) };
    }
  });
}
```

## Preload 暴露

- `ALLOWED_INVOKE_CHANNELS` 追加：`'screenshot:capture'`, `'screenshot:capture-active'`,
  `'screenshot:reveal'`, `'screenshot:set-dir'`。
- `electronAPI.screenshot`：

```typescript
screenshot: {
  capture: (tabId: string, opts?: ScreenshotOptions) => safeInvoke('screenshot:capture', { tabId, ...opts }),
  captureActive: (opts?: ScreenshotOptions) => safeInvoke('screenshot:capture-active', { ...opts }),
  reveal: (filePath: string) => safeInvoke('screenshot:reveal', { filePath }),
  setDir: () => safeInvoke('screenshot:set-dir'),
},
```

- `src/renderer/types/electron.d.ts` 补 `ScreenshotResult` / `ScreenshotOptions` 类型。

## 配置

**五处同步**（`config.ts`，对照 `downloadDir`）：`interface Config`、`DEFAULT_CONFIG`
（默认 `''`）、`schema`、`loadConfig()`、`saveConfig()`。
`screenshot:set-dir` 调 `saveConfig({ screenshotDir: dir })` **即时持久化**（不依赖
SettingsPanel 的保存按钮）。

**`config.ipc.ts` 的 `save-config` schema 补 `screenshotDir`，并对路径字段加约束**
（v4 审计 P2；实现需**新增 import**：`import { app } from 'electron'` +
`import { isPathWithinDirectory } from '../utils/download-path'`）：

```typescript
// 关键语义（v5 审计）：
//   - z.string() 接受 ''（空串是合法 string，z.string().min(1) 才拒绝）；refine 的 !dir 放行 '' 与
//     optional() 放行 undefined 是两个独立分支，均为"未设置目录"语义，不得合并误判。
//   - refine 内的 realpathSync 为同步 IO：save-config 仅由 SettingsPanel 保存按钮触发（渲染层唯一
//     调用点），频率受用户操作限制，不构成 DoS；无按钮 UI 之外的自动调用路径。
const pathRefine = (field: string) =>
  z.string().max(32767).optional().refine(
    (dir) => !dir || !isPathWithinDirectory(app.getPath('userData'), dir),
    { message: `${field} must not be within userData` },
  );
// 原 schema 中：downloadDir: pathRefine('downloadDir'), 新增 screenshotDir: pathRefine('screenshotDir'),
// 其余字段不变。screenshotDir 属本功能范围必做；downloadDir 为附带一致性修复（既有通道现无约束）。
```

## UI（次要入口）

**TopBar 工具栏截图按钮**：
1. 调 `screenshot.captureActive({ save: true, returnData: false })` — 不回收 base64
2. 成功后 toast：文件名 + "打开文件夹"（调 `screenshot.reveal(filePath)`）
3. 失败（如 `MINIMIZED_INACTIVE`）按错误码 toast 提示
4. 快捷键本次不做（后续一行代码可加）

**SettingsPanel 截图目录行**（SettingsPanel 无目录选择先例，自实现）：
1. `MainConfigForm` 补 `screenshotDir: string`；**初始化放入现有 `config.get()` 的
   同一 useEffect**（SettingsPanel.tsx:61-110 附近），取 `cfg.screenshotDir ?? ''`
   （空 = 默认目录）
2. 行内：当前目录显示 + "选择…"按钮 → `screenshot.setDir()`：
   - `{ success, dir }`：`setMainForm({ ...prev, screenshotDir: dir })` + toast 成功
   - `DIR_NOT_WRITABLE` / `DIR_DENIED` / `SET_DIR_FAILED`：toast 错误，保持原值
   - `canceled`：无操作
3. **持久化语义（v4 审计 P1）**：目录持久化走 `screenshot:set-dir` 即时写入
   electron-store；`handleSave` 的 `save-config` 调用补
   `screenshotDir: mainForm.screenshotDir` 仅作**兜底同步**（值已被 set-dir 持久化，
   重复写无害；若用户未经按钮直接改 state 则不成立——本设计不允许该路径）。
   `save-config` schema 补 `screenshotDir`（见 §配置）。

## 错误码

> **脚注（调用方必读）**：`createValidatedHandler` 在 **zod schema 校验失败时抛出**
> `Error: Invalid arguments for <channel>`（ipc-wrapper.ts:28-29），经 safeInvoke 表现为
> **Promise rejection**，而非结构化 `{ success:false, code, error }`。自动化脚本调用方
> 须同时处理两种失败形态（TypeScript 类型 `Promise<ScreenshotResult>` 不覆盖此场景）。

| code | 含义 |
|------|------|
| `NO_WINDOW` | 主窗口不存在/已销毁（captureTab），或对话框无父窗口（set-dir） |
| `NO_TAB` | tabId 不存在或无 BrowserView（newtab/userscripts 页无 view） |
| `NO_ACTIVE_TAB` | capture-active 无活跃标签页 |
| `MINIMIZED_INACTIVE` | 窗口最小化时截非激活标签页（设计决定：不支持） |
| `HIDDEN_UNCAPTURABLE` | 验证门回填：可见窗口截非激活标签页若 size 路径不可用则报此错 |
| `PATH_DENIED` | savePath/filePath 超出截图目录（realpathSync 归一化后判定） |
| `INVALID_FILENAME` | tabId/savePath sanitize 后无合法文件名，或扩展名非 `.png` |
| `DIR_NOT_WRITABLE` | set-dir 所选目录不可写（`fs.promises.access(W_OK)` 探测失败） |
| `DIR_DENIED` | set-dir 所选目录位于 userData 内 |
| `SET_DIR_FAILED` | set-dir 异常兜底（dialog/saveConfig 抛错） |
| `EMPTY` | capturePage 返回空图 |
| `CAPTURE_FAILED` | capturePage 抛异常 |
| `IO_ERROR` | 落盘失败（目录/权限等 IO 层错误） |
| `REVEAL_FAILED` | reveal 目标文件不存在（目录越界走 `PATH_DENIED`；Electron 11 `showItemInFolder` 不抛异常，存在性检查是唯一失败点） |

## 验证门 — v20 demo

`tests/electron/screenshot-v20-gate.cjs`（Electron 冒烟，Flash 页面，仿 v18/v19 结构）。
**关键：capturer 的 size/stayHidden 变体必须成组对照，通过标准精确到尺寸与
visibilityState，否则结论无法回填。**

| 用例 | 场景 | 变体 | 通过标准 |
|------|------|------|----------|
| T1 | visible + capturer（基准） | 无参 | 非空且 size = view 尺寸 |
| T2a | hidden 1×1 + capturer | 无参 | 记录尺寸；预期 ≤2×2 且非空（空则记 EMPTY） |
| T2b | hidden 1×1 + capturer | `size:{width:1280,height:720}` | 记录尺寸；**≥ 1280×720−1px 容差 → "hidden + size 参数可用"** |
| T2c | hidden 1×1 + capturer | `size:{1280,720}, stayHidden:true` | 同 T2b；且 capture 后 `executeJavaScript` 查 `document.visibilityState === 'hidden'`（stayHidden 生效侧证；**查询须 try/catch**——Ruffle 上下文与插件页差异不应让断言挂掉测试） |
| T3a | minimized + visible bounds + capturer | 无等待立即 capture | 记录空/全 + 尺寸 |
| T3b | minimized + visible bounds + capturer | 延迟 100ms 后 capture | 记录空/全 + 尺寸 |
| T4 | minimized + hidden（对照） | 无参 | 记录结果，印证 MINIMIZED_INACTIVE 策略合理性 |

T2 系列决定 hidden 捕获参数（回填 §捕获策略决策点 1 与 `captureTab` 的
size/stayHidden 传入，size 取 `getContainerRect()`）；T3 系列决定最小化首帧等待
策略（回填 `captureWebContents`）；T4 印证错误路径。全部回填后设计定稿。

## 边界与注意

1. **loading 中截图**：调用方负责时机（自动化可先等 `did-stop-loading`）；模块不等待。
2. **最小化首帧**：最小化时页面停止合成，capturer 只标记可见，不触发同步重绘；
   首帧策略由 v20-T3 定稿（延迟或 `paint` 事件），未定稿前不得直接判定 T3 失败。
3. **最小化/恢复瞬态竞态**：`isMinimized()` 判定与截图执行之间存在系统动画窗口；
   策略只保证"最小化 + 非激活"拒绝。若 v20-T3 显示最小化 + capturer 成功率不稳定，
   降级选项：最小化时一律 `MINIMIZED_INACTIVE`（含 active）或要求调用方显式确认。
4. **Ruffle 标签页**：与 PPAPI 同路径，无特殊处理（`capturePage` 与引擎无关）。
5. **HiDPI**：`capturePage` 返回设备像素尺寸，`width/height` 如实返回，调用方自行缩放。
6. **base64 体积**：PNG base64 可达 ~11MB（4K）；UI 走 `returnData:false`。若后续需要
   更小载荷可加 `format: 'jpeg'`。
7. **并发截图**：同一 wc 的 increment 计数可叠加（Electron 计数语义），finally 配对即可。
8. **路径安全**：`savePath`/`reveal` 的 `filePath` 均须落在截图目录内；
   **symlink 逃逸已由 `isPathWithinDirectory` 的 realpathSync 归一化挡住**
   （download-path.ts:40 对 existing ancestor 做 realpath，目录内 symlink 指向目录外
   会被解析后拒绝——实现者不得为"性能"去掉该归一化）。默认文件名 tabId 与显式
   savePath basename 一律 `sanitizeDownloadFilename`。**禁止 userData 作为
   screenshotDir**（set-dir 的 `DIR_DENIED` + save-config refine 双防线）。
   userData 的**上级目录**（如 %APPDATA%）不禁止——属用户主动选择，与 downloadDir
   既有行为一致，不加反向检查。
9. **依赖**：本模块不重复注入 SWF CSS 修复（tabs.ts 已按导航自动处理）；截图内容依赖
   该修复已生效。
10. **Electron 版本锁死**：Electron 11.5.0 支持 `incrementCapturerCount(size, stayHidden)`
    （Electron 23+ 移除，本项目永不升级）；`stayHidden` 须 increment/decrement 配对一致。
11. **同步 IO 禁用**：落盘一律 `fs/promises`；允许的同步探测仅限毫秒级且低频：
    `reveal` 的 `existsSync`、`getScreenshotDir()` 的 `existsSync`+`accessSync`
    （启动/配置变更时求值）、set-dir 的 `fs.promises.access`（已异步）。
12. **重名覆盖语义**：`savePath` 指定时 `fs.writeFile` **直接覆盖**同路径已有文件；
    默认文件名含毫秒时间戳近似唯一，但**同一毫秒内同 tabId 两次截图会重名覆盖**
    （自动化高频截图场景）；需要确定性去重时：调用方传唯一 savePath，或回填时加
    `existsSync` 前置并复用 `availableSavePath`。
13. **`getScreenshotDir()` 单次求值**：captureTab/reveal/set-dir 内同一逻辑调用只求值
    一次存入局部变量，避免与并发 `set-dir` 的"拼接目录 ≠ 校验目录"窗口。
14. **Pictures 兜底**：Linux 无 XDG 配置时 `app.getPath('pictures')` 可能为空/不可用；
    `getScreenshotDir()` fallback 到 `userData/screenshots`（可写性有保证，与
    download 的 fallback 思路一致）。所有路径落点必须有 fallback，避免 EPERM 时
    无法定位根因。

## 调试 HTTP 口子（方案 A，2026-08-08 实施）

**目的**：AI/自动化从外部主动触发**运行中实例**截图（IPC 通道只能由渲染进程或主进程
代码内调用，外部无入口）。

**启用条件（双重门）**：仅 `!app.isPackaged` 且 `process.env.BAO_SCREENSHOT_HTTP === '1'`
（`src/main/index.ts`）。**打包发行版不监听任何端口，零攻击面**。

```powershell
$env:BAO_SCREENSHOT_HTTP = "1"
npm start
```

启动日志（`%APPDATA%\bao-flash-browser\logs\main.log`）打印：

```
[Screenshot HTTP] debug server ready: http://127.0.0.1:44123/screenshot (X-BAO-Token: <32位hex>)
```

**API**（`POST http://127.0.0.1:44123/screenshot`，回环绑定）：

```powershell
# 截当前激活标签页 → 存默认目录（Pictures/BaoFlashBrowser），不回收 base64
curl.exe -X POST http://127.0.0.1:44123/screenshot -H "X-BAO-Token: <token>" -d '{"save":true,"returnData":false}'

# 截指定标签页 → 返回 base64（不带 data: 前缀）
curl.exe -X POST http://127.0.0.1:44123/screenshot -H "X-BAO-Token: <token>" -d '{"tabId":"tab-xxx","returnData":true}'

# 其他参数与 IPC 通道一致：savePath（须在截图目录内、.png）、rect
```

响应：`ScreenshotResult` JSON（`{ success, code?, data?, filePath?, width?, height?, error? }`）；
成功 HTTP 200，失败（NO_TAB/EMPTY/PATH_DENIED 等）HTTP 400；`tabId` 缺省 = 激活标签页，
无激活页 → `NO_ACTIVE_TAB`。

**安全防线**（均已在 `src/main/modules/screenshot-http.ts` 实现，`tests/screenshot-http.test.ts` 覆盖）：

| 防线 | 实现 |
|------|------|
| 仅回环 | 绑定 `127.0.0.1` + 请求校验 `remoteAddress`（拒绝非回环） |
| 随机 token | 启动时生成 32 位 hex，仅存内存（可用 `BAO_SCREENSHOT_TOKEN` 固定） |
| 网页侧 CSRF | token 走 `X-BAO-Token` 自定义 header → 浏览器 preflight 被拒；响应无 `Access-Control-Allow-*` |
| 无 GET 副作用 | 仅接受 `POST /screenshot`，body ≤ 16KB |
| 写入限制 | 复用 captureTab 既有防线（sanitize + `.png` 白名单 + `isPathWithinDirectory`） |

**威胁模型边界**：防"网页盲发/误触发/无意的越权读取"；**防不了同用户恶意进程**
（它本就能读 userData、能截桌面）——本地方案（含 CLI 变体）均如此。

**实测记录（2026-08-08）**：运行中实例最小化/可见状态下均调用成功（1848×1076 =
窗口内容 × DPR；文件 1.9MB 落盘默认目录；base64 模式 dataLen 2.5MB）；newtab 页
返回 `NO_TAB`（已知限制，见头部 v6 增补）。

## 测试

| 层 | 内容 |
|----|------|
| vitest 单测 | `tests/screenshot-policy.test.ts`：策略决策纯函数（窗口状态 × 标签状态 → 决策/错误码）、默认文件名格式、**tabId 含 `..`/`\`/`:`/`CON` 的 sanitize**、**显式 savePath `CON.png`/控制字符 sanitize**、**savePath 非 `.png` 扩展名拒绝**、**getScreenshotDir 三档 fallback**、`isPathWithinDirectory` 拒绝目录外 savePath；`tests/screenshot-http.test.ts`：token 校验（缺失/错误 401）、路径/方法限制（404）、坏 JSON（400）、tabId 缺省取激活页、参数透传、失败码透传、无 token 不触发截图 |
| Electron 冒烟 | v20 验证门；v21 生产路径冒烟（最小化 + 落盘默认目录，实测通过） |
| 静态检查 | `npm run typecheck` + `npm run lint` |

## 后续优化（本次不做，YAGNI）

- 区域截图（rect 参数与 schema 已预留）
- 定时截图 / 截图历史 / 标注编辑
- 快捷键
- JPEG 格式
- 重名文件自动去重（复用 `availableSavePath`）
- "打开截图"入口（savePath 扩展名白名单已前置防线，拒绝非 `.png`）
