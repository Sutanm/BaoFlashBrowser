# 截图功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 BaoFlashBrowser 实现程序化截图能力（IPC 接口供自动化脚本/AI 使用 + 工具栏按钮 + 设置页截图目录），含 v20 验证门决定隐藏标签页捕获参数。

**Architecture:** 新建 `src/main/modules/screenshot.ts`（纯捕获原语 + 策略编排 + 文件名 sanitize + 路径校验），`tabManager` 暴露 4 个公共方法，`screenshot.ipc.ts` 注册 4 个通道（全在 `registerScreenshotIPC(getWin)` 函数体内），preload 白名单 + `electronAPI.screenshot`，TopBar 按钮 + SettingsPanel 目录行。技术假设由 `tests/electron/screenshot-v20-gate.cjs` 验证后回填两个常量。

**Tech Stack:** Electron 11.5.0（Chromium 87，永不升级）、TypeScript、zod、vitest、esbuild main + Vite renderer、typesafe-i18n（字典 GBK 编码！）、lucide-react、zustand。

## Global Constraints

- **Electron 锁死 11.5.0**：`incrementCapturerCount(size?, stayHidden?)` / `decrementCapturerCount(stayHidden?)` 可用（23+ 移除）。`shell.showItemInFolder` 返回 `void` 不抛异常。
- **`decrementCapturerCount` 必须与 increment 的 `stayHidden` 配对一致**，且必须进 `finally`（防捕获计数泄漏 = 页面永久渲染）。
- **路径安全**：savePath/默认文件名一律 `sanitizeDownloadFilename` + 扩展名白名单 `.png`；目录越界 `isPathWithinDirectory`（realpathSync 归一化，不得去掉）。
- **i18n 字典文件为 GBK(CP936) 编码**（`src/renderer/i18n/zh-CN/index.ts`、`en/index.ts`、`i18n-types.ts`）——**禁止用 UTF-8 编辑工具直接改写**，必须用 PowerShell GBK 编码读写；`npm run i18n` 生成器保持输入编码。
- **IPC 模式**：所有通道注册在 `registerXIPC()` 函数体内；无参通道用 `z.undefined()`；zod 校验失败抛 `Invalid arguments for <channel>`（Promise rejection）。
- **测试**：vitest 单测须 `vi.mock` electron 依赖模块（先例 `tests/password-capture-binding.test.ts`）；策略逻辑抽纯函数测试。
- **提交**：本仓库 AGENTS.md 规定"未经用户明确要求不得 commit"——每个任务末尾的 commit 步骤执行前须先询问用户。
- 验证命令：`npm test -- --run`（vitest）、`npm run typecheck`、`npm run lint`、`npm run i18n`。
- 状态验证门常量位于 `src/main/modules/screenshot.ts` 模块顶部（Task 3 创建，Task 7 回填）。

---

### Task 1: v20 验证门 demo

**Files:**
- Create: `tests/electron/screenshot-v20-gate.cjs`
- Create（运行产物，不进 git）: `release/screenshot-test/v20-*.png`、`release/screenshot-test/v20-results.md`

**Interfaces:**
- Consumes: 无（独立 Electron 冒烟脚本；Flash DLL 在 `plugins/win64/pepflashplayer64.dll`，SWF 在 `tests/sample-swf-files-sample_1280x720.swf`，均存在）
- Produces: `release/screenshot-test/v20-results.md`（Task 7 依据此文件回填常量）

- [ ] **Step 1: 写 demo 脚本**

```javascript
// tests/electron/screenshot-v20-gate.cjs
/**
 * v20 - 验证门：capturer size/stayHidden 变体 + 最小化首帧等待
 * T1   visible + capturer（基准）
 * T2a  hidden 1x1 + capturer（无参）
 * T2b  hidden 1x1 + capturer({size:1280x720})
 * T2c  hidden 1x1 + capturer({size:1280x720, stayHidden:true}) + visibilityState 侧证
 * T3a  minimized + visible + capturer（立即 capture）
 * T3b  minimized + visible + capturer（延迟 100ms）
 * T4   minimized + hidden（对照）
 */
const { app, BrowserView, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');

const FLASH_PLUGIN_PATH = path.join(__dirname, '..', '..', 'plugins', 'win64', 'pepflashplayer64.dll');
app.commandLine.appendSwitch('ppapi-flash-path', FLASH_PLUGIN_PATH);
app.commandLine.appendSwitch('ppapi-flash-version', '34.0.0.330');

const OUTPUT_DIR = path.join(__dirname, '..', '..', 'release', 'screenshot-test');
const RESULTS_FILE = path.join(OUTPUT_DIR, 'v20-results.md');
const SWF_PATH = path.join(__dirname, '..', 'sample-swf-files-sample_1280x720.swf');
const timeout = setTimeout(() => { console.error('[v20] timed out (120s)'); app.exit(1); }, 120000);

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function capture(view, opts = {}) {
  const { size, stayHidden, waitMs = 0 } = opts;
  const wc = view.webContents;
  wc.incrementCapturerCount(size, stayHidden);
  try {
    if (waitMs > 0) await delay(waitMs);
    const image = await wc.capturePage();
    return image;
  } finally {
    wc.decrementCapturerCount(stayHidden);
  }
}

async function visibilityState(view) {
  try {
    const state = await view.webContents.executeJavaScript('document.visibilityState');
    return String(state);
  } catch (e) {
    return 'QUERY_FAILED: ' + e.message;
  }
}

function record(results, label, image, extra) {
  const size = image.isEmpty() ? { width: 0, height: 0 } : image.getSize();
  const row = { label, empty: image.isEmpty(), width: size.width, height: size.height, ...extra };
  results.push(row);
  console.log(`  ${label}: empty=${row.empty} size=${row.width}x${row.height}${extra ? ' ' + JSON.stringify(extra) : ''}`);
  if (!image.isEmpty()) {
    const safe = label.replace(/[^A-Za-z0-9_-]/g, '-');
    fs.writeFileSync(path.join(OUTPUT_DIR, `v20-${safe}.png`), image.toPNG());
  }
  return row;
}

app.whenReady().then(async () => {
  ensureDir(OUTPUT_DIR);
  ipcMain.on('get-ruffle-mode', (e) => { e.returnValue = false; });
  if (!fs.existsSync(SWF_PATH)) { console.error('[v20] SWF not found:', SWF_PATH); app.exit(1); }

  const WIN_W = 1280, WIN_H = 720;
  const win = new BrowserWindow({ show: true, width: WIN_W, height: WIN_H, x: 100, y: 100, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  const view = new BrowserView({ webPreferences: { plugins: true, contextIsolation: false, nodeIntegration: false, partition: 'persist:v20' } });
  win.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, width: WIN_W, height: WIN_H });

  await new Promise((resolve) => {
    view.webContents.once('did-finish-load', resolve);
    view.webContents.once('did-fail-load', (_e, code, desc) => { console.error('[v20] load failed:', code, desc); resolve(); });
    view.webContents.loadURL('file:///' + SWF_PATH.replace(/\\/g, '/'));
  });
  await delay(3000);

  const results = [];
  const HIDDEN = { x: -9999, y: -9999, width: 1, height: 1 };

  console.log('\n[V20] T1 visible + capturer (baseline)');
  record(results, 'T1-visible', await capture(view), { note: 'baseline' });

  console.log('\n[V20] T2a hidden + capturer (no args)');
  view.setBounds(HIDDEN); await delay(500);
  record(results, 'T2a-hidden-noarg', await capture(view), { note: 'expected <=2x2 or empty' });

  console.log('\n[V20] T2b hidden + capturer(size)');
  record(results, 'T2b-hidden-size', await capture(view, { size: { width: WIN_W, height: WIN_H } }), { note: 'pass if >=1279x719' });

  console.log('\n[V20] T2c hidden + capturer(size, stayHidden)');
  const imgT2c = await capture(view, { size: { width: WIN_W, height: WIN_H }, stayHidden: true });
  record(results, 'T2c-hidden-size-stay', imgT2c, { note: 'pass if >=1279x719', visibilityState: await visibilityState(view) });

  view.setBounds({ x: 0, y: 0, width: WIN_W, height: WIN_H }); await delay(500);

  console.log('\n[V20] T3a minimized + visible + capturer (immediate)');
  win.minimize(); await delay(800);
  record(results, 'T3a-minimized-immediate', await capture(view), { note: 'no wait' });

  console.log('\n[V20] T3b minimized + visible + capturer (100ms wait)');
  record(results, 'T3b-minimized-wait100', await capture(view, { waitMs: 100 }), { note: 'first-frame wait' });
  win.restore(); await delay(500);

  console.log('\n[V20] T4 minimized + hidden (control)');
  win.minimize(); await delay(800);
  view.setBounds(HIDDEN); await delay(300);
  record(results, 'T4-minimized-hidden', await capture(view), { note: 'control: expected empty' });
  win.restore();

  const md = [
    '# v20 Verification Gate Results',
    '',
    'Run at: ' + new Date().toISOString(),
    '',
    '| case | empty | width | height | extra |',
    '|------|-------|-------|--------|-------|',
    ...results.map((r) => `| ${r.label} | ${r.empty} | ${r.width} | ${r.height} | ${JSON.stringify(r.extra || {})} |`),
    '',
    '## Verdicts (Task 7 回填依据)',
    '',
    '- T2b or T2c width>=1279 && height>=719 → HIDDEN_CAPTURE_ENABLED = true（T2c 通过则 HIDDEN_CAPTURE_STAY_HIDDEN = true，仅 T2b 通过则 false）',
    '- T3b (empty=false, size 全尺寸) 且 T3a empty=true → FIRST_FRAME_DELAY_MS = 100',
    '- T3b 与 T3a 同为 full → FIRST_FRAME_DELAY_MS = 0',
    '- T4 empty=true → MINIMIZED_INACTIVE 策略合理；若 T4 非空则需重新评估该策略',
    '',
  ];
  fs.writeFileSync(RESULTS_FILE, md.join('\n'));
  console.log('\n[V20] results written to:', RESULTS_FILE);
  console.log('\n[V20] FINAL VERDICT LINE (copy to Task 7):');
  const verdict = results.find((r) => r.label === 'T2b-hidden-size') || results[0];
  console.log('T2b full-size:', verdict.width >= 1279 && verdict.height >= 719, `(${verdict.width}x${verdict.height})`);

  clearTimeout(timeout);
  app.exit(0);
}).catch((e) => { console.error('[v20] failed:', e); clearTimeout(timeout); app.exit(1); });
```

- [ ] **Step 2: 运行 demo**

Run: `npx electron tests/electron/screenshot-v20-gate.cjs`
Expected: 控制台输出 7 个用例的空/尺寸记录；`release/screenshot-test/v20-results.md` 生成；非空用例产出 `v20-*.png`。若 T2b 输出 `1x1` 或 empty 属预期（记录即可，不判失败）。

- [ ] **Step 3: 阅读结果并记录判定**

Run: `Get-Content release/screenshot-test/v20-results.md`
Expected: 记录四个判定结论（T2b/T2c 是否全尺寸、T3a/T3b 差异、T4 是否空）。这些值在 Task 7 使用。若本机无法运行 Electron 冒烟（无窗口环境），把脚本保留并把结果文件标注 `UNVERIFIED`，Task 7 按"最可能值"回填并在 commit message 注明。

- [ ] **Step 4: 询问用户后提交**

```bash
git add tests/electron/screenshot-v20-gate.cjs
git commit -m "test: add screenshot v20 verification gate demo"
```

---

### Task 2: TabManager 公共 API

**Files:**
- Modify: `src/main/modules/tabs.ts`（在 `getRuffleForWC`（L53-57）之后插入 4 个方法）

**Interfaces:**
- Consumes: 无（全部基于既有 `tabs`/`wcToId`/`activeId`/`rect` private 字段）
- Produces（Task 3 依赖）:
  - `tabManager.getActiveId(): string | null`
  - `tabManager.getWebContents(tabId: string): Electron.WebContents | null`
  - `tabManager.isTabActive(tabId: string): boolean`
  - `tabManager.getContainerRect(): { x: number; y: number; width: number; height: number }`

- [ ] **Step 1: 添加方法**

在 `getRuffleForWC` 方法后（第 57 行 `}` 之后）插入：

```typescript
  getActiveId(): string | null {
    return this.activeId;
  }

  getWebContents(tabId: string): Electron.WebContents | null {
    const tab = this.tabs.get(tabId);
    const wc = tab?.browserView?.webContents;
    if (!wc || wc.isDestroyed()) return null;
    return wc;
  }

  isTabActive(tabId: string): boolean {
    return this.activeId === tabId;
  }

  getContainerRect(): ContainerRect {
    return { ...this.rect };
  }
```

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: PASS（无新增错误；`ContainerRect` 为本文件已定义接口）

- [ ] **Step 3: 询问用户后提交**

```bash
git add src/main/modules/tabs.ts
git commit -m "feat: expose tabManager public API for screenshot module"
```

---

### Task 3: screenshot.ts 核心模块 + 策略单测

**Files:**
- Create: `src/main/modules/screenshot.ts`
- Create: `tests/screenshot-policy.test.ts`

**Interfaces:**
- Consumes:
  - `tabManager.getActiveId()` / `getWebContents(tabId)` / `isTabActive(tabId)` / `getContainerRect()`（Task 2）
  - `getMainWindow()`（`src/main/modules/window.ts`）
  - `loadConfig()`（`src/main/modules/config.ts`）
  - `isPathWithinDirectory` / `sanitizeDownloadFilename`（`src/main/utils/download-path.ts`）
- Produces:
  - `captureTab(tabId: string, opts: ScreenshotOptions): Promise<ScreenshotResult>`
  - `getScreenshotDir(): string`（Task 5 依赖）
  - `ScreenshotOptions` / `ScreenshotResult` 类型（Task 5/6 依赖）
  - `decideCapture(input: DecideInput): CaptureDecision`（本任务测试对象）

- [ ] **Step 1: 写失败测试**

```typescript
// tests/screenshot-policy.test.ts
// @vitest-environment node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decideCapture, getScreenshotDir, type DecideInput } from '../src/main/modules/screenshot';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

const base: DecideInput = { hasWindow: true, minimized: false, hasWebContents: true, isActive: true, hiddenCaptureEnabled: false };

describe('capture policy decisions', () => {
  it('captures the active tab in any window state', () => {
    expect(decideCapture({ ...base, minimized: true })).toEqual({ action: 'capture' });
    expect(decideCapture(base)).toEqual({ action: 'capture' });
  });

  it('rejects when window or tab is gone', () => {
    expect(decideCapture({ ...base, hasWindow: false }).action).toBe('error');
    expect(decideCapture({ ...base, hasWebContents: false }).action).toBe('error');
  });

  it('rejects inactive tab while minimized', () => {
    const d = decideCapture({ ...base, isActive: false, minimized: true });
    expect(d.action).toBe('error');
    if (d.action === 'error') expect(d.code).toBe('MINIMIZED_INACTIVE');
  });

  it('rejects inactive tab when hidden capture is not verified yet', () => {
    const d = decideCapture({ ...base, isActive: false, minimized: false, hiddenCaptureEnabled: false });
    expect(d.action).toBe('error');
    if (d.action === 'error') expect(d.code).toBe('HIDDEN_UNCAPTURABLE');
  });

  it('allows inactive tab once hidden capture is enabled', () => {
    expect(decideCapture({ ...base, isActive: false, minimized: false, hiddenCaptureEnabled: true })).toEqual({ action: 'capture' });
  });
});

describe('screenshot directory resolution', () => {
  it('prefers configured directory', () => {
    vi.mock('../src/main/modules/config', () => ({ loadConfig: () => ({ screenshotDir: 'C:\\shots' }) }));
    vi.mock('electron', () => ({ app: { getPath: () => { throw new Error('unexpected'); } } }));
    vi.mock('../src/main/modules/window', () => ({ getMainWindow: () => null }));
    vi.mock('../src/main/modules/tabs', () => ({ tabManager: {} }));
    const { getScreenshotDir: resolve } = require('../src/main/modules/screenshot');
    expect(resolve()).toBe('C:\\shots');
  });

  it('falls back to Pictures/BaoFlashBrowser when pictures exists and is writable', () => {
    const pic = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-pic-'));
    tempDirs.push(pic);
    vi.mock('../src/main/modules/config', () => ({ loadConfig: () => ({ screenshotDir: '' }) }));
    vi.mock('electron', () => ({ app: { getPath: (name: string) => (name === 'pictures' ? pic : path.join(os.tmpdir(), 'bao-ud')) } }));
    vi.mock('../src/main/modules/window', () => ({ getMainWindow: () => null }));
    vi.mock('../src/main/modules/tabs', () => ({ tabManager: {} }));
    const { getScreenshotDir: resolve } = require('../src/main/modules/screenshot');
    expect(resolve()).toBe(path.join(pic, 'BaoFlashBrowser'));
  });

  it('falls back to userData/screenshots when pictures is missing', () => {
    vi.mock('../src/main/modules/config', () => ({ loadConfig: () => ({ screenshotDir: '' }) }));
    vi.mock('electron', () => ({ app: { getPath: (name: string) => (name === 'pictures' ? '' : path.join(os.tmpdir(), 'bao-ud')) } }));
    vi.mock('../src/main/modules/window', () => ({ getMainWindow: () => null }));
    vi.mock('../src/main/modules/tabs', () => ({ tabManager: {} }));
    const { getScreenshotDir: resolve } = require('../src/main/modules/screenshot');
    expect(resolve()).toBe(path.join(os.tmpdir(), 'bao-ud', 'screenshots'));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- --run tests/screenshot-policy.test.ts`
Expected: FAIL（`Cannot find module '../src/main/modules/screenshot'`）

- [ ] **Step 3: 实现 screenshot.ts**

```typescript
// src/main/modules/screenshot.ts
import fs from 'fs/promises';
import { accessSync, constants as fsConstants, existsSync } from 'fs';
import path from 'path';
import { app } from 'electron';
import log from 'electron-log';
import { getMainWindow } from './window';
import { tabManager } from './tabs';
import { loadConfig } from './config';
import { isPathWithinDirectory, sanitizeDownloadFilename } from '../utils/download-path';

// ── 验证门常量（Task 7 按 release/screenshot-test/v20-results.md 回填）──
export const HIDDEN_CAPTURE_ENABLED = false;        // v20-T2b/T2c 全尺寸通过 → true
export const HIDDEN_CAPTURE_STAY_HIDDEN = true;     // v20-T2c 通过 → true；仅 T2b → false
export const FIRST_FRAME_DELAY_MS = 0;              // v20-T3b 显著优于 T3a → 100

export interface ScreenshotOptions {
  rect?: { x: number; y: number; width: number; height: number };
  save?: boolean;
  savePath?: string;
  returnData?: boolean;
}

export interface ScreenshotResult {
  success: boolean;
  code?: string;
  data?: string;
  filePath?: string;
  width?: number;
  height?: number;
  error?: string;
}

export interface DecideInput {
  hasWindow: boolean;
  minimized: boolean;
  hasWebContents: boolean;
  isActive: boolean;
  hiddenCaptureEnabled: boolean;
}

export type CaptureDecision =
  | { action: 'capture' }
  | { action: 'error'; code: string; error: string };

export function decideCapture(input: DecideInput): CaptureDecision {
  if (!input.hasWindow) return { action: 'error', code: 'NO_WINDOW', error: 'Main window is gone' };
  if (!input.hasWebContents) return { action: 'error', code: 'NO_TAB', error: 'Tab not found or has no BrowserView' };
  if (input.minimized && !input.isActive) {
    return { action: 'error', code: 'MINIMIZED_INACTIVE', error: 'Cannot capture inactive tab while window is minimized' };
  }
  if (!input.isActive && !input.hiddenCaptureEnabled) {
    return { action: 'error', code: 'HIDDEN_UNCAPTURABLE', error: 'Inactive tab capture not available on this engine' };
  }
  return { action: 'capture' };
}

interface CapturerOptions {
  rect?: ScreenshotOptions['rect'];
  size?: { width: number; height: number };
  stayHidden?: boolean;
}

async function captureWebContents(
  wc: Electron.WebContents,
  opts: CapturerOptions = {},
): Promise<{ image: Electron.NativeImage } | { error: string; code: string }> {
  wc.incrementCapturerCount(opts.size, opts.stayHidden);
  try {
    if (FIRST_FRAME_DELAY_MS > 0) await new Promise((r) => setTimeout(r, FIRST_FRAME_DELAY_MS));
    const image = opts.rect ? await wc.capturePage(opts.rect) : await wc.capturePage();
    if (image.isEmpty()) return { code: 'EMPTY', error: 'Capture returned empty image' };
    return { image };
  } catch (e) {
    return { code: 'CAPTURE_FAILED', error: e instanceof Error ? e.message : String(e) };
  } finally {
    wc.decrementCapturerCount(opts.stayHidden);
  }
}

export async function captureTab(tabId: string, opts: ScreenshotOptions): Promise<ScreenshotResult> {
  const win = getMainWindow();
  const wc = tabManager.getWebContents(tabId);
  const isActive = tabManager.isTabActive(tabId);
  const decision = decideCapture({
    hasWindow: Boolean(win && !win.isDestroyed()),
    minimized: Boolean(win?.isMinimized()),
    hasWebContents: Boolean(wc && !wc.isDestroyed()),
    isActive,
    hiddenCaptureEnabled: HIDDEN_CAPTURE_ENABLED,
  });
  if (decision.action === 'error') return { success: false, code: decision.code, error: decision.error };

  const capturerOpts: CapturerOptions = { rect: opts.rect };
  if (!isActive && HIDDEN_CAPTURE_ENABLED) {
    const rect = tabManager.getContainerRect();
    capturerOpts.size = { width: rect.width, height: rect.height };
    capturerOpts.stayHidden = HIDDEN_CAPTURE_STAY_HIDDEN;
  }
  const captured = await captureWebContents(wc as Electron.WebContents, capturerOpts);
  if (!('image' in captured)) return { success: false, ...captured };
  const { image } = captured;
  const size = image.getSize();
  const result: ScreenshotResult = { success: true, width: size.width, height: size.height };
  if (opts.returnData !== false) result.data = image.toPNG().toString('base64');
  if (opts.save || opts.savePath) {
    const savePath = await resolveSavePath(tabId, opts.savePath);
    if (!savePath.ok) return { success: false, code: savePath.code, error: savePath.error };
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

export function getScreenshotDir(): string {
  const configured = loadConfig().screenshotDir;
  if (configured) return configured;
  try {
    const picDir = app.getPath('pictures');
    if (picDir && existsSync(picDir)) {
      try { accessSync(picDir, fsConstants.W_OK); return path.join(picDir, 'BaoFlashBrowser'); } catch { /* fall through */ }
    }
  } catch { /* fall through */ }
  return path.join(app.getPath('userData'), 'screenshots');
}

async function resolveSavePath(
  tabId: string,
  explicitPath?: string,
): Promise<{ ok: true; value: string } | { ok: false; code: string; error: string }> {
  const dir = getScreenshotDir();
  let fileName: string;
  if (explicitPath) {
    fileName = sanitizeDownloadFilename(path.basename(explicitPath));
    const ext = path.extname(fileName).toLowerCase();
    if (ext && ext !== '.png') {
      log.warn('[Screenshot] save path rejected (non-png):', path.basename(explicitPath));
      return { ok: false, code: 'INVALID_FILENAME', error: 'Save path must use .png extension' };
    }
    if (!ext) fileName += '.png';
  } else {
    fileName = sanitizeDownloadFilename(`screenshot-${tabId}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
  }
  if (!fileName || fileName === 'download') {
    log.warn('[Screenshot] save filename invalid; tabId:', tabId.slice(0, 16));
    return { ok: false, code: 'INVALID_FILENAME', error: 'Sanitized filename is empty' };
  }
  const filePath = path.join(dir, fileName);
  if (!isPathWithinDirectory(dir, filePath)) {
    log.warn('[Screenshot] save path rejected (outside dir):', fileName);
    return { ok: false, code: 'PATH_DENIED', error: 'Save path is outside the screenshot directory' };
  }
  return { ok: true, value: filePath };
}

async function writePng(image: Electron.NativeImage, filePath: string): Promise<string> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, image.toPNG());
  return filePath;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- --run tests/screenshot-policy.test.ts`
Expected: PASS（7 个用例）
注：`vi.mock` 需在测试文件内生效于 `require` 的模块——vitest 中 `vi.mock` 对同一文件的多次 require 用 `vi.resetModules()` 隔离（afterEach 已加）。

- [ ] **Step 5: 类型检查 + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 6: 询问用户后提交**

```bash
git add src/main/modules/screenshot.ts tests/screenshot-policy.test.ts
git commit -m "feat: add screenshot capture module with policy tests"
```

---

### Task 4: config.ts 五处 + save-config schema

**Files:**
- Modify: `src/main/modules/config.ts`（interface L7-19、DEFAULT_CONFIG L21-33、schema L43-65、loadConfig L71-86、saveConfig L88-111）
- Modify: `src/main/ipc/config.ipc.ts`（schema + import）

**Interfaces:**
- Consumes: `isPathWithinDirectory`（`src/main/utils/download-path.ts`）、`app`（electron）
- Produces:
  - `Config.screenshotDir: string`（默认 `''`）
  - `save-config` schema 接受 `screenshotDir`，并对 `downloadDir`/`screenshotDir` 拒绝 userData 内路径

- [ ] **Step 1: config.ts 五处修改**

```typescript
// 1) interface（L7-19）加入：
  screenshotDir: string;
// 2) DEFAULT_CONFIG（L21-33）加入：
  screenshotDir: '',
// 3) schema（L43-65）加入：
        screenshotDir: {
          type: 'string',
        },
// 4) loadConfig() 返回对象（L71-86）加入：
    screenshotDir: s.get('screenshotDir'),
// 5) saveConfig()（L88-111）加入（在 downloadDir 行之后）：
    if (cfg.screenshotDir !== undefined) updates.screenshotDir = cfg.screenshotDir;
```

- [ ] **Step 2: config.ipc.ts schema 改造**

```typescript
// src/main/ipc/config.ipc.ts 完整替换（保留 applyCapacityConfig 调用）：
import { createHandler } from '../utils/ipc-wrapper';
import { z } from 'zod';
import { app } from 'electron';
import { createValidatedHandler } from '../utils/ipc-wrapper';
import { loadConfig, saveConfig, type Config } from '../modules/config';
import { applyCapacityConfig } from '../modules/userscripts';
import { isPathWithinDirectory } from '../utils/download-path';

const capacityField = (min: number, max: number) => z.number().int().min(min).max(max);

// 路径字段：空串/undefined 放行；非空时拒绝位于 userData 内的目录
const pathField = (field: string) => z.string().max(32767).optional().refine(
  (dir) => !dir || !isPathWithinDirectory(app.getPath('userData'), dir),
  { message: `${field} must not be within userData` },
);

export function registerConfigIPC(): void {
  createHandler('load-config', () => loadConfig());
  createValidatedHandler('save-config', z.object({
    flashVersion: z.string().regex(/^\d+\.\d+\.\d+\.\d+$/).optional(),
    lowEndMode: z.boolean().optional(),
    downloadEngine: z.enum(['chromium', 'aria2']).optional(),
    downloadDir: pathField('downloadDir'),
    screenshotDir: pathField('screenshotDir'),
    userscriptMaxResponseMB: capacityField(1, 64).optional(),
    userscriptTimeoutSeconds: capacityField(1, 120).optional(),
    userscriptMaxConcurrentPerScript: capacityField(1, 16).optional(),
    userscriptMaxConcurrentGlobal: capacityField(1, 64).optional(),
    userscriptDownloadMaxMB: capacityField(1, 64).optional(),
    userscriptDownloadConcurrent: capacityField(1, 16).optional(),
    userscriptMaxValueKB: capacityField(1, 1024).optional(),
  }).strict(), (cfg: Partial<Config>) => {
    const ok = saveConfig(cfg);
    applyCapacityConfig(cfg);
    return ok;
  });
}
```

- [ ] **Step 3: 类型检查 + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 4: 询问用户后提交**

```bash
git add src/main/modules/config.ts src/main/ipc/config.ipc.ts
git commit -m "feat: add screenshotDir config with userData path guard"
```

---

### Task 5: screenshot.ipc.ts + index.ts 接线

**Files:**
- Create: `src/main/ipc/screenshot.ipc.ts`
- Modify: `src/main/index.ts`（`registerDownloadIPC();` 之后插入接线）

**Interfaces:**
- Consumes: `captureTab` / `getScreenshotDir`（Task 3）、`tabManager.getActiveId()`（Task 2）、`saveConfig`（Task 4）、`createValidatedHandler`（`src/main/utils/ipc-wrapper.ts`）
- Produces: 通道 `screenshot:capture` / `screenshot:capture-active` / `screenshot:reveal` / `screenshot:set-dir`

- [ ] **Step 1: 创建 screenshot.ipc.ts**

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
  savePath: z.string().max(32767).optional(),
  returnData: z.boolean().optional(),
  rect: rectSchema.optional(),
};

export function registerScreenshotIPC(getWin: () => BrowserWindow | null): void {
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
      if (result.canceled || !result.filePaths[0]) return { success: true, canceled: true };
      const dir = result.filePaths[0];
      try {
        await fs.promises.access(dir, fs.constants.W_OK);
      } catch {
        log.warn('[Screenshot] set-dir rejected (not writable):', dir);
        return { success: false, code: 'DIR_NOT_WRITABLE', error: 'Selected directory is not writable', dir };
      }
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

- [ ] **Step 2: index.ts 接线**

在 `src/main/index.ts` 的 `registerDownloadIPC();`（L113）之后插入：

```typescript
    registerScreenshotIPC(() => getMainWindow());
```

- [ ] **Step 3: 类型检查 + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 4: 询问用户后提交**

```bash
git add src/main/ipc/screenshot.ipc.ts src/main/index.ts
git commit -m "feat: register screenshot IPC channels"
```

---

### Task 6: preload 暴露 + 渲染层类型

**Files:**
- Modify: `src/preload/index.ts`（ALLOWED_INVOKE_CHANNELS L15-38 + electronAPI 对象）
- Modify: `src/renderer/types/electron.d.ts`

**Interfaces:**
- Consumes: Task 3 的 `ScreenshotOptions` / `ScreenshotResult` 形状（渲染层以 `import('@main/...')` 不可行，按 electron.d.ts 惯例内联类型）
- Produces: `window.electronAPI.screenshot.{capture,captureActive,reveal,setDir}`（Task 8/9 依赖）

- [ ] **Step 1: preload 白名单**

在 `ALLOWED_INVOKE_CHANNELS`（L38 `]);` 之前）追加：

```typescript
  'screenshot:capture', 'screenshot:capture-active', 'screenshot:reveal', 'screenshot:set-dir',
```

- [ ] **Step 2: electronAPI.screenshot 对象**

在 electronAPI 对象中 `userscripts:` 之后（或任意既有成员之后）追加：

```typescript
  screenshot: {
    capture: (tabId: string, opts?: { save?: boolean; savePath?: string; returnData?: boolean; rect?: { x: number; y: number; width: number; height: number } }) =>
      safeInvoke('screenshot:capture', { tabId, ...opts }),
    captureActive: (opts?: { save?: boolean; savePath?: string; returnData?: boolean; rect?: { x: number; y: number; width: number; height: number } }) =>
      safeInvoke('screenshot:capture-active', { ...opts }),
    reveal: (filePath: string) => safeInvoke('screenshot:reveal', { filePath }),
    setDir: () => safeInvoke('screenshot:set-dir'),
  },
```

- [ ] **Step 3: electron.d.ts**

```typescript
// 1) MainConfig（L11-23）加入：
  screenshotDir: string;
// 2) 新增顶层类型（declare global 之前）：
interface ScreenshotResult {
  success: boolean;
  code?: string;
  data?: string;
  filePath?: string;
  width?: number;
  height?: number;
  error?: string;
}

interface ScreenshotOptions {
  save?: boolean;
  savePath?: string;
  returnData?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
}
// 3) invoke 通道声明（L112 `invoke(channel: string, ...args...)` 之前）加入：
      invoke(channel: 'screenshot:capture', payload: { tabId: string } & ScreenshotOptions): Promise<ScreenshotResult>;
      invoke(channel: 'screenshot:capture-active', payload: ScreenshotOptions): Promise<ScreenshotResult>;
      invoke(channel: 'screenshot:reveal', payload: { filePath: string }): Promise<{ success: boolean; code?: string; error?: string }>;
      invoke(channel: 'screenshot:set-dir'): Promise<{ success: boolean; canceled?: boolean; dir?: string; code?: string; error?: string }>;
// 4) electronAPI 对象声明（userscripts 成员之后）加入：
      screenshot: {
        capture(tabId: string, opts?: ScreenshotOptions): Promise<ScreenshotResult>;
        captureActive(opts?: ScreenshotOptions): Promise<ScreenshotResult>;
        reveal(filePath: string): Promise<{ success: boolean; code?: string; error?: string }>;
        setDir(): Promise<{ success: boolean; canceled?: boolean; dir?: string; code?: string; error?: string }>;
      };
```

- [ ] **Step 4: 类型检查**

Run: `npm run typecheck`
Expected: PASS（preload 与渲染层类型均通过）

- [ ] **Step 5: 询问用户后提交**

```bash
git add src/preload/index.ts src/renderer/types/electron.d.ts
git commit -m "feat: expose screenshot API through preload"
```

---

### Task 7: v20 结果回填验证门常量

**Files:**
- Modify: `src/main/modules/screenshot.ts`（模块顶部三个常量）
- Modify: `docs/superpowers/specs/2026-08-07-screenshot-design.md`（§捕获策略决策点 1/2、§错误码 HIDDEN_UNCAPTURABLE 文字）

**Interfaces:**
- Consumes: `release/screenshot-test/v20-results.md`（Task 1 产物；若标注 UNVERIFIED 则跳过本任务并注明）
- Produces: 无（只回填常量）

- [ ] **Step 1: 读取 v20 结果**

Run: `Get-Content release/screenshot-test/v20-results.md`
Expected: 四个判定值。若文件不存在或 UNVERIFIED → 本任务跳过，两个常量保持 Task 3 初值（`HIDDEN_CAPTURE_ENABLED=false`、`FIRST_FRAME_DELAY_MS=0`）。

- [ ] **Step 2: 按结果回填常量**

按 v20-results.md 的 Verdicts 段：

```typescript
// 通过（T2b 或 T2c 输出 >=1279x719）：
export const HIDDEN_CAPTURE_ENABLED = true;
// T2c 通过 → true；仅 T2b 通过 → false：
export const HIDDEN_CAPTURE_STAY_HIDDEN = <按结果>;
// T3b 全尺寸且 T3a 空 → 100；否则 0：
export const FIRST_FRAME_DELAY_MS = <按结果>;
```

- [ ] **Step 3: 更新设计文档**

`docs/superpowers/specs/2026-08-07-screenshot-design.md`：
- §捕获策略决策点 1：写入实测结论（哪个变体通过、实际尺寸）
- §错误码 `HIDDEN_UNCAPTURABLE`：若启用则删去该码及决策点降级文字；若未启用则把 error 文字改为非版本相关（如"Inactive tab capture not available on this engine"——Task 3 已用此文字）

- [ ] **Step 4: 跑全量测试 + 类型检查**

Run: `npm test -- --run && npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 5: 询问用户后提交**

```bash
git add src/main/modules/screenshot.ts docs/superpowers/specs/2026-08-07-screenshot-design.md
git commit -m "feat: backfill capture parameters from v20 verification gate"
```

---

### Task 8: TopBar 截图按钮 + i18n（GBK 注意）

**Files:**
- Modify: `src/renderer/components/layout/TopBar.tsx`
- Modify: `src/renderer/i18n/zh-CN/index.ts`（**GBK 编码，PowerShell 修改**）
- Modify: `src/renderer/i18n/en/index.ts`（**GBK 编码，PowerShell 修改**）
- Modify（生成产物）: `src/renderer/i18n/i18n-types.ts` 等（`npm run i18n` 生成）

**Interfaces:**
- Consumes: `window.electronAPI.screenshot.captureActive` / `reveal`（Task 6）、`useDataStore` pushToast、`useI18nContext` LL
- Produces: TopBar 截图按钮（点击 → captureActive({save:true, returnData:false}) → toast + 打开文件夹）

- [ ] **Step 1: 用 GBK 编码向字典追加 key**

PowerShell（保持 GBK，禁止 UTF-8 编辑工具）：

```powershell
$zh = 'src/renderer/i18n/zh-CN/index.ts'
$en = 'src/renderer/i18n/en/index.ts'
$enc = [System.Text.Encoding]::GetEncoding(936)
$zhText = $enc.GetString([System.IO.File]::ReadAllBytes($zh))
$enText = $enc.GetString([System.IO.File]::ReadAllBytes($en))
# 在 settings 对象末尾的 userscriptCapacity 之后插入 screenshot 子对象（找 '  // 用户脚本容量' 或 userscriptCapacity 结尾 '  },'）
$zhInsert = @'
  // 截图
  screenshot: {
    capture: '截图',
    captureHint: '截取当前标签页画面并保存',
    captured: '截图已保存',
    openFolder: '打开文件夹',
    captureFailed: '截图失败',
    dir: '截图保存目录',
    selectDir: '选择目录',
    dirChanged: '截图目录已更改',
    dirNotWritable: '所选目录不可写',
    dirDenied: '所选目录位于程序数据目录内',
    dirSelectFailed: '选择目录失败',
  },
'@
$enInsert = @'
  // Screenshot
  screenshot: {
    capture: 'Screenshot',
    captureHint: 'Capture the current tab',
    captured: 'Screenshot saved',
    openFolder: 'Open folder',
    captureFailed: 'Screenshot failed',
    dir: 'Screenshot folder',
    selectDir: 'Choose...',
    dirChanged: 'Screenshot folder changed',
    dirNotWritable: 'Selected folder is not writable',
    dirDenied: 'Folder must not be inside the app data directory',
    dirSelectFailed: 'Failed to choose folder',
  },
'@
# 插入点：settings 对象中 userscriptCapacity 块之后（以 '    },' 加 '  },' 定位到 settings 结尾前）。
# 简化可靠做法：在 settings 对象第一个 '  },' 前不行——直接定位 'userscriptCapacity: {' 后首个 '    },' 行，
# 在其后插入。若定位失败请人工打开文件确认结构后重试。
$marker = '    },'
$idx = $zhText.IndexOf('userscriptCapacity')
$blockEnd = $zhText.IndexOf($marker, $idx)
if ($blockEnd -ge 0) { $zhText = $zhText.Insert($blockEnd + $marker.Length, "`n" + $zhInsert) }
$idxEn = $enText.IndexOf('userscriptCapacity')
$blockEndEn = $enText.IndexOf($marker, $idxEn)
if ($blockEndEn -ge 0) { $enText = $enText.Insert($blockEndEn + $marker.Length, "`n" + $enInsert) }
[System.IO.File]::WriteAllBytes($zh, $enc.GetBytes($zhText))
[System.IO.File]::WriteAllBytes($en, $enc.GetBytes($enText))
Write-Output 'i18n keys inserted (GBK preserved)'
```

- [ ] **Step 2: 重新生成 i18n 类型**

Run: `npm run i18n`
Expected: `src/renderer/i18n/i18n-types.ts` 更新（含 `screenshot` 键；生成器保持 GBK 编码）。若 diff 显示全文件乱码变化（编码漂移），停止并报告——不得提交。

- [ ] **Step 3: TopBar 按钮**

`src/renderer/components/layout/TopBar.tsx`：
1. import 增加：`Camera`（lucide-react）、`useDataStore`（`@renderer/store/useDataStore`）
2. 组件内：

```typescript
  const pushToast = useDataStore((s) => s.pushToast);
  const [screenshotting, setScreenshotting] = useState(false);

  const handleScreenshot = useCallback(async () => {
    if (screenshotting) return;
    setScreenshotting(true);
    try {
      const result = await window.electronAPI.screenshot.captureActive({ save: true, returnData: false });
      if (result.success && result.filePath) {
        pushToast({
          message: `${LL.screenshot.captured()} (${result.filePath.split(/[\\/]/).pop()})`,
          type: 'success',
          actions: [{
            label: LL.screenshot.openFolder(),
            primary: true,
            onClick: () => window.electronAPI.screenshot.reveal(result.filePath as string),
          }],
        });
      } else {
        pushToast({ message: `${LL.screenshot.captureFailed()}: ${result.error || ''}`, type: 'error' });
      }
    } catch {
      pushToast({ message: LL.screenshot.captureFailed(), type: 'error' });
    } finally {
      setScreenshotting(false);
    }
  }, [screenshotting, pushToast, LL]);
```

3. 渲染：在 `<RuffleToggle ... />`（L200）之前插入：

```tsx
        <button onClick={handleScreenshot} disabled={screenshotting} className="btn-icon" title={LL.screenshot.captureHint()}>
          <Camera className="w-4 h-4" />
        </button>
```

注：`window.electronAPI.screenshot` 类型已在 Task 6 声明；`LL.screenshot.*` 由 Task 8 Step 1-2 生成。

- [ ] **Step 4: 类型检查 + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 5: 询问用户后提交**

```bash
git add src/renderer/components/layout/TopBar.tsx src/renderer/i18n/
git commit -m "feat: add toolbar screenshot button with toast"
```

---

### Task 9: SettingsPanel 截图目录行

**Files:**
- Modify: `src/renderer/components/panels/SettingsPanel.tsx`

**Interfaces:**
- Consumes: `window.electronAPI.screenshot.setDir`（Task 6）、`LL.settings.screenshot.*`（Task 8 i18n）
- Produces: 设置页"截图保存目录"行（显示当前目录 + 选择按钮，即时持久化）

- [ ] **Step 1: MainConfigForm + 初始化 + 保存**

`SettingsPanel.tsx`：
1. `MainConfigForm`（L16-27）加 `screenshotDir: string;`
2. `DEFAULT_MAIN_CONFIG`（L29-40）加 `screenshotDir: '',`
3. 初始化 useEffect（L60-75）setMainForm 对象加 `screenshotDir: cfg.screenshotDir ?? ''`
4. `handleSave`（L134-161）invoke 参数加 `screenshotDir: mainForm.screenshotDir,`
5. 新增 handler：

```typescript
  const handleSelectScreenshotDir = useCallback(async () => {
    try {
      const result = await window.electronAPI.screenshot.setDir();
      if (result.canceled) return;
      if (result.success && result.dir) {
        setMainForm((prev) => ({ ...prev, screenshotDir: result.dir as string }));
        pushToast({ message: LL.settings.screenshot.dirChanged(), type: 'success' });
      } else {
        const msg = result.code === 'DIR_NOT_WRITABLE'
          ? LL.settings.screenshot.dirNotWritable()
          : result.code === 'DIR_DENIED'
            ? LL.settings.screenshot.dirDenied()
            : LL.settings.screenshot.dirSelectFailed();
        pushToast({ message: msg, type: 'error' });
      }
    } catch {
      pushToast({ message: LL.settings.screenshot.dirSelectFailed(), type: 'error' });
    }
  }, [setMainForm, pushToast, LL]);
```

注：`LL.settings.screenshot.*` 的路径——Task 8 把 screenshot 子对象插入了 settings 对象，故类型为 `LL.settings.screenshot.capture()` 等。若 Task 8 实际插入位置不同，按生成类型调整。

- [ ] **Step 2: 渲染行**

在 downloadEngine 的 panel-card（L343-356）之后插入：

```tsx
      <div className="panel-card">
        <div className="panel-card-title">{LL.settings.screenshot.dir()}</div>
        <div className="field">
          <div className="field-label">{LL.settings.screenshot.capture()}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1, fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {mainForm.screenshotDir || LL.settings.screenshot.captureHint()}
            </span>
            <button
              style={{ padding: '6px 12px', borderRadius: 6, border: 'none', background: 'var(--bg-hover)', color: 'var(--text-primary)', fontSize: 13, cursor: 'pointer', flexShrink: 0 }}
              onClick={handleSelectScreenshotDir}
            >
              {LL.settings.screenshot.selectDir()}
            </button>
          </div>
          <div className="field-hint">{LL.settings.screenshot.captureHint()}</div>
        </div>
      </div>
```

- [ ] **Step 3: 类型检查 + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 4: 询问用户后提交**

```bash
git add src/renderer/components/panels/SettingsPanel.tsx
git commit -m "feat: add screenshot directory setting row"
```

---

## Self-Review 记录

- **Spec 覆盖**：需求 1（IPC，Task 5/6）、需求 2（TopBar 按钮，Task 8）、需求 3（BrowserView capture，Task 3）、需求 4（三状态分级，Task 3 decideCapture + Task 7 回填）、需求 5（零闪烁——capturer 无 restore/rehide 路径）、P0-P3 全部审计项（sanitize/扩展名/路径校验 Task 3、set-dir 探测 Task 5、stayHidden 配对 Task 3、GBK Task 8、注册作用域 Task 5、getContainerRect Task 2、Pictures fallback Task 3、错误码脚注 Task 3 注释与文档）。
- **占位符扫描**：唯一"按结果"参数是 Task 7 回填（由 Task 1 产物驱动，判定条件在 v20-results.md 模板中已写死）；无 TBD/TODO。
- **类型一致性**：`ScreenshotOptions`/`ScreenshotResult` 在 Task 3 定义、Task 5/6 引用；`decideCapture` 签名在测试与实现一致；`getContainerRect` 在 Task 2 定义、Task 3 使用；LL key 名在 Task 8 字典与 Task 9 引用一致（`settings.screenshot.*`）。
