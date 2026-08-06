import { describe, expect, it } from 'vitest';
import { sanitizeFileName } from '@main/modules/userscripts/userscript-download';

describe('userscript download filename sanitization', () => {
  it('keeps plain names unchanged', () => {
    expect(sanitizeFileName('demo-file.txt')).toBe('demo-file.txt');
  });

  it('strips path separators to prevent traversal', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('etcpasswd');
    expect(sanitizeFileName('..\\..\\win.ini')).toBe('win.ini');
    expect(sanitizeFileName('a/b/c.txt')).toBe('abc.txt');
  });

  it('strips leading dots', () => {
    expect(sanitizeFileName('..hidden')).toBe('hidden');
    expect(sanitizeFileName('...')).toBe('download');
  });

  it('removes control characters', () => {
    expect(sanitizeFileName('evil\u0000name.txt')).toBe('evilname.txt');
    expect(sanitizeFileName('line\nbreak.txt')).toBe('linebreak.txt');
  });

  it('truncates overlong names', () => {
    expect(sanitizeFileName('x'.repeat(500)).length).toBeLessThanOrEqual(200);
  });

  it('falls back for empty or invalid input', () => {
    expect(sanitizeFileName('')).toBe('download');
    expect(sanitizeFileName('   ')).toBe('download');
    expect(sanitizeFileName(undefined as unknown as string)).toBe('download');
    expect(sanitizeFileName('..')).toBe('download');
  });
});
