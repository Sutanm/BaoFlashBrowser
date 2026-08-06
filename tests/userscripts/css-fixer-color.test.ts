import { describe, expect, it } from 'vitest';
import { convertColorValue, needsColorRewrite } from '@main/modules/userscripts/bundled-scripts/css-fixer-color';

function approx(expected: string, tolerance = 2): (actual: string) => boolean {
  const parse = (s: string): number[] => {
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (!m) throw new Error('not rgb: ' + s);
    return m[1].split(/[\s/]+/).map((n) => parseFloat(n));
  };
  return (actual: string) => {
    const e = parse(expected);
    const a = parse(actual);
    if (e.length !== a.length) return false;
    return e.every((v, i) => Math.abs(v - a[i]) <= tolerance);
  };
}

describe('css-fixer-color needsColorRewrite', () => {
  it('detects modern color functions', () => {
    expect(needsColorRewrite('color: oklch(0.6 0.1 200)')).toBe(true);
    expect(needsColorRewrite('background: color-mix(in srgb, red, blue)')).toBe(true);
    expect(needsColorRewrite('border-color: color(display-p3 1 0 0)')).toBe(true);
    expect(needsColorRewrite('color: lab(50% 10 20)')).toBe(true);
  });

  it('ignores legacy colors', () => {
    expect(needsColorRewrite('color: #ff0000')).toBe(false);
    expect(needsColorRewrite('background: rgb(255 0 0)')).toBe(false);
    expect(needsColorRewrite('color: var(--x)')).toBe(false);
  });
});

describe('css-fixer-color convertColorValue', () => {
  it('converts hwb to rgb', () => {
    expect(convertColorValue('hwb(0 0% 0%)')).toBe('rgb(255 0 0)');
    expect(convertColorValue('hwb(120 0% 0%)')).toBe('rgb(0 255 0)');
    expect(convertColorValue('hwb(240 0% 0%)')).toBe('rgb(0 0 255)');
    expect(convertColorValue('hwb(0 100% 0%)')).toBe('rgb(255 255 255)');
    expect(convertColorValue('hwb(0 0% 100%)')).toBe('rgb(0 0 0)');
    expect(convertColorValue('hwb(60 50% 0%)')).toBe('rgb(255 255 128)');
    expect(convertColorValue('hwb(0 60% 60%)')).toBe('rgb(128 128 128)');
  });

  it('converts oklch anchors exactly', () => {
    expect(convertColorValue('oklch(1 0 0)')).toBe('rgb(255 255 255)');
    expect(convertColorValue('oklch(0 0 0)')).toBe('rgb(0 0 0)');
    expect(convertColorValue('oklch(0.62794 0.25768 29.2339)')).toSatisfy(approx('rgb(255 0 0)'));
  });

  it('converts oklab to rgb', () => {
    expect(convertColorValue('oklab(1 0 0)')).toBe('rgb(255 255 255)');
    expect(convertColorValue('oklab(0.62794 0.22487 0.12585)')).toSatisfy(approx('rgb(255 0 0)'));
  });

  it('converts lab and lch to rgb', () => {
    expect(convertColorValue('lab(53.2408 80.0925 67.2032)')).toSatisfy(approx('rgb(255 0 0)'));
    expect(convertColorValue('lch(53.2408 104.55 40)')).toSatisfy(approx('rgb(255 0 0)'));
  });

  it('converts color(display-p3 ...) to rgb', () => {
    expect(convertColorValue('color(display-p3 1 0 0)')).toBe('rgb(255 0 0)');
    expect(convertColorValue('color(srgb 0 1 0)')).toBe('rgb(0 255 0)');
  });

  it('mixes colors in srgb', () => {
    expect(convertColorValue('color-mix(in srgb, red, blue)')).toBe('rgb(128 0 128)');
    expect(convertColorValue('color-mix(in srgb, red 40%, blue)')).toBe('rgb(102 0 153)');
  });

  it('mixes colors in oklab (white/black midpoint)', () => {
    expect(convertColorValue('color-mix(in oklab, white, black)')).toSatisfy(approx('rgb(99 99 99)', 3));
  });

  it('preserves alpha', () => {
    const out = convertColorValue('oklch(0.5 0.1 30 / 0.5)');
    expect(out).toMatch(/^rgb\(\d+ \d+ \d+ \/ 0\.5\)$/);
  });

  it('accepts percentage lightness', () => {
    expect(convertColorValue('oklch(100% 0 0)')).toBe('rgb(255 255 255)');
  });

  it('rewrites colors inside compound values', () => {
    expect(convertColorValue('1px solid hwb(0 0% 0%)')).toBe('1px solid rgb(255 0 0)');
    expect(convertColorValue('linear-gradient(hwb(0 0% 0%), oklch(1 0 0))')).toBe('linear-gradient(rgb(255 0 0), rgb(255 255 255))');
  });

  it('leaves unconvertible values unchanged', () => {
    expect(convertColorValue('color-mix(in lab, red, blue)')).toBeNull();
    expect(convertColorValue('oklch(from red l c h)')).toBeNull();
    expect(convertColorValue('var(--x)')).toBeNull();
    expect(convertColorValue('rgb(255 0 0)')).toBeNull();
  });
});
