import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  clearFlashVersionCache,
  extractVersionFromFilename,
  readEmbeddedFlashVersion,
} from '../src/main/modules/flash-version';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-flash-version-'));

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeFixture(name: string, content: Buffer): string {
  const file = path.join(tempDir, name);
  fs.writeFileSync(file, content);
  return file;
}

describe('extractVersionFromFilename', () => {
  it('reads the version encoded in experimental bundle names', () => {
    expect(extractVersionFromFilename('pepflashplayer64_34_0_0_380.dll')).toBe('34.0.0.380');
  });

  it('returns null for the unversioned stable bundle names', () => {
    expect(extractVersionFromFilename('pepflashplayer64.dll')).toBeNull();
    expect(extractVersionFromFilename('libpepflashplayer64.so')).toBeNull();
  });
});

describe('readEmbeddedFlashVersion', () => {
  it('reads the ASCII WIN token from a Windows plugin', () => {
    const file = writeFixture('win.dll', Buffer.from('junk\0WIN 29,0,0,171\0more', 'latin1'));
    expect(readEmbeddedFlashVersion(file)).toBe('29.0.0.171');
  });

  it('reads the ASCII LNX token from a Linux plugin', () => {
    const file = writeFixture('linux.so', Buffer.from('\x7fELFLNX 32,0,0,371tail', 'latin1'));
    expect(readEmbeddedFlashVersion(file)).toBe('32.0.0.371');
  });

  it('falls back to UTF-16LE wide strings', () => {
    const file = writeFixture('wide.dll', Buffer.from('\0\0MAC 30,0,0,154\0\0', 'utf16le'));
    expect(readEmbeddedFlashVersion(file)).toBe('30.0.0.154');
  });

  it('ignores implausible low-major tokens', () => {
    const file = writeFixture('noise.bin', Buffer.from('APP 1,2,3,4 and WIN 34,0,0,330', 'latin1'));
    expect(readEmbeddedFlashVersion(file)).toBe('34.0.0.330');
  });

  it('returns null when the file is missing or carries no token', () => {
    expect(readEmbeddedFlashVersion(path.join(tempDir, 'absent.dll'))).toBeNull();
    const file = writeFixture('empty.dll', Buffer.from('no version here', 'latin1'));
    expect(readEmbeddedFlashVersion(file)).toBeNull();
  });

  it('re-reads after the cached file changes', () => {
    const file = writeFixture('changing.dll', Buffer.from('WIN 29,0,0,171', 'latin1'));
    expect(readEmbeddedFlashVersion(file)).toBe('29.0.0.171');
    fs.writeFileSync(file, Buffer.from('WIN 34,0,0,330', 'latin1'));
    // mtime granularity varies by filesystem; force a distinct mtime.
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(file, future, future);
    clearFlashVersionCache();
    expect(readEmbeddedFlashVersion(file)).toBe('34.0.0.330');
  });
});
