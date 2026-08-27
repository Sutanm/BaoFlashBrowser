// src/main/modules/screenshot.ts
import fs from 'fs';   // 异步 IO 用 fs.promises.*（与 download.ts 一致；'fs/promises' 子路径在 esbuild 打包下不可用）
import { accessSync, constants as fsConstants, existsSync } from 'fs';
import path from 'path';
import { app } from 'electron';
import log from 'electron-log';
import { getMainWindow } from './window';
import { tabManager } from './tabs';
import { loadConfig } from './config';
import { isPathWithinDirectory, sanitizeDownloadFilename } from '../utils/download-path';

// ── 验证门常量（v20 gate，2026-08-08 回填）──
// T2a/T2b/T2c 全尺寸通过（1920x1080 = 1280x720 x DPR1.5）；T2c 侧证 visibilityState=hidden
export const HIDDEN_CAPTURE_ENABLED = true;
export const HIDDEN_CAPTURE_STAY_HIDDEN = true;
// T3a 最小化立即 capture 即全尺寸，无需首帧等待
export const FIRST_FRAME_DELAY_MS = 0;
export const MAX_SCREENSHOT_DATA_PIXELS = 16_777_216;
export const MAX_SCREENSHOT_DATA_PNG_BYTES = 16 * 1024 * 1024;

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

export interface ScreenshotDataLimitError {
  code: 'DATA_TOO_LARGE';
  error: string;
}

export function screenshotDataLimitError(
  width: number,
  height: number,
  pngBytes?: number,
): ScreenshotDataLimitError | null {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
      || width < 0 || height < 0 || width * height > MAX_SCREENSHOT_DATA_PIXELS) {
    return {
      code: 'DATA_TOO_LARGE',
      error: `Screenshot data exceeds the ${MAX_SCREENSHOT_DATA_PIXELS} pixel limit`,
    };
  }
  if (pngBytes !== undefined && pngBytes > MAX_SCREENSHOT_DATA_PNG_BYTES) {
    return {
      code: 'DATA_TOO_LARGE',
      error: `Screenshot PNG exceeds the ${MAX_SCREENSHOT_DATA_PNG_BYTES} byte limit`,
    };
  }
  return null;
}

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
    // stayHidden 必须与 increment 时配对一致（漏传会把页面从 hidden 切回 visible）
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
  let png: Buffer | undefined;
  if (opts.save || opts.savePath) {
    const savePath = await resolveSavePath(tabId, opts.savePath);
    if (!savePath.ok) return { success: false, code: savePath.code, error: savePath.error };
    try {
      png = image.toPNG();
      result.filePath = await writePng(png, savePath.value);
    } catch (e) {
      return {
        success: false, code: 'IO_ERROR',
        error: e instanceof Error ? e.message : String(e),
        width: size.width, height: size.height,
      };
    }
  }
  if (opts.returnData !== false) {
    const pixelLimit = screenshotDataLimitError(size.width, size.height);
    if (pixelLimit) return { success: false, ...pixelLimit, width: size.width, height: size.height, filePath: result.filePath };
    try {
      png ??= image.toPNG();
    } catch (e) {
      return {
        success: false, code: 'ENCODE_FAILED',
        error: e instanceof Error ? e.message : String(e),
        width: size.width, height: size.height, filePath: result.filePath,
      };
    }
    const byteLimit = screenshotDataLimitError(size.width, size.height, png.byteLength);
    if (byteLimit) return { success: false, ...byteLimit, width: size.width, height: size.height, filePath: result.filePath };
    result.data = png.toString('base64');
  }
  return result;
}

/** 截图目录：config.screenshotDir → Pictures/BaoFlashBrowser（存在且可写）→ userData/screenshots（兜底） */
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

async function writePng(png: Buffer, filePath: string): Promise<string> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, png);
  return filePath;
}
