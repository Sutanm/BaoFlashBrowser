import fs from 'fs';
import path from 'path';
import log from 'electron-log';

let _content = '';

export function loadRuffleJs(): void {
  if (_content) return;
  const filePath = path.join(__dirname, 'lib', 'ruffle', 'ruffle.js');
  try {
    _content = fs.readFileSync(filePath, 'utf-8');
    log.info('[Ruffle] loaded ruffle.js: ' + (_content.length / 1024).toFixed(0) + 'KB');
  } catch (e: any) {
    log.warn('[Ruffle] failed to load ruffle.js: ' + (e?.message || e));
  }
}

export function ruffleJsContent(): string {
  return _content;
}
