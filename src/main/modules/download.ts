import { DownloadItem, app, session } from 'electron';
import log from 'electron-log';
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { loadConfig } from './config';
import { getMainWindow } from './window';
import { availableSavePath, isPathWithinDirectory, sanitizeDownloadFilename } from '../utils/download-path';
import { flushDownloadState, getDownloadRecord, updateDownloadRecord } from './download-state';
import type { DownloadItem as DownloadRecord } from '@shared/types/downloads';
import { redactUrlForLog } from '@shared/utils/url-privacy';
import { createAria2RpcClient, type Aria2RpcClient } from './aria2-rpc';
import { getAria2Candidates, getAria2LibraryDirectory, type Aria2Candidate } from './aria2-locator';

// ─── aria2 configuration ────────────────────────────────────────────
const DEFAULT_DIR = path.join(app.getPath('downloads'), 'BaoFlashBrowser');

export function getDownloadDir(): string {
  const cfg = loadConfig().downloadDir;
  return cfg || DEFAULT_DIR;
}

// ─── globals ────────────────────────────────────────────────────────
let aria2Process: ChildProcess | null = null;
let aria2Ready = false;
let aria2RpcClient: Aria2RpcClient | null = null;
const aria2Gids = new Map<string, string>(); // dlId -> aria2 GID
const aria2PollTimers = new Map<string, ReturnType<typeof setTimeout>>();
const chromiumItems = new Map<string, DownloadItem>(); // dlId -> DownloadItem
const pendingChromiumRetries = new Map<string, DownloadRecord[]>();

// ─── IPC send helper ────────────────────────────────────────────────
function send(channel: string, payload: unknown): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function sendLog(tag: string, msg: string): void {
  send('log', { tag, msg, ts: Date.now() });
}

function emitDownload(patch: Partial<DownloadRecord> & Pick<DownloadRecord, 'id' | 'state'>): void {
  const record = updateDownloadRecord(patch);
  if (record) send('download:progress', record);
}

// ─── aria2 RPC ──────────────────────────────────────────────────────
function aria2Rpc(method: string, ...params: unknown[]): Promise<any> {
  if (!aria2RpcClient) return Promise.reject(new Error('aria2 RPC is not initialized'));
  return aria2RpcClient.call(method, ...params);
}

// ─── aria2 child process ────────────────────────────────────────────
// Tries each candidate in priority order. For each candidate:
//   1. Spawn the process
//   2. Race RPC-readiness vs early process death (ENOENT, EACCES, missing libs)
//   3. If RPC responds → keep this candidate; otherwise kill and try the next
// Returns true if any candidate succeeded, false if all failed (→ Chromium fallback).
async function startAria2(): Promise<boolean> {
  const candidates = getAria2Candidates();
  if (candidates.length === 0) {
    sendLog('aria2', 'aria2 binary not found — using Chromium fallback');
    return false;
  }

  if (!fs.existsSync(DEFAULT_DIR)) {
    fs.mkdirSync(DEFAULT_DIR, { recursive: true });
  }

  aria2RpcClient = await createAria2RpcClient();
  log.info('[Download] aria2 candidates:', candidates.map(c => `${c.path} (${c.bundled ? 'bundled' : 'system'})`));

  for (const candidate of candidates) {
    const ok = await tryStartCandidate(candidate);
    if (ok) return true;
  }

  aria2RpcClient = null;
  sendLog('aria2', 'all aria2 candidates failed — using Chromium fallback');
  return false;
}

async function tryStartCandidate(candidate: Aria2Candidate): Promise<boolean> {
  const rpcClient = aria2RpcClient;
  if (!rpcClient) return false;
  sendLog('aria2', `trying ${candidate.bundled ? 'bundled' : 'system'}: ${candidate.path}`);

  const env: NodeJS.ProcessEnv = { ...process.env, LANG: 'C', LC_ALL: 'C' };
  // Bundled Linux aria2 may need libaria2.so.0 on LD_LIBRARY_PATH
  if (process.platform === 'linux' && candidate.bundled) {
    const libDir = getAria2LibraryDirectory();
    if (libDir) {
      env.LD_LIBRARY_PATH = libDir + (env.LD_LIBRARY_PATH ? ':' + env.LD_LIBRARY_PATH : '');
    }
  }

  let child: ChildProcess;
  try {
    child = spawn(candidate.path, [
      '--enable-rpc',
      '--rpc-listen-port=' + rpcClient.port,
      '--rpc-allow-origin-all',
      '--rpc-secret=' + rpcClient.secret,
      '--max-concurrent-downloads=5',
      '--max-connection-per-server=16',
      '--split=16',
      '--min-split-size=1M',
      '--continue=true',
      '--auto-file-renaming=true',
      '--allow-overwrite=false',
      '--console-log-level=error',
    ], { stdio: ['ignore', 'ignore', 'ignore'], env, windowsHide: true });
  } catch (err: any) {
    log.warn(`[Download] aria2 spawn exception: ${candidate.path} — ${err?.message}`);
    return false;
  }

  // Race RPC readiness against early process death (ENOENT, EACCES, missing libs, etc.)
  const earlyFailure = new Promise<never>((_, reject) => {
    child.once('error', (err) => reject(new Error(`error: ${err.message}`)));
    child.once('exit', (code) => {
      if (code !== 0) reject(new Error(`early exit code=${code}`));
    });
  });

  const readyPromise = waitAria2Ready().then((ok) => {
    if (!ok) throw new Error('RPC not ready after retries');
    return ok;
  });

  try {
    await Promise.race([readyPromise, earlyFailure]);
  } catch (err: any) {
    log.warn(`[Download] aria2 candidate failed: ${candidate.path} — ${err.message}`);
    try { child.kill('SIGKILL'); } catch { /* best-effort kill, ignore ESRCH/EPERM */ }
    return false;
  }

  // Success — detach early-failure listeners, attach permanent handlers
  child.removeAllListeners('error');
  child.removeAllListeners('exit');

  child.stdout?.on('data', (buf: Buffer) => {
    const line = buf.toString('utf-8').trim();
    if (line) sendLog('aria2', line);
  });
  // stderr 仅 log.warn + 截断，不通过 IPC 发送到渲染进程
  child.stderr?.on('data', (buf: Buffer) => {
    const line = buf.toString().trim();
    if (line) log.warn('[Aria2] stderr:', line.slice(0, 200));
  });
  child.on('exit', (code) => {
    aria2Ready = false;
    for (const id of aria2Gids.keys()) {
      const timer = aria2PollTimers.get(id);
      if (timer) clearTimeout(timer);
      emitDownload({ id, state: 'interrupted', speed: 0, engine: 'aria2' });
    }
    aria2PollTimers.clear();
    aria2Gids.clear();
    sendLog('aria2', `exited code=${code}`);
  });

  aria2Process = child;
  sendLog('aria2', `RPC ready — PID=${child.pid} port=${rpcClient.port} src=${candidate.bundled ? 'bundled' : 'system'}`);
  return true;
}

async function waitAria2Ready(retries = 20): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    try {
      await aria2Rpc('aria2.getVersion');
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return false;
}

function killAria2(): void {
  for (const timer of aria2PollTimers.values()) clearTimeout(timer);
  aria2PollTimers.clear();
  aria2Gids.clear();
  if (aria2Process) {
    aria2Process.kill();
    aria2Process = null;
  }
  aria2RpcClient = null;
  flushDownloadState();
}

// ─── Chromium download tracking ─────────────────────────────────────
function trackChromiumDownload(item: DownloadItem, retry?: DownloadRecord): void {
  const dlId = retry?.id || 'cr_' + nanoid(8);
  const filename = sanitizeDownloadFilename(retry?.filename || item.getFilename() || 'download');
  const dir = getDownloadDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const requestedPath = retry?.savePath && isPathWithinDirectory(dir, retry.savePath)
    ? retry.savePath
    : path.join(dir, filename);
  const savePath = fs.existsSync(requestedPath) ? availableSavePath(dir, filename) : requestedPath;
  item.setSavePath(savePath);
  let lastBytes = 0;
  let lastTime = Date.now();

  chromiumItems.set(dlId, item);
  log.info('[Download] chromium start:', filename, '->', savePath);

  emitDownload({
    id: dlId,
    url: item.getURL(),
    filename,
    state: 'progressing',
    progress: 0,
    speed: 0,
    receivedBytes: 0,
    totalBytes: item.getTotalBytes(),
    savePath,
    engine: 'chromium',
  });

  item.on('updated', () => {
    const now = Date.now();
    const received = item.getReceivedBytes();
    const total = item.getTotalBytes();
    const elapsed = (now - lastTime) / 1000;
    const speed = elapsed > 0 ? (received - lastBytes) / elapsed : 0;
    const progress = total > 0 ? (received / total) * 100 : 0;

    lastBytes = received;
    lastTime = now;

    emitDownload({
      id: dlId,
      filename,
      state: 'progressing',
      progress: Math.min(progress, 99.9),
      speed,
      receivedBytes: received,
      totalBytes: total,
      savePath,
      engine: 'chromium',
    });
  });

  item.once('done', (_ev, state) => {
    const finalState =
      state === 'completed' ? 'completed' :
      state === 'cancelled' ? 'cancelled' : 'interrupted';

    chromiumItems.delete(dlId);
    log.info('[Download] chromium done:', filename, '->', finalState);

    emitDownload({
      id: dlId,
      filename,
      url: item.getURL(),
      state: finalState,
      progress: finalState === 'completed' ? 100 : 0,
      speed: 0,
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      savePath,
      engine: 'chromium',
    });
  });
}

// ─── aria2 download ─────────────────────────────────────────────────
async function aria2Download(url: string, filename: string, retry?: DownloadRecord): Promise<void> {
  filename = sanitizeDownloadFilename(filename);
  const dlId = retry?.id || 'a2_' + nanoid(8);
  const configuredDir = getDownloadDir();
  const retryPath = retry?.savePath && isPathWithinDirectory(configuredDir, retry.savePath) ? retry.savePath : '';
  const dir = retryPath ? path.dirname(retryPath) : configuredDir;
  if (retryPath) filename = path.basename(retryPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  emitDownload({
    id: dlId,
    url,
    filename,
    state: 'progressing',
    progress: 0,
    speed: 0,
    receivedBytes: 0,
    totalBytes: 0,
    savePath: path.join(dir, filename),
    engine: 'aria2',
  });

  try {
    const gid = await aria2Rpc('aria2.addUri', [url], { out: filename, dir });
    aria2Gids.set(dlId, gid);
    log.info('[Download] aria2 addUri OK:', gid, filename);
    pollAria2Status(dlId, gid, filename, url);
  } catch (err: any) {
    log.error('[Download] aria2 addUri FAILED:', err.message);
    emitDownload({
      id: dlId,
      filename,
      state: 'interrupted',
      progress: 0,
      speed: 0,
      engine: 'aria2',
    });
  }
}

async function pollAria2Status(dlId: string, gid: string, filename: string, url: string): Promise<void> {
  let errorCount = 0;
  const schedule = (delay: number) => {
    const existing = aria2PollTimers.get(dlId);
    if (existing) clearTimeout(existing);
    aria2PollTimers.set(dlId, setTimeout(poll, delay));
  };
  const poll = async () => {
    try {
      const status = await aria2Rpc('aria2.tellStatus', gid, [
        'totalLength', 'completedLength', 'downloadSpeed', 'status', 'files',
      ]);

      const total = parseInt(status.totalLength) || 0;
      const completed = parseInt(status.completedLength) || 0;
      const speed = parseInt(status.downloadSpeed) || 0;
      const progress = total > 0 ? (completed / total) * 100 : 0;

      let state: DownloadRecord['state'] = 'progressing';
      if (status.status === 'complete') state = 'completed';
      else if (status.status === 'error') state = 'interrupted';
      else if (status.status === 'removed') state = 'cancelled';
      else if (status.status === 'paused') state = 'paused';

      const savePath = status.files?.[0]?.path || path.join(getDownloadDir(), gid);

      emitDownload({
        id: dlId,
        filename,
        url,
        state,
        progress: Math.min(progress, 99.9),
        speed,
        receivedBytes: completed,
        totalBytes: total,
        savePath,
        engine: 'aria2',
      });

      if (state === 'progressing') {
        schedule(500);
      } else if (state === 'paused') {
        schedule(1000);
      } else {
        log.info('[Download] aria2 finished:', gid, state);
        const timer = aria2PollTimers.get(dlId);
        if (timer) clearTimeout(timer);
        aria2PollTimers.delete(dlId);
        aria2Gids.delete(dlId);
      }
    } catch (err: any) {
      if (!aria2Gids.has(dlId)) return;
      errorCount++;
      if (errorCount > 5) {
        aria2Gids.delete(dlId);
        aria2PollTimers.delete(dlId);
        emitDownload({ id: dlId, state: 'interrupted', speed: 0, engine: 'aria2', filename, url });
        return;
      }
      log.warn('[Download] aria2 poll retry:', errorCount, err.message);
      schedule(1000);
    }
  };

  poll();
}

// ─── public API ─────────────────────────────────────────────────────
export function getAria2Status(): { ready: boolean; port: number; dir: string } {
  return { ready: aria2Ready, port: aria2RpcClient?.port || 0, dir: getDownloadDir() };
}

export function initDownloadManager(): void {
  const dir = getDownloadDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Start aria2 with fallback chain: bundled → system (Linux) → Chromium
  // startAria2() is async and tries each candidate; while it runs, downloads
  // temporarily use Chromium until aria2:status is broadcast.
  startAria2().then((ready) => {
    aria2Ready = ready;
    send('aria2:status', { ready, port: aria2RpcClient?.port || 0, dir: getDownloadDir() });
  }).catch((error) => {
    aria2Ready = false;
    aria2RpcClient = null;
    log.warn('[Download] aria2 initialization failed:', error instanceof Error ? error.message : String(error));
    send('aria2:status', { ready: false, port: 0, dir: getDownloadDir() });
  });

  log.info('[Download] manager initialized');
}

export function setupDownloadHandlers(sess: Electron.Session): void {
  sess.on('will-download', (event, item) => {
    const engine = loadConfig().downloadEngine;
    log.info('[Download] will-download: engine=' + engine + ', aria2Ready=' + aria2Ready + ', url=' + redactUrlForLog(item.getURL()));

    if (engine === 'aria2' && aria2Ready) {
      event.preventDefault();
      aria2Download(item.getURL(), item.getFilename() || 'download');
      return;
    }

    if (engine === 'aria2' && !aria2Ready) {
      log.warn('[Download] aria2 selected but NOT ready — falling back to Chromium');
    }

    // Chromium mode — track with real-time progress. A restart retry keeps the
    // existing record id, but never overwrites a completed file.
    const retryQueue = pendingChromiumRetries.get(item.getURL());
    const retry = retryQueue?.shift();
    if (retryQueue && retryQueue.length === 0) pendingChromiumRetries.delete(item.getURL());
    trackChromiumDownload(item, retry);
  });
}

export function cancelDownload(id: string): void {
  if (id.startsWith('a2_')) {
    const gid = aria2Gids.get(id);
    aria2Gids.delete(id);
    const timer = aria2PollTimers.get(id);
    if (timer) clearTimeout(timer);
    aria2PollTimers.delete(id);
    if (gid && aria2Ready) {
      aria2Rpc('aria2.remove', gid).catch((err) => {
        log.error('[Download] aria2 remove failed:', err.message);
      });
    }
    emitDownload({ id, state: 'cancelled', speed: 0 });
  } else if (id.startsWith('cr_')) {
    const item = chromiumItems.get(id);
    if (item) {
      item.cancel();
      chromiumItems.delete(id);
      log.info('[Download] chromium cancelled:', id);
    } else {
      log.warn('[Download] chromium item not found for cancel:', id);
    }
  }
}

export function pauseDownload(id: string): void {
  if (id.startsWith('a2_')) {
    const gid = aria2Gids.get(id);
    if (gid && aria2Ready) {
      aria2Rpc('aria2.pause', gid).catch((err) => {
        log.error('[Download] aria2 pause failed:', err.message);
      });
    }
    emitDownload({ id, state: 'paused', speed: 0 });
  } else if (id.startsWith('cr_')) {
    const item = chromiumItems.get(id);
    if (item) {
      item.pause();
      emitDownload({ id, state: 'paused', speed: 0 });
      log.info('[Download] chromium paused:', id);
    }
  }
}

export function resumeDownload(id: string): void {
  if (id.startsWith('a2_')) {
    const gid = aria2Gids.get(id);
    if (gid && aria2Ready) {
      aria2Rpc('aria2.unpause', gid).catch((err) => {
        log.error('[Download] aria2 unpause failed:', err.message);
      });
      emitDownload({ id, state: 'progressing', speed: 0 });
      return;
    }
    const record = getDownloadRecord(id);
    if (record?.url && aria2Ready) {
      aria2Download(record.url, record.filename, record).catch((err) => {
        log.error('[Download] aria2 restart retry failed:', err.message);
        emitDownload({ id, state: 'interrupted', speed: 0 });
      });
    } else {
      log.warn('[Download] aria2 resume unavailable:', id, 'ready=' + aria2Ready);
      emitDownload({ id, state: 'interrupted', speed: 0 });
    }
  } else if (id.startsWith('cr_')) {
    const item = chromiumItems.get(id);
    if (item) {
      item.resume();
      emitDownload({ id, state: 'progressing', speed: 0 });
      log.info('[Download] chromium resumed:', id);
      return;
    }
    const record = getDownloadRecord(id);
    if (record?.url) {
      const queue = pendingChromiumRetries.get(record.url) || [];
      queue.push(record);
      pendingChromiumRetries.set(record.url, queue);
      session.defaultSession.downloadURL(record.url);
      log.info('[Download] chromium restart retry:', id);
    }
  }
}

export function isAria2Ready(): boolean {
  return aria2Ready;
}

export { killAria2 };
