import fs from 'fs';
import path from 'path';

export function sanitizeDownloadFilename(rawName: string): string {
  const basename = path.posix.basename(rawName.replace(/\\/g, '/'));
  let safe = Array.from(basename, (character) => character.charCodeAt(0) < 32 ? '_' : character)
    .join('')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  if (!safe) safe = 'download';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(safe)) safe = '_' + safe;
  if (safe.length > 180) {
    const ext = path.extname(safe).slice(0, 20);
    safe = safe.slice(0, Math.max(1, 180 - ext.length)) + ext;
  }
  return safe;
}

export function availableSavePath(dir: string, filename: string): string {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  for (let index = 1; fs.existsSync(candidate); index++) {
    candidate = path.join(dir, `${stem} (${index})${ext}`);
  }
  return candidate;
}

export function isPathWithinDirectory(directory: string, targetPath: string): boolean {
  const resolveThroughExistingAncestor = (value: string): string => {
    let cursor = path.resolve(value);
    const tail: string[] = [];
    while (!fs.existsSync(cursor)) {
      const parent = path.dirname(cursor);
      if (parent === cursor) return path.resolve(value);
      tail.unshift(path.basename(cursor));
      cursor = parent;
    }
    return path.join(fs.realpathSync(cursor), ...tail);
  };
  const allowed = resolveThroughExistingAncestor(directory);
  const target = resolveThroughExistingAncestor(targetPath);
  const normalizedAllowed = process.platform === 'win32' ? allowed.toLowerCase() : allowed;
  const normalizedTarget = process.platform === 'win32' ? target.toLowerCase() : target;
  return normalizedTarget === normalizedAllowed || normalizedTarget.startsWith(normalizedAllowed + path.sep);
}
