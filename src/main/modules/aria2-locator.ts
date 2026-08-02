import { app } from 'electron';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface Aria2Candidate {
  path: string;
  bundled: boolean;
}

function aria2Bases(): string[] {
  return [
    path.join(app.getPath('exe'), '..', 'resources', 'native', 'aria2'),
    path.join(__dirname, '..', 'native', 'aria2'),
  ];
}

export function getAria2Candidates(): Aria2Candidate[] {
  const candidates: Aria2Candidate[] = [];
  const binaryName = process.platform === 'win32' ? 'aria2c.exe' : 'aria2c';
  for (const base of aria2Bases()) {
    const candidate = path.join(base, binaryName);
    if (fs.existsSync(candidate)) candidates.push({ path: candidate, bundled: true });
  }
  if (process.platform === 'linux') {
    try {
      const candidate = execSync('which aria2c', { encoding: 'utf8', timeout: 5000, stdio: 'pipe' }).trim();
      if (candidate && !candidates.some((item) => item.path === candidate)) candidates.push({ path: candidate, bundled: false });
    } catch { /* Chromium fallback remains available */ }
  }
  if (process.platform === 'win32') {
    const extensions = (process.env.PATHEXT || '.exe').split(path.delimiter);
    for (const directory of (process.env.PATH || '').split(path.delimiter)) {
      for (const extension of extensions) {
        const candidate = path.join(directory, 'aria2c' + extension);
        try {
          if (fs.existsSync(candidate) && !candidates.some((item) => item.path === candidate)) {
            candidates.push({ path: candidate, bundled: false });
          }
        } catch { /* inaccessible PATH entry */ }
      }
    }
  }
  return candidates;
}

export function getAria2LibraryDirectory(): string | null {
  if (process.platform !== 'linux') return null;
  for (const base of aria2Bases()) {
    if (fs.existsSync(path.join(base, 'libaria2.so.0'))) return base;
  }
  return null;
}
