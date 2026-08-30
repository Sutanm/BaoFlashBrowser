import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AutomationCapturedFrame, OcrTextItem } from './capability-contracts';
export type { OcrTextItem } from './capability-contracts';

type PendingRequest = {
  resolve: (items: OcrTextItem[]) => void;
  reject: (error: Error) => void;
};

const OCR_EXECUTABLE = 'PaddleOCR-json.exe';
const STARTUP_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;

// Electron 11 ships Node 12, which predates fs.promises.rm (Node 14.14).
// fs.promises.rmdir with { recursive } has existed since Node 12.10 but the
// installed @types/node (25.x) dropped that overload; cast to keep both happy.
function removeTempDir(dir: string): Promise<void> {
  return (fs.promises.rmdir as unknown as (p: string, o: { recursive: boolean }) => Promise<void>)(dir, { recursive: true });
}

export function bundledOcrDirectory(): string {
  const packaged = path.join(process.resourcesPath ?? '', 'native', 'ocr');
  if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'app.asar'))) return packaged;
  return path.resolve(process.cwd(), 'native', 'ocr', 'win64');
}

export function bundledOcrAvailable(): boolean {
  return process.platform === 'win32' && process.arch === 'x64'
    && fs.existsSync(path.join(bundledOcrDirectory(), OCR_EXECUTABLE));
}

function bitmapToBmp(bitmap: Buffer, width: number, height: number): Buffer {
  if (width <= 0 || height <= 0 || bitmap.byteLength !== width * height * 4) throw new Error('invalid OCR bitmap');
  const header = Buffer.alloc(54);
  const pixelBytes = width * height * 4;
  header.write('BM', 0, 'ascii');
  header.writeUInt32LE(54 + pixelBytes, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  // Negative height stores rows top-to-bottom, matching NativeImage.toBitmap().
  header.writeInt32LE(-height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(32, 28);
  header.writeUInt32LE(pixelBytes, 34);
  return Buffer.concat([header, bitmap]);
}

function parseResponse(line: string): OcrTextItem[] {
  let value: unknown;
  try { value = JSON.parse(line); }
  catch { throw new Error(`OCR returned invalid JSON: ${line.slice(0, 200)}`); }
  const response = value as { code?: unknown; data?: unknown; message?: unknown };
  if (response.code === 101) return [];
  if (response.code !== 100 || !Array.isArray(response.data)) {
    throw new Error(`OCR failed (${String(response.code ?? 'unknown')}): ${String(response.message ?? 'unknown error')}`);
  }
  return response.data.flatMap((entry): OcrTextItem[] => {
    const item = entry as { text?: unknown; score?: unknown; box?: unknown };
    if (typeof item.text !== 'string' || typeof item.score !== 'number' || !Array.isArray(item.box)) return [];
    const box = item.box.filter((point): point is [number, number] => (
      Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1])
    ));
    return box.length >= 4 ? [{ text: item.text, score: item.score, box }] : [];
  });
}

export class PaddleOcrEngine {
  private child: ChildProcessWithoutNullStreams | null = null;
  private startup: Promise<void> | null = null;
  private stdoutBuffer = '';
  private pending: PendingRequest | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly directory: string;

  constructor(directory = bundledOcrDirectory(), private readonly requestTimeoutMs = REQUEST_TIMEOUT_MS) {
    this.directory = directory;
  }

  get available(): boolean {
    return process.platform === 'win32' && process.arch === 'x64'
      && fs.existsSync(path.join(this.directory, OCR_EXECUTABLE));
  }

  async recognize(frame: AutomationCapturedFrame, signal: AbortSignal): Promise<OcrTextItem[]> {
    if (!this.available) throw new Error('当前安装的是标准版，不包含 OCR；请安装 BaoFlashBrowser OCR 版');
    if (!frame.bitmap || !frame.bitmapSize) throw new Error('OCR capture has no bitmap pixels');
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (signal.aborted) throw new Error('automation cancelled');
      await this.ensureStarted();
      const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bao-ocr-'));
      const imagePath = path.join(tempDir, 'capture.bmp');
      try {
        await fs.promises.writeFile(imagePath, bitmapToBmp(frame.bitmap, frame.bitmapSize.width, frame.bitmapSize.height));
        return await this.request({ image_path: imagePath }, signal);
      } finally {
        await removeTempDir(tempDir).catch(() => {});
      }
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.startup = null;
    if (!child) return;
    this.pending?.reject(new Error('OCR engine closed'));
    this.pending = null;
    try { child.stdin.write('exit\n'); } catch { /* already closed */ }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 1_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && !this.child.killed) return this.startup ?? Promise.resolve();
    const executable = path.join(this.directory, OCR_EXECUTABLE);
    // The executable's built-in defaults already point at the selected Chinese
    // detector/recognizer. v1.4.1's CLI config_path parsing rejects a valid
    // relative .txt path, so do not pass it in pipe mode.
    // Cap the CPU thread pool: the default 10 threads each reserve an MKL-DNN
    // workspace, which is the main contributor to the ~600MB resident set.
    // Single-image recognition has ample headroom at 4 threads.
    const child = spawn(executable, ['-cpu_threads=4'], { cwd: this.directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.on('error', (error) => this.fail(error));
    child.on('exit', (code) => this.fail(new Error(`OCR engine exited with code ${String(code)}`)));
    this.startup = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        if (this.child === child) { this.child = null; this.startup = null; }
        reject(new Error('OCR engine startup timed out'));
      }, STARTUP_TIMEOUT_MS);
      const onData = (chunk: string): void => {
        if (!chunk.includes('OCR init completed')) return;
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve();
      };
      child.stdout.on('data', onData);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`OCR engine exited during startup (${String(code)})`)); });
    });
    return this.startup;
  }

  private request(payload: Record<string, unknown>, signal: AbortSignal): Promise<OcrTextItem[]> {
    const child = this.child;
    if (!child || child.killed) return Promise.reject(new Error('OCR engine is not running'));
    return new Promise<OcrTextItem[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.reject !== rejectPending) return;
        this.pending = null;
        child.kill();
        if (this.child === child) { this.child = null; this.startup = null; }
        signal.removeEventListener('abort', onAbort);
        reject(new Error(`OCR request timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      const onAbort = (): void => {
        if (this.pending?.reject === rejectPending) this.pending = null;
        clearTimeout(timer);
        child.kill();
        if (this.child === child) { this.child = null; this.startup = null; }
        reject(new Error('automation cancelled'));
      };
      const rejectPending = (error: Error): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(error);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending = {
        resolve: (items) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve(items); },
        reject: rejectPending,
      };
      child.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8', (error) => { if (error) this.fail(error); });
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line || line.includes('OCR init completed') || !this.pending) continue;
      const pending = this.pending;
      this.pending = null;
      try { pending.resolve(parseResponse(line)); }
      catch (error) { pending.reject(error instanceof Error ? error : new Error(String(error))); }
    }
  }

  private fail(error: Error): void {
    this.pending?.reject(error);
    this.pending = null;
    this.child = null;
    this.startup = null;
  }
}
