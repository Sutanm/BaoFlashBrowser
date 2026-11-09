import { app, webContents as allWebContents, type WebContents } from 'electron';
import log from 'electron-log';
import type { DevToolEntry, DevToolIssue, DevToolLevel } from '@shared/types/devtoolbox';
import { classifyMainLog, clip, EntryBuffer, mapConsoleLevel } from './devtoolbox-buffer';
import { installDevToolsFileGuard, useLegacyHttp } from './devtoolbox-frontend-server';
import { broadcastToRegisteredWindows, getWindowById, getWindowForWebContents } from './window';
import { tabManager } from './tabs';

const MAX_ENTRIES = 2000;
const FLUSH_INTERVAL_MS = 80;
const MAX_PER_FLUSH = 400;
/** 主进程日志不属于任何窗口：进全局桶，所有窗口的抽屉都能看到。 */
const MAIN_BUCKET = 0;

let sequence = 0;
let started = false;
let inLogHook = false;
const boundContents = new Set<number>();

interface Bucket {
  buffer: EntryBuffer;
  timer: NodeJS.Timeout | null;
}

const buckets = new Map<number, Bucket>();

function bucketFor(winId: number): Bucket {
  let bucket = buckets.get(winId);
  if (!bucket) {
    bucket = { buffer: new EntryBuffer(MAX_ENTRIES), timer: null };
    buckets.set(winId, bucket);
  }
  return bucket;
}

function stringifyArg(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function mapWarnLevel(level: string): DevToolLevel {
  if (level === 'error') return 'error';
  if (level === 'warn') return 'warning';
  if (level === 'info') return 'info';
  return 'verbose';
}

function sendToWindow(winId: number, channel: string, payload: unknown): void {
  const win = getWindowById(winId);
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (!wc || wc.isDestroyed()) return;
  try {
    wc.send(channel, payload);
  } catch {
    // 渲染层正在销毁时静默丢弃：绝不能在管道里再次写日志（会递归回 hook）
  }
}

function scheduleFlush(winId: number): void {
  const bucket = bucketFor(winId);
  if (bucket.timer) return;
  bucket.timer = setTimeout(() => {
    bucket.timer = null;
    if (bucket.buffer.pending === 0) return;
    const batch = bucket.buffer.takePending(MAX_PER_FLUSH);
    if (winId === MAIN_BUCKET) broadcastToRegisteredWindows('devtoolbox:entries', batch);
    else sendToWindow(winId, 'devtoolbox:entries', batch);
    if (bucket.buffer.pending > 0) scheduleFlush(winId);
  }, FLUSH_INTERVAL_MS);
}

interface EmitInput {
  source: DevToolEntry['source'];
  level: DevToolLevel;
  text: string;
  origin?: string;
  tabId?: string;
  issue?: DevToolIssue;
}

function emit(winId: number, input: EmitInput): void {
  const entry: DevToolEntry = {
    id: ++sequence,
    ts: Date.now(),
    source: input.source,
    level: input.level,
    text: clip(input.text),
    origin: input.origin,
    tabId: input.tabId,
    issue: input.issue,
  };
  bucketFor(winId).buffer.push(entry);
  scheduleFlush(winId);
}

export function describeContents(wc: WebContents): { source: DevToolEntry['source']; tabId?: string; winId: number } {
  const win = getWindowForWebContents(wc);
  const winId = win?.id ?? MAIN_BUCKET;
  if (win && win.webContents.id === wc.id) return { source: 'shell', winId };
  const tabId = tabManager.getTabIdForWebContents(wc.id);
  return tabId ? { source: 'page', tabId, winId } : { source: 'page', winId };
}

export function isDevToolsContents(wc: WebContents): boolean {
  try {
    const url = wc.getURL();
    return url.startsWith('devtools://') || url.startsWith('chrome-devtools://');
  } catch {
    return false;
  }
}

function bindWebContents(wc: WebContents): void {
  if (boundContents.has(wc.id) || wc.isDestroyed()) return;
  const type = wc.getType();
  if (type !== 'browserView' && type !== 'window') return;
  // 只有真正绑定了监听器的 contents 才进集合；否则非 browserView/window
  // 的 id 会永远留着，Set 随 webContents 数量无界增长。
  boundContents.add(wc.id);

  wc.on('console-message', (_event, level, message, line, sourceId) => {
    if (isDevToolsContents(wc)) return;
    const { source, tabId, winId } = describeContents(wc);
    const origin = sourceId ? `${sourceId}:${line}` : undefined;
    emit(winId, { source, level: mapConsoleLevel(level), text: message, origin, tabId, issue: 'console' });
  });
  wc.once('destroyed', () => boundContents.delete(wc.id));
}

/** 主进程日志 → 工具箱。过滤掉自己的写入，避免递归。 */
function bindMainLog(): void {
  log.hooks.push((message, transport) => {
    if (inLogHook || transport !== log.transports.console) return message;
    const text = (message.data as unknown[]).map(stringifyArg).join(' ');
    if (!text) return message;
    inLogHook = true;
    try {
      emit(MAIN_BUCKET, {
        source: 'main',
        level: mapWarnLevel(message.level),
        text,
        origin: message.scope?.label,
        issue: classifyMainLog(text),
      });
    } finally {
      inLogHook = false;
    }
    return message;
  });
}

export function initDevToolbox(): void {
  if (started) return;
  started = true;
  bindMainLog();
  app.on('web-contents-created', (_event, wc) => bindWebContents(wc));
  for (const wc of allWebContents.getAllWebContents()) bindWebContents(wc);
  // 前端分区的 file:// 白名单要在任何视图/窗口创建之前装好
  if (!useLegacyHttp()) installDevToolsFileGuard();
  log.info('[DevToolbox] console + log pipeline ready (no CDP lease taken)');
}

/** 清空指定窗口的采集缓冲；主进程日志桶不受影响（它是全局的）。 */
export function clearDevToolEntries(winId: number = MAIN_BUCKET): void {
  bucketFor(winId).buffer.clear();
  if (winId === MAIN_BUCKET) broadcastToRegisteredWindows('devtoolbox:cleared', { ts: Date.now() });
  else sendToWindow(winId, 'devtoolbox:cleared', { ts: Date.now() });
}

/**
 * 采集缓冲快照。
 * - 指定 winId：全局主进程日志 + 该窗口自己的页面日志；
 * - 不传：全部窗口合并（探针/诊断的旧调用点语义）。
 */
export function getBufferedEntries(winId?: number): DevToolEntry[] {
  const global = bucketFor(MAIN_BUCKET).buffer.snapshot();
  if (winId === undefined) {
    const all = [...global];
    for (const [bucketId, bucket] of buckets) {
      if (bucketId !== MAIN_BUCKET) all.push(...bucket.buffer.snapshot());
    }
    return all.sort((a, b) => a.id - b.id);
  }
  if (winId === MAIN_BUCKET) return global;
  const local = bucketFor(winId).buffer.snapshot();
  return [...global, ...local].sort((a, b) => a.id - b.id);
}
