import fs from 'fs';
import path from 'path';
import type { Session } from 'electron';
import log from 'electron-log';

const RUFFLE_SCHEME = 'ruffle-resource';
const SAFE_RESOURCE_NAME = /^[a-zA-Z0-9._-]+$/;
const registeredSessions = new WeakSet<object>();

function resourceNameFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    // With a publicPath of "ruffle-resource://", webpack places the filename in
    // the URL host. Also accept the path form so the handler is future-proof.
    const encodedName = url.hostname || url.pathname.replace(/^\/+/, '');
    const fileName = decodeURIComponent(encodedName);
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
