// js-patch-service: URL-layer patching of ES2022+ JavaScript chunks that
// Chromium 87 (V8 8.7) cannot parse. Chromium drops the whole script when a
// chunk uses modern syntax (e.g. class static blocks `static{...}` from
// Next.js App Router) — "Uncaught SyntaxError: Unexpected token '{'", and
// React never mounts. Renderer-side patching loses the race: a <script>
// loads and fails within the same microtask batch the observer runs in.
//
// The interception lives in session-manager's single webRequest
// onBeforeRequest listener (Electron 11 listeners REPLACE each other, so
// every redirect shares one callback). Chunk requests are redirected to a
// CUSTOM PROTOCOL (bf-js-patch://) — an http://127.0.0.1 redirect would be
// blocked as mixed content on https pages. The protocol handler fetches the
// original chunk, rewrites safe class static blocks to static getters, and
// serves the patched text.
//
// Security: the handler only accepts https/http sources and reuses the
// request service's private/loopback address guard, so a page cannot turn
// this into a local-network probe.

import { protocol } from 'electron';
import http from 'http';
import https from 'https';
import log from 'electron-log';
import { patchModernJs } from '../modules/userscripts/bundled-scripts/css-fixer-core';
import { isBlockedUrl } from '../modules/userscripts/userscript-request';

const PROTOCOL = 'bf-js-patch';
let protocolRegistered = false;

// In-memory patch cache: chunk URLs are content-hashed by the bundler, so a
// URL's payload never changes — caching is safe and avoids re-downloading
// every chunk on every tab navigation (the redirect cancels the original
// request, so the protocol handler would otherwise re-fetch everything).
const MAX_CACHE_ENTRIES = 200;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const patchCache = new Map<string, { text: string; bytes: number }>();

function cachePut(src: string, text: string): void {
  const bytes = text.length;
  patchCache.set(src, { text, bytes });
  if (patchCache.size > MAX_CACHE_ENTRIES) {
    const oldest = patchCache.keys().next().value;
    if (oldest !== undefined) patchCache.delete(oldest);
  }
  let total = 0;
  for (const entry of patchCache.values()) total += entry.bytes;
  while (total > MAX_CACHE_BYTES && patchCache.size > 1) {
    const oldest = patchCache.keys().next().value;
    if (oldest === undefined) break;
    const removed = patchCache.get(oldest);
    patchCache.delete(oldest);
    if (removed) total -= removed.bytes;
  }
}

// Node http(s) client, NOT electron net.request: net.request inside a
// registerBufferProtocol handler fails with ERR_UNKNOWN_URL_SCHEME on
// Electron 11. Chunk CDNs serve directly; a proxy-only network degrades to
// the original (unpatched) behavior.
function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
  });
}

export function registerJsPatchProtocol(): void {
  if (protocolRegistered) return;
  protocolRegistered = true;
  protocol.registerBufferProtocol(PROTOCOL, (request, callback) => {
    let src = '';
    try {
      src = new URL(request.url).searchParams.get('src') || '';
    } catch { /* fallthrough */ }
    log.info('[js-patch] protocol request', src.slice(0, 70));
    if (!/^https?:\/\//i.test(src)) {
      callback({ statusCode: 400, headers: { 'content-type': 'text/plain' }, data: Buffer.from('bad source') });
      return;
    }
    if (isBlockedUrl(src, ['127.0.0.1', 'localhost'])) {
      callback({ statusCode: 403, headers: { 'content-type': 'text/plain' }, data: Buffer.from('blocked') });
      return;
    }
    const cached = patchCache.get(src);
    if (cached) {
      callback({
        statusCode: 200,
        headers: { 'content-type': 'application/javascript' },
        data: Buffer.from(cached.text, 'utf8'),
      });
      return;
    }
    fetchText(src)
      .then((text) => {
        const patched = patchModernJs(text);
        cachePut(src, patched ?? text);
        log.info('[js-patch] served', src.slice(0, 60), 'patched=' + (patched !== null), 'bytes=' + (patched ?? text).length);
        callback({
          statusCode: 200,
          headers: { 'content-type': 'application/javascript' },
          data: Buffer.from(patched ?? text, 'utf8'),
        });
      })
      .catch((error) => {
        log.warn('[js-patch] fetch failed', src.slice(0, 60), error instanceof Error ? error.message : String(error));
        callback({ statusCode: 502, headers: { 'content-type': 'text/plain' }, data: Buffer.from('fetch failed') });
      });
  });
}

// Called from session-manager's single webRequest onBeforeRequest listener:
// returns the redirect URL for a Next.js chunk request, or null to let the
// request continue unchanged. (Electron 11 webRequest listeners REPLACE each
// other — multiple onBeforeRequest registrations silently drop earlier ones
// — so this must live inside the shared listener, not its own.) The URL
// pattern is specific enough; resourceType is unreliable on Electron 11
// (chunk <script> requests arrive as "mainFrame").
export function chunkRedirectUrl(url: string): string | null {
  if (/\/_next\/static\/chunks\/[^/]+\.js($|\?)/.test(url)) {
    return `${PROTOCOL}://chunk?src=${encodeURIComponent(url)}`;
  }
  return null;
}

// Registers the protocol handler (idempotent). Called at app startup from
// initUserscriptManager, before any navigation.
export function setupJsPatchInterceptor(): void {
  registerJsPatchProtocol();
}
