import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { AutomationCapturedFrame, AutomationOcrEngine, OcrTextItem } from './capability-contracts';

type PendingRequest = {
  readonly id: number;
  resolve: (items: OcrTextItem[]) => void;
  reject: (error: Error) => void;
};

export type BaoOcrSidecarCommand = { readonly executable: string; readonly args?: readonly string[]; readonly cwd?: string };

const STARTUP_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAGIC = Buffer.from('BAO1', 'ascii');
const MAX_BITMAP_BYTES = 64 * 1024 * 1024;

function parseItem(value: unknown): OcrTextItem | null {
  const item = value as { text?: unknown; score?: unknown; box?: unknown };
  if (typeof item?.text !== 'string' || typeof item.score !== 'number' || !Number.isFinite(item.score) || !Array.isArray(item.box)) return null;
  const box = item.box.filter((point): point is [number, number] => (
    Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1])
  ));
  return box.length >= 4 ? { text: item.text, score: item.score, box } : null;
}

/** Provider-neutral BAO1 process client. Paddle is the sole production provider. */
export class Bao1OcrSidecarEngine implements AutomationOcrEngine {
  private child: ChildProcessWithoutNullStreams | null = null;
  private startup: Promise<void> | null = null;
  private stdoutBuffer = '';
  private pending: PendingRequest | null = null;
  private queue: Promise<void> = Promise.resolve();
  private nextRequestId = 1;
  private readonly command: BaoOcrSidecarCommand;

  constructor(command: BaoOcrSidecarCommand, private readonly requestTimeoutMs = REQUEST_TIMEOUT_MS, private readonly startupTimeoutMs = STARTUP_TIMEOUT_MS, readonly providerId = 'bao1-ocr-sidecar') {
    this.command = command;
  }

  get available(): boolean { return fs.existsSync(this.command.executable); }

  /**
   * 预热:提前 spawn 子进程并完成模型加载,避免首次识别等待冷启动。
   * OCR runtime 未安装时返回 false,由调用方决定是否提示,不视为启动失败。
   */
  async warmup(): Promise<boolean> {
    if (!this.available) return false;
    await this.ensureStarted();
    return true;
  }

  async recognize(frame: AutomationCapturedFrame, signal: AbortSignal): Promise<OcrTextItem[]> {
    if (!this.available) throw new Error('OCR runtime is not installed');
    if (!frame.bitmap || !frame.bitmapSize) throw new Error('OCR capture has no bitmap pixels');
    const { width, height } = frame.bitmapSize;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
      || frame.bitmap.byteLength !== width * height * 4 || frame.bitmap.byteLength > MAX_BITMAP_BYTES) throw new Error('invalid OCR bitmap');
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (signal.aborted) throw new Error('automation cancelled');
      await this.ensureStarted();
      if (signal.aborted) { if (this.child) this.terminate(this.child); throw new Error('automation cancelled'); }
      return await this.request(frame.bitmap, width, height, signal);
    } finally { release(); }
  }

  async close(): Promise<void> {
    const child = this.child;
    this.resetChild(new Error('OCR engine closed'), false);
    if (!child) return;
    try { child.stdin.end(); } catch { /* already closed */ }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 1_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }

  private ensureStarted(): Promise<void> {
    if (this.child && !this.child.killed) return this.startup ?? Promise.resolve();
    const child = spawn(this.command.executable, [...(this.command.args ?? [])], {
      cwd: this.command.cwd ?? path.dirname(this.command.executable), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.stdoutBuffer = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    // Native engines may emit extensive oneDNN/Paddle diagnostics. Always
    // drain stderr so a full pipe cannot deadlock initialization or inference.
    child.stderr.resume();
    child.on('error', (error) => this.failChild(child, error));
    child.on('exit', (code) => this.failChild(child, new Error(`OCR sidecar exited with code ${String(code)}`)));
    this.startup = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        if (this.child === child) { this.child = null; this.startup = null; }
        reject(new Error('OCR sidecar startup timed out'));
      }, this.startupTimeoutMs);
      const onReady = (chunk: string): void => {
        const lines = chunk.split(/\r?\n/);
        if (!lines.some((line) => {
          try { const value = JSON.parse(line) as { type?: unknown; protocol?: unknown }; return value.type === 'ready' && value.protocol === 1; }
          catch { return false; }
        })) return;
        clearTimeout(timer); child.stdout.off('data', onReady); resolve();
      };
      child.stdout.on('data', onReady);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`OCR sidecar exited during startup (${String(code)})`)); });
    });
    return this.startup;
  }

  private request(bitmap: Buffer, width: number, height: number, signal: AbortSignal): Promise<OcrTextItem[]> {
    const child = this.child;
    if (!child || child.killed) return Promise.reject(new Error('OCR sidecar is not running'));
    const id = this.nextRequestId++;
    const headerBytes = Buffer.from(JSON.stringify({ id, width, height, format: 'bgra' }), 'utf8');
    const prefix = Buffer.allocUnsafe(12);
    MAGIC.copy(prefix, 0); prefix.writeUInt32LE(headerBytes.byteLength, 4); prefix.writeUInt32LE(bitmap.byteLength, 8);
    return new Promise<OcrTextItem[]>((resolve, reject) => {
      const finish = (error?: Error, items?: OcrTextItem[]): void => {
        clearTimeout(timer); signal.removeEventListener('abort', onAbort);
        if (this.pending?.id === id) this.pending = null;
        if (error) reject(error); else resolve(items ?? []);
      };
      const timer = setTimeout(() => { this.terminate(child); finish(new Error(`OCR request timed out after ${this.requestTimeoutMs}ms`)); }, this.requestTimeoutMs);
      const onAbort = (): void => { this.terminate(child); finish(new Error('automation cancelled')); };
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending = { id, resolve: (items) => finish(undefined, items), reject: (error) => finish(error) };
      child.stdin.write(Buffer.concat([prefix, headerBytes, bitmap]), (error) => { if (error) this.failChild(child, error); });
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim(); this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let response: { type?: unknown; id?: unknown; items?: unknown; error?: unknown };
      try { response = JSON.parse(line) as typeof response; } catch { continue; }
      if (response.type === 'ready') continue;
      const pending = this.pending;
      if (!pending || response.id !== pending.id) continue;
      if (response.type === 'error') { pending.reject(new Error(`OCR failed: ${String(response.error ?? 'unknown error')}`)); continue; }
      if (response.type !== 'result' || !Array.isArray(response.items)) { pending.reject(new Error('OCR sidecar returned an invalid response')); continue; }
      pending.resolve(response.items.map(parseItem).filter((item): item is OcrTextItem => item !== null));
    }
  }

  private terminate(child: ChildProcessWithoutNullStreams): void { child.kill(); if (this.child === child) { this.child = null; this.startup = null; } }
  private failChild(child: ChildProcessWithoutNullStreams, error: Error): void { if (this.child !== child) return; this.resetChild(error, false); }
  private resetChild(error: Error, kill: boolean): void {
    const child = this.child; this.child = null; this.startup = null;
    this.pending?.reject(error); this.pending = null;
    if (kill && child && !child.killed) child.kill();
  }
}
