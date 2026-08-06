// js-patch-service: URL-layer patching of ES2022+ JavaScript chunks that
// Chromium 87 (V8 8.7) cannot parse. Chromium drops the whole script when a
// chunk uses modern syntax (e.g. class static blocks `static{...}` from
// Next.js App Router) — "Uncaught SyntaxError: Unexpected token '{'", and
// React never mounts. Renderer-side patching loses the race: a <script>
// loads and fails within the same microtask batch the observer runs in.
//
// This service intercepts Next.js chunk requests at the URL layer via
// webRequest and redirects them to a custom protocol handler that fetches
// the original source, rewrites safe class static blocks to static getters,
// and serves the patched text. The browser only ever sees compatible JS.
//
// Security: the protocol handler only accepts https/http sources and reuses
// the request service's private/loopback address guard, so a page cannot
// turn this into a local-network probe.

import { app, net, session, type Session } from 'electron';
import http from 'http';
import type { AddressInfo } from 'net';
import log from 'electron-log';
import { patchModernJs } from '../modules/userscripts/bundled-scripts/css-fixer-core';
import { isBlockedUrl } from '../modules/userscripts/userscript-request';

// Redirect target host/port of the local patch server (started at app-ready).
let patchServer: http.Server | null = null;
let patchServerPort = 0;
let serverStarted = false;
const interceptedSessions = new WeakSet<object>();

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, redirect: 'follow' });
    request.on('response', (response) => {
      if (response.statusCode && response.statusCode >= 400) {
        try { (response as unknown as { resume(): void }).resume(); } catch { /* ignore */ }
        reject(new Error('HTTP ' + response.statusCode));
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

export function registerJsPatchProtocol(): void {
  if (serverStarted) return;
  serverStarted = true;
  patchServer = http.createServer((req, res) => {
    let src = '';
    try {
      src = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('src') || '';
    } catch { /* fallthrough */ }
    if (!/^https?:\/\//i.test(src)) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad source');
      return;
    }
    if (isBlockedUrl(src, ['127.0.0.1', 'localhost'])) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('blocked');
      return;
    }
    fetchText(src)
      .then((text) => {
        const patched = patchModernJs(text);
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end(patched ?? text, 'utf8');
      })
      .catch(() => {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('fetch failed');
      });
  });
  patchServer.listen(0, '127.0.0.1', () => {
    patchServerPort = (patchServer?.address() as AddressInfo | null)?.port ?? 0;
    log.info('[js-patch] patch server on port', patchServerPort);
  });
}

function intercept(sess: Session): void {
  try {
    if (interceptedSessions.has(sess)) return;
    interceptedSessions.add(sess);
    // Broad pattern + JS filter: Electron 11's match-pattern host wildcard
    // (`*://*/*...`) does not reliably match arbitrary hosts.
    sess.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
      if (
        (details.resourceType === 'script' || details.resourceType === 'xhr') &&
        /\/_next\/static\/chunks\/[^/]+\.js($|\?)/.test(details.url)
      ) {
        if (patchServerPort > 0) {
          const redirect = `http://127.0.0.1:${patchServerPort}/bf-js-patch?src=${encodeURIComponent(details.url)}`;
          callback({ redirectURL: redirect });
          return;
        }
      }
      callback({});
    });
    log.info('[js-patch] interceptor active');
  } catch (error) {
    log.warn('[js-patch] interceptor setup failed', error);
  }
}

// Called from tabs.ts for every view session: deterministic registration
// (the session-created event's argument position varies across Electron
// versions, so view creation is the reliable hook).
export function interceptSession(sess: Session): void {
  registerJsPatchProtocol();
  intercept(sess);
}

export function setupJsPatchInterceptor(): void {
  registerJsPatchProtocol();
  intercept(session.fromPartition('persist:'));
  // 'session-created' is declared in newer Electron typings than 11.x; the
  // session may arrive in any argument position — handled defensively.
  (app as unknown as { on(event: string, cb: (...args: unknown[]) => void): void }).on('session-created', (...args: unknown[]) => {
    const sess = (args.find((a): a is Session => Boolean(a) && typeof a === 'object' && 'webRequest' in (a as object)) as Session | undefined) ?? session.defaultSession;
    intercept(sess);
  });
}
