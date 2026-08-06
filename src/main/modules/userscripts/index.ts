// Userscript runtime wiring: single manager instance for the app, created
// once at startup. Scripts are persisted via ScriptStore (electron-store);
// script VALUES stay in-memory until the data-management UI column lands.
// Request/download services use the persist: session.

import { app, net, session, webContents } from 'electron';
import path from 'path';
import { mkdirSync } from 'fs';
import { UserscriptManager } from './userscript-manager';
import { ValueStore } from './userscript-store';
import { RequireCache } from './userscript-require-cache';
import { GmRequestService } from './userscript-request-service';
import { GmDownloadService } from './userscript-download-service';
import { ScriptStore, scriptIdFor } from './script-store';
import { parseUserscriptMetadata } from './userscript-parser';
import type { InstalledUserscript } from '../../../shared/userscript-types';

let manager: UserscriptManager | null = null;
let requests: GmRequestService | null = null;
let downloads: GmDownloadService | null = null;
let scriptStore: ScriptStore | null = null;

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

function reloadManagerScripts(): void {
  if (!manager || !scriptStore) return;
  manager.loadScripts(scriptStore.list());
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
  scriptStore = new ScriptStore();
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
  reloadManagerScripts();
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

// ---------------------------------------------------------------------------
// Script management (stage 2): install / uninstall / enable / update backed
// by the persistent ScriptStore. The manager is reloaded after every change
// so snapshots always reflect the stored list.
// ---------------------------------------------------------------------------

export type UserscriptInstallResult =
  | { ok: true; script: InstalledUserscript; replaced: boolean }
  | { ok: false; error: string };

export function installUserscript(source: string, options?: { enabled?: boolean; id?: string }): UserscriptInstallResult {
  if (!manager || !scriptStore) return { ok: false, error: 'runtime not initialized' };
  const metadata = parseUserscriptMetadata(source);
  if (!metadata) return { ok: false, error: 'no valid // ==UserScript== metadata block' };
  if (metadata.name === '') return { ok: false, error: 'script has no @name' };
  const now = Date.now();
  const baseId = options?.id ?? scriptIdFor(metadata.name, metadata.namespace ?? '');
  const existing = scriptStore.get(baseId);
  let id = baseId;
  let suffix = 2;
  while (scriptStore.get(id) && existing?.id !== id) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }
  const replaced = existing !== undefined;
  const script: InstalledUserscript = {
    id,
    source,
    enabled: options?.enabled ?? true,
    metadata,
    installedAt: replaced ? (existing as InstalledUserscript).installedAt : now,
    updatedAt: now,
    revision: (replaced ? (existing as InstalledUserscript).revision : 0) + 1,
  };
  try {
    scriptStore.save(script);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  reloadManagerScripts();
  return { ok: true, script, replaced };
}

export function uninstallUserscript(id: string): boolean {
  if (!scriptStore) return false;
  const removed = scriptStore.remove(id);
  if (removed) reloadManagerScripts();
  return removed;
}

export function setUserscriptEnabled(id: string, enabled: boolean): boolean {
  if (!scriptStore) return false;
  const script = scriptStore.get(id);
  if (!script) return false;
  scriptStore.save({ ...script, enabled, updatedAt: Date.now() });
  reloadManagerScripts();
  return true;
}

export function updateUserscriptSource(id: string, source: string): UserscriptInstallResult {
  if (!scriptStore) return { ok: false, error: 'runtime not initialized' };
  const existing = scriptStore.get(id);
  if (!existing) return { ok: false, error: 'script not found' };
  return installUserscript(source, { enabled: existing.enabled, id });
}

export function listUserscripts(): InstalledUserscript[] {
  return scriptStore?.list() ?? [];
}

export function getUserscriptSource(id: string): string | undefined {
  return scriptStore?.get(id)?.source;
}
