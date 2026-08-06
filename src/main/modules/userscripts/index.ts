// Userscript runtime wiring: single manager instance for the app, created
// once at startup. Value persistence (stage 2 management UI) intentionally
// starts in-memory; request/download services use the persist: session.

import { app, net, session, webContents } from 'electron';
import path from 'path';
import { mkdirSync } from 'fs';
import { UserscriptManager } from './userscript-manager';
import { ValueStore } from './userscript-store';
import { RequireCache } from './userscript-require-cache';
import { GmRequestService } from './userscript-request-service';
import { GmDownloadService } from './userscript-download-service';

let manager: UserscriptManager | null = null;
let requests: GmRequestService | null = null;
let downloads: GmDownloadService | null = null;

function fetchText(url: string, persist: Electron.Session): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, redirect: 'follow', session: persist, useSessionCookies: true });
    request.on('response', (response) => {
      if (response.statusCode && response.statusCode >= 400) {
        try { (response as unknown as { resume(): void }).resume(); } catch { /* ignore */ }
        reject(new Error(`require fetch failed: HTTP ${response.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    request.on('error', (error) => reject(error));
    request.end();
  });
}

export function initUserscriptManager(): UserscriptManager {
  if (manager) return manager;
  const persist = session.fromPartition('persist:');
  const requireCache = new RequireCache({
    fetcher: (url) => fetchText(url, persist),
  });
  requests = new GmRequestService({
    session: persist,
    allowedLoopbackHosts: ['127.0.0.1', 'localhost'],
    maxRedirects: 5,
    maxResponseBytes: 32 * 1024,
    defaultTimeoutMs: 3000,
    maxConcurrentPerScript: 2,
    maxConcurrentGlobal: 8,
  });
  const downloadDir = path.join(app.getPath('userData'), 'userscript-downloads');
  mkdirSync(downloadDir, { recursive: true });
  downloads = new GmDownloadService({
    downloadDir,
    session: persist,
    allowedLoopbackHosts: ['127.0.0.1'],
    maxBytes: 8 * 1024,
    maxConcurrentPerScript: 2,
  });
  manager = new UserscriptManager(new ValueStore(), {
    requireCache,
    sendToWc: (wcId, channel, payload) => {
      try {
        for (const wc of webContents.getAllWebContents()) {
          if (wc.id === wcId && !wc.isDestroyed()) wc.send(channel, payload);
        }
      } catch { /* view gone */ }
    },
  });
  return manager;
}

export function getUserscriptManager(): UserscriptManager | null {
  return manager;
}

export function getRequestService(): GmRequestService | null {
  return requests;
}

export function getDownloadService(): GmDownloadService | null {
  return downloads;
}
