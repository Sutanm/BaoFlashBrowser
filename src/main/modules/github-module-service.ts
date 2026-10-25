import { ipcMain, net, session, webContents, type Session } from 'electron';
import { createHash } from 'crypto';
import { loadConfig } from './config';
import { toElectronProxy } from '../../shared/types/proxy';
import { GITHUB_MODULE_SCHEME, decodeGitHubModuleUrl, githubModuleUrl, isGitHubModuleUrl, parseGitHubImportMap, transformGitHubModule, type GitHubImportMap } from './github-module-transform';

const maps = new Map<string, GitHubImportMap>();
const views = new Map<number, string>();
const listeners = new Map<number, Set<(id: string | null) => void>>();
const registeredSessions = new WeakSet<Session>();
const watchedViews = new Set<number>();
const transformed = new Map<string, Promise<string>>();
const cacheSizes = new Map<string, number>();
const sourceRequests = new Map<string, Promise<string>>();
const fetchQueue: Array<() => void> = [];
let activeFetches = 0;
let cacheBytes = 0;
let initialized = false;
let transport: Session | null = null;
let transportProxy = '';
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const failures: Array<{ asset: string; error: string }> = [];

export function githubModuleDiagnostics(): { documents: number; maps: number; cached: number; completed: number; pending: string[]; failures: typeof failures } {
  return { documents: views.size, maps: maps.size, cached: transformed.size, completed: cacheSizes.size,
    pending: [...transformed.keys()].filter(url => !cacheSizes.has(url)).map(url => decodeGitHubModuleUrl(url)?.source || '').slice(0, 20), failures: failures.slice() };
}

export function isGitHubPage(value: string): boolean {
  try { const u = new URL(value); return u.origin === 'https://github.com'; } catch { return false; }
}

function resolveWaiters(wcId: number, id: string | null): void {
  for (const resolve of listeners.get(wcId) || []) resolve(id);
  listeners.delete(wcId);
}

export function setupGitHubModules(): void {
  if (initialized) return;
  initialized = true;
  ipcMain.on('github-module:map', (event, text: unknown) => {
    // Only the main-frame preload of github.com may supply the map. Mapped
    // sources are independently restricted to public, unhashed-query-free CDN JS.
    // Pinned Electron 11 uses routing ID 1 for the main frame (not 0).
    // Checking its renderer process also excludes out-of-process iframes.
    if (event.frameId !== 1 || event.processId !== event.sender.getProcessId()
      || !isGitHubPage(event.sender.getURL()) || typeof text !== 'string') {
      event.returnValue = false; return;
    }
    const map = parseGitHubImportMap(text);
    if (!map) { event.returnValue = false; return; }
    const id = createHash('sha256').update(JSON.stringify(map)).digest('hex').slice(0, 16);
    if (!maps.has(id) && maps.size >= 128) {
      const active = new Set(views.values());
      for (const existing of maps.keys()) if (!active.has(existing)) { maps.delete(existing); break; }
      if (maps.size >= 128) { event.returnValue = false; return; }
    }
    maps.set(id, map);
    views.set(event.sender.id, id);
    resolveWaiters(event.sender.id, id);
    event.returnValue = true;
  });
}

function watchView(wcId: number): void {
  if (watchedViews.has(wcId)) return;
  const wc = webContents.fromId(wcId);
  if (!wc) return;
  watchedViews.add(wcId);
  wc.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) { views.delete(wcId); resolveWaiters(wcId, null); }
  });
  wc.once('destroyed', () => {
    views.delete(wcId); watchedViews.delete(wcId); resolveWaiters(wcId, null);
  });
}

export async function githubModuleRedirect(url: string, wcId: number): Promise<string | null> {
  if (!isGitHubModuleUrl(url) || wcId < 0) return null;
  const wc = webContents.fromId(wcId);
  if (!wc || !isGitHubPage(wc.getURL())) return null;
  watchView(wcId);
  let id = views.get(wcId);
  if (!id) {
    id = await new Promise<string | null>(resolve => {
      const waiting = listeners.get(wcId) || new Set();
      const done = (value: string | null): void => { clearTimeout(timer); waiting.delete(done); resolve(value); };
      const timer = setTimeout(() => { done(null); if (!waiting.size) listeners.delete(wcId); }, 2000);
      waiting.add(done); listeners.set(wcId, waiting);
    }) || undefined;
  }
  return id ? githubModuleUrl(url, id) : null;
}

async function fetchAssetOnce(url: string): Promise<string> {
  if (!transport) transport = session.fromPartition('github-module-transport');
  // This anonymous transport has no page cookies and no interception listeners,
  // so its CDN fetch cannot recursively redirect into this protocol handler.
  const proxy = toElectronProxy(loadConfig().proxy);
  const key = JSON.stringify(proxy);
  if (key !== transportProxy) {
    if (proxy) await transport.setProxy(proxy);
    transportProxy = key;
  }
  return new Promise((resolve, reject) => {
    const request = net.request({ url, session: transport!, useSessionCookies: false, redirect: 'error' });
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error, text?: string): void => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { request.abort(); reject(error); } else resolve(text || '');
    };
    const timer = setTimeout(() => finish(new Error('GitHub module fetch timeout')), 15000);
    request.on('login', (_info, callback) => { callback(); finish(new Error('Proxy authentication required')); });
    request.on('error', error => finish(error));
    request.on('response', response => {
      if (response.statusCode !== 200) { finish(new Error('GitHub module HTTP ' + response.statusCode)); return; }
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) finish(new Error('GitHub module exceeds size budget'));
        else chunks.push(chunk);
      });
      response.on('error', (error: Error) => finish(error));
      response.on('end', () => finish(undefined, Buffer.concat(chunks).toString('utf8')));
    });
    request.end();
  });
}

function fetchAsset(url: string): Promise<string> {
  const existing = sourceRequests.get(url);
  if (existing) return existing;
  const slot = new Promise<void>(resolve => {
    const start = (): void => { activeFetches += 1; resolve(); };
    if (activeFetches < 6) start(); else fetchQueue.push(start);
  });
  const promise = slot.then(async () => {
    try {
      // Start the per-request timeout only after admission. Starting 100+
      // timers while Chromium's six CDN connections are queued causes late
      // dependencies to time out before they have ever reached the network.
      for (let attempt = 0; ; attempt += 1) {
        try { return await fetchAssetOnce(url); }
        catch (error) {
          const message = error instanceof Error ? error.message : '';
          if (attempt >= 2 || /size budget|HTTP 4\d\d|authentication/.test(message)) throw error;
          await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        }
      }
    } finally {
      activeFetches -= 1; fetchQueue.shift()?.();
    }
  });
  sourceRequests.set(url, promise);
  const cleanup = (): void => { if (sourceRequests.get(url) === promise) sourceRequests.delete(url); };
  promise.then(cleanup, cleanup);
  return promise;
}

export function registerGitHubModuleSession(sess: Session): void {
  if (registeredSessions.has(sess)) return;
  registeredSessions.add(sess);
  sess.protocol.registerBufferProtocol(GITHUB_MODULE_SCHEME, (request, callback) => {
    const decoded = decodeGitHubModuleUrl(request.url);
    const imports = decoded && maps.get(decoded.mapId);
    if (request.method !== 'GET' || !decoded || !imports) {
      callback({ statusCode: 403, data: Buffer.from('Invalid GitHub module') }); return;
    }
    let promise = transformed.get(request.url);
    if (!promise) {
      promise = fetchAsset(decoded.source).then(text => transformGitHubModule(text, decoded.source, decoded.mapId, imports));
      transformed.set(request.url, promise);
      const remove = (url: string): void => {
        transformed.delete(url); cacheBytes -= cacheSizes.get(url) || 0; cacheSizes.delete(url);
      };
      if (transformed.size > 200) remove(transformed.keys().next().value!);
      promise.then(text => {
        if (transformed.get(request.url) !== promise) return;
        const bytes = Buffer.byteLength(text);
        cacheSizes.set(request.url, bytes); cacheBytes += bytes;
        while (cacheBytes > MAX_CACHE_BYTES && transformed.size) remove(transformed.keys().next().value!);
      }, () => { if (transformed.get(request.url) === promise) remove(request.url); });
    }
    promise.then(text => callback({ statusCode: 200, mimeType: 'application/javascript',
      headers: { 'access-control-allow-origin': '*', 'content-type': 'application/javascript', 'cache-control': 'no-store' },
      data: Buffer.from(text) })).catch((error: unknown) => {
        if (failures.length < 20) failures.push({ asset: new URL(decoded.source).pathname, error: error instanceof Error ? error.message.slice(0, 300) : 'Unknown error' });
        callback({ statusCode: 502, data: Buffer.from('GitHub module unavailable') });
      });
  });
}

export function patchGitHubModuleCsp(headers: Record<string, string[]>): Record<string, string[]> {
  const key = Object.keys(headers).find(name => name.toLowerCase() === 'content-security-policy');
  if (!key) return headers;
  return { ...headers, [key]: headers[key].map(policy => policy.split(';').map(directive => {
    const parts = directive.trim().split(/\s+/);
    if (!['script-src', 'script-src-elem'].includes(parts[0]) || !parts.includes('github.githubassets.com')) return directive;
    if (parts.includes(GITHUB_MODULE_SCHEME + ':')) return directive;
    // The added scheme serves ONLY the already-allowed github.githubassets.com
    // /assets/*.js files. It cannot proxy arbitrary URLs or local resources.
    return directive + ' ' + GITHUB_MODULE_SCHEME + ':';
  }).join(';')) };
}
