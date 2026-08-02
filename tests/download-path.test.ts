import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { availableSavePath, isPathWithinDirectory, sanitizeDownloadFilename } from '../src/main/utils/download-path';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('download paths', () => {
  it('removes traversal, invalid characters and Windows reserved names', () => {
    expect(sanitizeDownloadFilename('../game?.swf')).toBe('game_.swf');
    expect(sanitizeDownloadFilename('C:\\temp\\CON.txt')).toBe('_CON.txt');
    expect(sanitizeDownloadFilename('...')).toBe('download');
  });

  it('keeps generated paths inside the selected directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-download-'));
    tempDirs.push(dir);
    expect(isPathWithinDirectory(dir, path.join(dir, 'game.swf'))).toBe(true);
    expect(isPathWithinDirectory(dir, path.join(dir, '..', 'outside.swf'))).toBe(false);
  });

  it('numbers an existing filename instead of overwriting it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-download-'));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'game.swf'), 'fixture');
    expect(availableSavePath(dir, 'game.swf')).toBe(path.join(dir, 'game (1).swf'));
  });
});
