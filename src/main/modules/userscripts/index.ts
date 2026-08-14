// Userscript runtime wiring: single manager instance for the app, created
// once at startup. Scripts are persisted via ScriptStore (electron-store);
// script VALUES stay in-memory until the data-management UI column lands.
// Request/download services use the persist: session.

import { app, BrowserWindow, session, webContents } from 'electron';
import path from 'path';
import { mkdirSync } from 'fs';
import { UserscriptManager } from './userscript-manager';
import { ValueStore } from './userscript-store';
import { RequireCache } from './userscript-require-cache';
import { GmRequestService } from './userscript-request-service';
import { GmDownloadService } from './userscript-download-service';
import { GmCookieService } from './userscript-cookie-service';
import { ScriptStore, scriptIdFor } from './script-store';
import { parseUserscriptMetadata } from './userscript-parser';
import { compareVersions, updateHostAllowed } from './userscript-versions';
import { loadConfig, type Config } from '../config';
import { createBackgroundRuntime, type BackgroundRuntime } from './userscript-background';
import { createWebRequestObserver, type WebRequestObserver } from './userscript-web-request';
import type { InstalledUserscript, UserscriptUpdateInfo } from '../../../shared/userscript-types';
// Bundled built-in userscripts are embedded as text at build time (see
// esbuild.main.config.mjs loader). css-fixer.user.js is generated from
// bundled-scripts/css-fixer-entry.ts by scripts/build-css-fixer.mjs.
import cssFixerSource from './bundled-scripts/css-fixer.user.js';
import automationFrameAssistantSource from './bundled-scripts/automation-frame-assistant.user.js';

export const AUTOMATION_ASSISTANT_SCRIPT_ID = scriptIdFor('BaoFlash 页面悬浮相框助手', 'bao-flash-browser');

// Built-in scripts: installed automatically on first launch, then treated
// like any other userscript (editable, disable-able, deletable; a deleted
// built-in returns on the next launch since it is installed when missing).
// Version bumps in the bundled source update non-edited installs, so fixes
// shipped in a new build reach users; scripts the user has saved through
// the editor (edited=true) are never overwritten. Updates are upgrade-only:
// an OLD build (stale dist) must never downgrade a newer stored version.
const BUNDLED_SCRIPTS: Array<{ id: string; source: string }> = [
  {
    id: scriptIdFor('BaoFlash Modern CSS Fixer', 'bao-flash-browser'),
    source: cssFixerSource,
  },
  {
    id: AUTOMATION_ASSISTANT_SCRIPT_ID,
    source: automationFrameAssistantSource,
  },
];

function ensureBundledScripts(): void {
  if (!scriptStore) return;
  for (const bundled of BUNDLED_SCRIPTS) {
    const stored = scriptStore.get(bundled.id);
    if (!stored) {
      installUserscript(bundled.source, { id: bundled.id });
      continue;
    }
    if (stored.edited) continue;
    const bundledMetadata = parseUserscriptMetadata(bundled.source);
    const bundledVersion = bundledMetadata?.version ?? '';
    // Updates are upgrade-only: never let a stale (old-build) dist downgrade
    // a newer stored version. @updateHash is the primary signal (content
    // changed -> hash changed -> update), while the version check guarantees
    // a genuinely older build never clobbers a newer store.
    const versionOk = !bundledVersion || compareVersions(bundledVersion, stored.metadata.version) >= 0;
    if (!versionOk) continue;
    const hashChanged = !!bundledMetadata?.updateHash && bundledMetadata.updateHash !== stored.metadata.updateHash;
    const versionBumped = !!bundledVersion && compareVersions(bundledVersion, stored.metadata.version) > 0;
    if (hashChanged || versionBumped) {
      installUserscript(bundled.source, { id: bundled.id, enabled: stored.enabled });
    }
  }
}

// Re-run the built-in install/update pass (used at startup; exported for
// the smoke to simulate an old bundled version appearing).
export { ensureBundledScripts };

let manager: UserscriptManager | null = null;
let requests: GmRequestService | null = null;
let downloads: GmDownloadService | null = null;
let cookies: GmCookieService | null = null;
let scriptStore: ScriptStore | null = null;
let backgroundRuntime: BackgroundRuntime | null = null;
let webRequestObserver: WebRequestObserver | null = null;

// Broadcast a change signal to every window so open management pages /
// sidebar panels refresh without a restart (single-source-of-truth is the
// store; the renderer just re-queries).
function broadcastUserscriptsChanged(): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('userscripts:changed');
    }
  } catch { /* no windows yet (init-time reload) */ }
}

function reloadManagerScripts(): void {
  if (!manager || !scriptStore) return;
  manager.loadScripts(scriptStore.list());
  // Full metadata rules drive GM_webRequest filtering; clear removed scripts too.
  webRequestObserver?.clearMatches();
  for (const script of scriptStore.list()) {
    webRequestObserver?.setMatch(script.id, {
      match: script.metadata.match,
      include: script.metadata.include,
      exclude: script.metadata.exclude,
      excludeMatch: script.metadata.excludeMatch,
    });
  }
  // Script set changed → sync the background window pool (create/destroy
  // per-script windows; new wcs re-query get-config).
  backgroundRuntime?.sync();
  broadcastUserscriptsChanged();
}

export function initUserscriptManager(): UserscriptManager {
  if (manager) return manager;
  const persist = session.fromPartition('persist:');
  // 容量配置来自设置页(config store);applyCapacityConfig 支持保存后热更新
  const cfg = loadConfig();
  requests = new GmRequestService({
    session: persist,
    allowedLoopbackHosts: ['127.0.0.1', 'localhost'],
    maxRedirects: 5,
    maxResponseBytes: cfg.userscriptMaxResponseMB * 1024 * 1024,
    defaultTimeoutMs: cfg.userscriptTimeoutSeconds * 1000,
    maxConcurrentPerScript: cfg.userscriptMaxConcurrentPerScript,
    maxConcurrentGlobal: cfg.userscriptMaxConcurrentGlobal,
  });
  // @require/@resource use the same redirect/address validation as GM XHR,
  // but a separate, deliberately small capacity pool and no loopback grant.
  const requireRequests = new GmRequestService({
    session: persist,
    allowedLoopbackHosts: [],
    maxRedirects: 5,
    maxResponseBytes: 512 * 1024,
    defaultTimeoutMs: 15_000,
    maxConcurrentPerScript: 4,
    maxConcurrentGlobal: 4,
  });
  const requireCache = new RequireCache({
    maxTotalBytes: 512 * 1024,
    fetcher: async (url) => {
      const result = await requireRequests.request(-2, '__require__', url, ['*'], { method: 'GET', url });
      if (!result.ok || !result.response) throw new Error(result.error ?? 'require fetch failed');
      if (result.response.status >= 400) throw new Error(`require fetch failed: HTTP ${result.response.status}`);
      return result.response.responseText;
    },
  });
  const downloadDir = path.join(app.getPath('userData'), 'userscript-downloads');
  mkdirSync(downloadDir, { recursive: true });
  downloads = new GmDownloadService({
    downloadDir,
    session: persist,
    allowedLoopbackHosts: ['127.0.0.1'],
    maxBytes: cfg.userscriptDownloadMaxMB * 1024 * 1024,
    maxConcurrentPerScript: cfg.userscriptDownloadConcurrent,
  });
  scriptStore = new ScriptStore();
  cookies = new GmCookieService();
  // GM 值上限可配置(设置页,重启生效);maxValueBytes 在构造时固定
  const valueStore = new ValueStore({ maxValueBytes: cfg.userscriptMaxValueKB * 1024 });
  // GM_webRequest observer: events are filtered by each script's @match rules
  // and sent to the registering view. setSend is wired to the same webContents
  // scan as the manager's value broadcasts.
  webRequestObserver = createWebRequestObserver();
  webRequestObserver.setSend((wcId, channel, payload) => {
    try {
      for (const wc of webContents.getAllWebContents()) {
        if (wc.id === wcId && !wc.isDestroyed()) wc.send(channel, payload);
      }
    } catch { /* view gone */ }
  });
  manager = new UserscriptManager(valueStore, {
    requireCache,
    onViewRemoved: (wcId) => webRequestObserver?.unregisterForWc(wcId),
    sendToWc: (wcId, channel, payload) => {
      try {
        for (const wc of webContents.getAllWebContents()) {
          if (wc.id === wcId && !wc.isDestroyed()) wc.send(channel, payload);
        }
      } catch { /* view gone */ }
    },
    persistValues: {
      file: path.join(app.getPath('userData'), 'userscript-values.json'),
      debounceMs: 200,
      urgentBytes: 1024,
    },
  });
  // GM 值跨重启持久化:启动时加载,退出前同步 flush(崩溃/断电可能丢最近 debounce 窗口)
  manager.loadValues(path.join(app.getPath('userData'), 'userscript-values.json'));
  app.on('before-quit', () => {
    backgroundRuntime?.stop();
    manager?.flushValues();
  });
  // Install built-in scripts that are missing or outdated (see
  // ensureBundledScripts: user edits/deletes respected).
  ensureBundledScripts();
  reloadManagerScripts();
  // @background runtime: per-script hidden windows hosting background scripts.
  // BAO_USERSCRIPT_PRELOAD_PATH is a test-only override (smoke bundles live in
  // release/tests/, where __dirname has no webview-preload.js).
  backgroundRuntime = createBackgroundRuntime({
    preloadPath: process.env.BAO_USERSCRIPT_PRELOAD_PATH || path.join(__dirname, 'webview-preload.js'),
    manager,
    partition: 'persist:',
    listBackgroundScripts: () => (manager?.backgroundScripts() ?? []),
  });
  backgroundRuntime.start();
  return manager;
}

export function getUserscriptManager(): UserscriptManager | null {
  return manager;
}

export function getBackgroundRuntime(): BackgroundRuntime | null {
  return backgroundRuntime;
}

export function getRequestService(): GmRequestService | null {
  return requests;
}

export function getDownloadService(): GmDownloadService | null {
  return downloads;
}

export function getCookieService(): GmCookieService | null {
  return cookies;
}

export function getWebRequestObserver(): WebRequestObserver | null {
  return webRequestObserver;
}

// Hot-apply capacity limits from the settings panel (called by config IPC
// after a successful save; also used at init via loadConfig).
export function applyCapacityConfig(cfg: Partial<Config>): void {
  if (cfg.userscriptMaxResponseMB !== undefined) {
    requests?.setLimits({ maxResponseBytes: cfg.userscriptMaxResponseMB * 1024 * 1024 });
  }
  if (cfg.userscriptTimeoutSeconds !== undefined) {
    requests?.setLimits({ defaultTimeoutMs: cfg.userscriptTimeoutSeconds * 1000 });
  }
  if (cfg.userscriptMaxConcurrentPerScript !== undefined) {
    requests?.setLimits({ maxConcurrentPerScript: cfg.userscriptMaxConcurrentPerScript });
  }
  if (cfg.userscriptMaxConcurrentGlobal !== undefined) {
    requests?.setLimits({ maxConcurrentGlobal: cfg.userscriptMaxConcurrentGlobal });
  }
  if (cfg.userscriptDownloadMaxMB !== undefined) {
    downloads?.setLimits({ maxBytes: cfg.userscriptDownloadMaxMB * 1024 * 1024 });
  }
  if (cfg.userscriptDownloadConcurrent !== undefined) {
    downloads?.setLimits({ maxConcurrentPerScript: cfg.userscriptDownloadConcurrent });
  }
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
  if (removed) {
    manager?.clearScriptValues(id);
    reloadManagerScripts();
  }
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
  const result = installUserscript(source, { enabled: existing.enabled, id });
  if (result.ok) {
    // Mark as user-edited so built-in version updates never overwrite it.
    scriptStore.save({ ...result.script, edited: true });
  }
  return result;
}

// Toggle the user-edited flag (applyUpdate clears it after installing a new
// version, which replaces the user's edits).
export function setUserscriptEdited(id: string, edited: boolean): boolean {
  if (!scriptStore) return false;
  const script = scriptStore.get(id);
  if (!script) return false;
  scriptStore.save({ ...script, edited, updatedAt: Date.now() });
  reloadManagerScripts();
  return true;
}

export function listUserscripts(): InstalledUserscript[] {
  return scriptStore?.list() ?? [];
}

export function getUserscriptSource(id: string): string | undefined {
  return scriptStore?.get(id)?.source;
}

// ---------------------------------------------------------------------------
// @updateURL manual update service (checkUpdates / applyUpdate).
// Security: all fetches go through GmRequestService with @connect validation;
// the update source host must also pass updateHostAllowed (userscript-versions).
// ---------------------------------------------------------------------------

const UPDATER_SCRIPT_ID = '__platform_updater__';
// pageUrl must parse (new URL('') throws → connectAllows returns false): a
// data: URL has origin 'null', so same-origin can never match and only the
// @connect list gates — same semantics as the @background runtime.
const UPDATER_PAGE_URL = 'data:text/html;charset=utf-8,';

interface LatestVersion {
  ok: boolean;
  version?: string;
  /** The script body to install (body path, or manifest-resolved updateURL path). */
  bodyText?: string;
  error?: string;
}

async function fetchUpdateText(connect: string[], url: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const requests = getRequestService();
  if (!requests) return { ok: false, error: 'not-ready' };
  const result = await requests.request(-1, UPDATER_SCRIPT_ID, UPDATER_PAGE_URL, connect, { method: 'GET', url });
  if (!result.ok) return { ok: false, error: result.error ?? 'network' };
  return { ok: true, text: result.response?.responseText ?? '' };
}

// Dual path: try a JSON manifest { version, updateURL? } first; when it
// carries updateURL, resolve it against the updateUrl base and re-fetch the
// real script body. Non-JSON bodies are treated as the script itself.
async function fetchLatestVersion(script: InstalledUserscript, updateUrl: string): Promise<LatestVersion> {
  if (!updateHostAllowed(script.metadata.connect, script.metadata.match, updateUrl)) {
    return { ok: false, error: 'host-not-allowed' };
  }
  const fetched = await fetchUpdateText(script.metadata.connect, updateUrl);
  if (!fetched.ok) return fetched;

  let json: { version?: unknown; updateURL?: unknown } | null = null;
  try {
    const parsed = JSON.parse(fetched.text) as { version?: unknown; updateURL?: unknown };
    if (parsed && typeof parsed === 'object') json = parsed;
  } catch { /* not JSON → body path */ }

  if (json && typeof json.version === 'string' && json.version) {
    if (typeof json.updateURL === 'string' && json.updateURL) {
      let bodyUrl: string;
      try {
        bodyUrl = new URL(json.updateURL, updateUrl).href;
      } catch {
        return { ok: false, error: 'invalid-manifest-url' };
      }
      const body = await fetchUpdateText(script.metadata.connect, bodyUrl);
      if (!body.ok) return body;
      const meta = parseUserscriptMetadata(body.text);
      if (!meta) return { ok: false, error: 'invalid-script-body' };
      return { ok: true, version: meta.version, bodyText: body.text };
    }
    // JSON manifest without updateURL has no installable artifact.
    return { ok: false, error: 'invalid-manifest' };
  }

  const meta = parseUserscriptMetadata(fetched.text);
  if (!meta) return { ok: false, error: 'invalid-script-body' };
  return { ok: true, version: meta.version, bodyText: fetched.text };
}

// Serial by design; concurrent callers share the same in-flight run (dedupe).
let updatesInflight: Promise<{ updates: UserscriptUpdateInfo[] }> | null = null;

async function runCheckUpdates(): Promise<{ updates: UserscriptUpdateInfo[] }> {
  const updates: UserscriptUpdateInfo[] = [];
  for (const script of listUserscripts()) {
    if (script.edited) continue; // user-edited scripts are never auto-overwritten
    const updateUrl = script.metadata.updateUrl;
    if (!updateUrl) continue;
    const latest = await fetchLatestVersion(script, updateUrl);
    if (!latest.ok || !latest.version) continue;
    if (compareVersions(latest.version, script.metadata.version) > 0) {
      updates.push({
        id: script.id,
        name: script.metadata.name,
        currentVersion: script.metadata.version,
        latestVersion: latest.version,
        updateUrl,
      });
    }
  }
  return { updates };
}

export function checkUpdates(): Promise<{ updates: UserscriptUpdateInfo[] }> {
  if (updatesInflight) return updatesInflight;
  updatesInflight = runCheckUpdates().finally(() => { updatesInflight = null; });
  return updatesInflight;
}

export async function applyUpdate(id: string): Promise<{ ok: boolean; error?: string }> {
  const script = listUserscripts().find((entry) => entry.id === id);
  if (!script) return { ok: false, error: 'not-found' };
  if (script.edited) return { ok: false, error: 'edited' };
  const updateUrl = script.metadata.updateUrl;
  if (!updateUrl) return { ok: false, error: 'no-update-url' };
  const latest = await fetchLatestVersion(script, updateUrl);
  if (!latest.ok) return { ok: false, error: latest.error ?? 'fetch-failed' };
  if (!latest.version || !latest.bodyText || compareVersions(latest.version, script.metadata.version) <= 0) {
    return { ok: false, error: 'no-new-version' };
  }
  const installed = installUserscript(latest.bodyText, { enabled: script.enabled, id });
  if (!installed.ok) return { ok: false, error: installed.error };
  // The new version replaced the user's edits: clear the edited flag.
  setUserscriptEdited(id, false);
  return { ok: true };
}
