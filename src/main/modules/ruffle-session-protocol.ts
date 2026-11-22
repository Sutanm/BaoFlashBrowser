import fs from 'fs';
import path from 'path';
import type { Session } from 'electron';
import log from 'electron-log';

const RUFFLE_SCHEME = 'ruffle-resource';
// Ruffle ≥0.8 用 `new URL('./core.wasm', publicPath)` 解析它的 WASM 组件，而
// Chromium 87 无法把相对引用解析到“空 authority”的非标准 scheme 上
// （`new URL('./x.wasm', 'ruffle-resource:///')` 直接抛 Invalid URL）。
// 因此 publicPath 必须带 authority 段：`ruffle-resource://ruffle/`。
// 该 authority 与文件名无关，只用于让相对解析成立。
const RUFFLE_PUBLIC_AUTHORITY = 'ruffle';
const SAFE_RESOURCE_NAME = /^[a-zA-Z0-9._-]+$/;
const registeredSessions = new WeakSet<object>();

// Exported for unit tests: the URL normalisation is the part that pins
// Chromium 87's non-standard-scheme parsing (see the comment inside).
export function resourceNameFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    // publicPath 带 authority 后，同一个 URL 会有两种解析结果：主进程的
    // WHATWG 解析把它放进 hostname（`ruffle-resource://ruffle/x.wasm`），而
    // Chromium 对非标准 scheme 的解析把它留成首个 path 段
    // （`//ruffle/x.wasm`）。两种形态都归一化到文件名，同时保留旧的无
    // authority 形态（`ruffle-resource://x.wasm`）以免历史调用点失效。
    const pathSegments = url.pathname.split('/').filter(Boolean);
    const segments = pathSegments.length ? pathSegments : (url.hostname ? [url.hostname] : []);
    if (segments[0] === RUFFLE_PUBLIC_AUTHORITY) segments.shift();
    const fileName = segments.map((segment) => decodeURIComponent(segment)).join('/');
    if (!fileName || path.basename(fileName) !== fileName || !SAFE_RESOURCE_NAME.test(fileName)) return null;
    return fileName;
  } catch {
    return null;
  }
}

function mimeTypeFor(fileName: string): string {
  switch (path.extname(fileName).toLowerCase()) {
    case '.js': return 'application/javascript';
    case '.wasm': return 'application/wasm';
    case '.map': return 'application/json';
    case '.ttf': return 'font/ttf';
    case '.otf': return 'font/otf';
    default: return 'application/octet-stream';
  }
}

export function registerRuffleProtocol(targetSession: Session, label: string): void {
  if (registeredSessions.has(targetSession)) return;
  const registered = targetSession.protocol.registerBufferProtocol(RUFFLE_SCHEME, (request, callback) => {
      const fileName = resourceNameFromUrl(request.url);
      if (!fileName) {
        log.warn(`[Ruffle] ${label} rejected invalid resource URL: ${request.url}`);
        callback({ error: -10 });
        return;
      }
      const fullPath = path.join(__dirname, 'lib', 'ruffle', fileName);
      fs.readFile(fullPath, (error, data) => {
        if (error) {
          log.warn(`[Ruffle] ${label} resource missing: ${fileName} (${error.message})`);
          callback({ error: -6 });
          return;
        }
        log.debug(`[Ruffle] ${label} resource served: ${fileName} (${data.length} bytes)`);
        callback({
          mimeType: mimeTypeFor(fileName),
          data,
          headers: {
            'Cache-Control': 'public, max-age=31536000, immutable',
            'Access-Control-Allow-Origin': '*',
          },
        });
      });
  });
  if (!registered) throw new Error(`Failed to register ${RUFFLE_SCHEME} for ${label}`);
  registeredSessions.add(targetSession);
  log.info(`[Ruffle] resource protocol registered for ${label}`);
}
