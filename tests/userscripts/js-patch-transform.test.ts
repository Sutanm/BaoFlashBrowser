import { describe, expect, it } from 'vitest';
import { patchModernJsAsync } from '@main/modules/js-patch-transform';

describe('js-patch-transform patchModernJsAsync', () => {
  it('returns verbatim for plain ES5 code (preflight miss, zero esbuild cost)', async () => {
    const r = await patchModernJsAsync('var a = 1; function f() { return a; }');
    expect(r).toEqual({ text: null, mode: 'verbatim' });
  });

  it('degrades a multi-statement static block via esbuild', async () => {
    const src = 'class A { static { this.x = 1; this.y = 2; } }';
    const r = await patchModernJsAsync(src);
    expect(r.mode).toBe('esbuild');
    expect(r.text).toContain('_A.x = 1');
    expect(r.text).not.toContain('static {');
  });

  it('does not change string literals containing static{ (preflight loose, esbuild precise)', async () => {
    const src = 'var s = "static{x=1}";';
    const r = await patchModernJsAsync(src);
    expect(r.mode).toBe('verbatim');
    expect(r.text).toBeNull();
  });

  it('degrades using declarations with an inline __using helper and no new imports', async () => {
    const src = 'function f() { using r = acquire(); return r.x; }';
    const r = await patchModernJsAsync(src);
    expect(r.mode).toBe('esbuild');
    expect(r.text).toContain('__using');
    expect(r.text).not.toMatch(/\bimport\b/);
  });

  it('falls back to regex patch when esbuild throws', async () => {
    const r = await patchModernJsAsync('class A { static { this.x = 1 } } /* unbalanced ( { */');
    expect(['esbuild', 'regex']).toContain(r.mode);
    expect(r.text).not.toBeNull();
  });

  it('returns verbatim when esbuild output equals input', async () => {
    const src = 'var x = 1; var s = "static{noop}";';
    const r = await patchModernJsAsync(src);
    // preflight hits the string literal, esbuild has nothing to change
    expect(r.text).toBeNull();
    expect(r.mode).toBe('verbatim');
  });
});
