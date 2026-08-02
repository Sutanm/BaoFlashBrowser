import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import log from 'electron-log';

let _content = '';
let _info: RuffleBundleInfo | null = null;

export interface RuffleBundleInfo {
  version: string;
  bytes: number;
  sha256: string;
}

export function loadRuffleJs(): void {
  if (_content) return;
  const filePath = path.join(__dirname, 'lib', 'ruffle', 'ruffle.js');
  try {
    _content = fs.readFileSync(filePath, 'utf-8');
    let version = 'unknown';
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'lib', 'ruffle', 'package.json'), 'utf-8')) as { version?: string };
      if (pkg.version) version = pkg.version;
    } catch { /* the runtime itself will still report its embedded version */ }
    _info = {
      version,
      bytes: Buffer.byteLength(_content),
      sha256: crypto.createHash('sha256').update(_content).digest('hex'),
    };
    log.info(`[Ruffle] loaded ruffle.js: version=${version}, bytes=${_info.bytes}, sha256=${_info.sha256}`);
  } catch (e: any) {
    log.warn('[Ruffle] failed to load ruffle.js: ' + (e?.message || e));
  }
}

export function ruffleBundleInfo(): RuffleBundleInfo | null {
  if (!_content) loadRuffleJs();
  return _info;
}

export function ruffleJsContent(): string {
  if (!_content) {
    loadRuffleJs();
  }
  return _content;
}
