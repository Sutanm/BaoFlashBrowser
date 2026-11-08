import { app, webContents as allWebContents, type WebContents } from 'electron';
import log from 'electron-log';
import type { DevToolEntry, DevToolIssue, DevToolLevel } from '@shared/types/devtoolbox';
import { classifyMainLog, clip, EntryBuffer, mapConsoleLevel } from './devtoolbox-buffer';
import { installDevToolsFileGuard, useLegacyHttp } from './devtoolbox-frontend-server';
import { getMainWindow } from './window';
import { tabManager } from './tabs';

const MAX_ENTRIES = 2000;
const FLUSH_INTERVAL_MS = 80;
const MAX_PER_FLUSH = 400;

let sequence = 0;
const buffer = new EntryBuffer(MAX_ENTRIES);
let flushTimer: NodeJS.Timeout | null = null;
let started = false;
let inLogHook = false;
const boundContents = new Set<number>();

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

function sendToRenderer(channel: string, payload: unknown): void {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (!wc || wc.isDestroyed()) return;
  try {
    wc.send(channel, payload);
  } catch {
    // 渲染层正在销毁时静默丢弃：绝不能在管道里再次写日志（会递归回 hook）
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (buffer.pending === 0) return;
    const batch = buffer.takePending(MAX_PER_FLUSH);
    sendToRenderer('devtoolbox:entries', batch);
    if (buffer.pending > 0) scheduleFlush();
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

function emit(input: EmitInput): void {
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
  buffer.push(entry);
  scheduleFlush();
}

export function describeContents(wc: WebContents): { source: DevToolEntry['source']; tabId?: string } {
  const shell = getMainWindow()?.webContents;
  if (shell && !shell.isDestroyed() && shell.id === wc.id) return { source: 'shell' };
  const tabId = tabManager.getTabIdForWebContents(wc.id);
  return tabId ? { source: 'page', tabId } : { source: 'page' };
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
    const { source, tabId } = describeContents(wc);
    const origin = sourceId ? `${sourceId}:${line}` : undefined;
    emit({ source, level: mapConsoleLevel(level), text: message, origin, tabId, issue: 'console' });
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
      emit({
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
  // 前端分区的 file:// 白名单要在任何视图/窗口加载之前装好
  if (!useLegacyHttp()) installDevToolsFileGuard();
  log.info('[DevToolbox] console + log pipeline ready (no CDP lease taken)');
}

export function clearDevToolEntries(): void {
  buffer.clear();
  sendToRenderer('devtoolbox:cleared', { ts: Date.now() });
}

export function getBufferedEntries(): DevToolEntry[] {
  return buffer.snapshot();
}
