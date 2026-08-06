// css-fixer-color: runtime conversion of CSS Color 4/5 color functions
// (oklch, oklab, lab, lch, hwb, color(display-p3/srgb), color-mix in
// srgb/oklab) to the rgb() syntax Chromium 87 understands. Pure module:
// unit-tested and bundled into the CSS Fixer built-in userscript.
//
// Chromium 87 drops a declaration whose value contains an unknown function
// (oklch(...) etc.). Converting the value at the text layer keeps the
// declaration alive. Values that cannot be converted are left untouched
// (returns null) rather than guessed.

import valueParser from 'postcss-value-parser';

const MODERN_COLOR_RE = /\b(oklch|oklab|lch|lab|hwb|color-mix|color)\(/i;
const CONVERTIBLE_FUNCS = new Set(['oklch', 'oklab', 'lch', 'lab', 'hwb', 'color', 'color-mix']);

export function needsColorRewrite(value: string): boolean {
  return MODERN_COLOR_RE.test(value);
}

// ---------------------------------------------------------------------------
// color space math (D65 white point, sRGB transfer)
// ---------------------------------------------------------------------------

const D65 = { X: 0.95047, Y: 1, Z: 1.08883 };

const XYZ_TO_SRGB = [
  [3.2404542, -1.5371385, -0.4985314],
  [-0.969266, 1.8760108, 0.041556],
  [0.0556434, -0.2040259, 1.0572252],
];

const SRGB_TO_XYZ = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
];

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function xyzToLab(x: number, y: number, z: number): [number, number, number] {
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x / D65.X);
  const fy = f(y);
  const fz = f(z / D65.Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function labToXyz(l: number, a: number, b: number): [number, number, number] {
  const fInv = (t: number): number => {
    const t3 = t * t * t;
    return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787;
  };
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  return [fInv(fx) * D65.X, fInv(fy), fInv(fz) * D65.Z];
}

function labToOklab(l: number, a: number, b: number): [number, number, number] {
  const [x, y, z] = labToXyz(l, a, b);
  // OKLab cube-roots XYZ normalized to D65 white = (1,1,1)
  const lr = Math.cbrt(x / D65.X);
  const mr = Math.cbrt(y);
  const sr = Math.cbrt(z / D65.Z);
  return [
    0.2104542553 * lr + 0.793617785 * mr - 0.0040720468 * sr,
    1.9779984951 * lr - 2.428592205 * mr + 0.4505937099 * sr,
    0.0259040371 * lr + 0.7827717662 * mr - 0.808675766 * sr,
  ];
}

function oklabToLab(L: number, a: number, b: number): [number, number, number] {
  const lr = L + 0.3963377774 * a + 0.2158037573 * b;
  const mr = L - 0.1055613458 * a - 0.0638541728 * b;
  const sr = L - 0.0894841775 * a - 1.291485548 * b;
  const l = lr * lr * lr;
  const m = mr * mr * mr;
  const s = sr * sr * sr;
  const x = 1.2270138511 * l - 0.5577999807 * m + 0.281256149 * s;
  const y = -0.0405801784 * l + 1.1122568696 * m - 0.0716766787 * s;
  const z = -0.0763812845 * l - 0.4214819784 * m + 1.5861632204 * s;
  return xyzToLab(x, y, z);
}

function oklabToXyz(L: number, a: number, b: number): [number, number, number] {
  const [l, aa, bb] = oklabToLab(L, a, b);
  return labToXyz(l, aa, bb);
}

function xyzToSrgb(x: number, y: number, z: number): [number, number, number] {
  const r = XYZ_TO_SRGB[0][0] * x + XYZ_TO_SRGB[0][1] * y + XYZ_TO_SRGB[0][2] * z;
  const g = XYZ_TO_SRGB[1][0] * x + XYZ_TO_SRGB[1][1] * y + XYZ_TO_SRGB[1][2] * z;
  const b = XYZ_TO_SRGB[2][0] * x + XYZ_TO_SRGB[2][1] * y + XYZ_TO_SRGB[2][2] * z;
  return [linearToSrgb(r), linearToSrgb(g), linearToSrgb(b)];
}

function srgbToXyz(r: number, g: number, b: number): [number, number, number] {
  const rl = srgbToLinear(r);
  const gl = srgbToLinear(g);
  const bl = srgbToLinear(b);
  return [
    SRGB_TO_XYZ[0][0] * rl + SRGB_TO_XYZ[0][1] * gl + SRGB_TO_XYZ[0][2] * bl,
    SRGB_TO_XYZ[1][0] * rl + SRGB_TO_XYZ[1][1] * gl + SRGB_TO_XYZ[1][2] * bl,
    SRGB_TO_XYZ[2][0] * rl + SRGB_TO_XYZ[2][1] * gl + SRGB_TO_XYZ[2][2] * bl,
  ];
}

function srgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const [x, y, z] = srgbToXyz(r, g, b);
  // OKLab cube-roots XYZ normalized to D65 white = (1,1,1)
  const lr = Math.cbrt(x / D65.X);
  const mr = Math.cbrt(y);
  const sr = Math.cbrt(z / D65.Z);
  return [
    0.2104542553 * lr + 0.793617785 * mr - 0.0040720468 * sr,
    1.9779984951 * lr - 2.428592205 * mr + 0.4505937099 * sr,
    0.0259040371 * lr + 0.7827717662 * mr - 0.808675766 * sr,
  ];
}

function oklabToSrgb(L: number, a: number, b: number): [number, number, number] {
  const [x, y, z] = oklabToXyz(L, a, b);
  return xyzToSrgb(x, y, z);
}

function hslPure(hue: number): [number, number, number] {
  const h = ((hue % 360) + 360) % 360;
  const i = Math.floor(h / 60) % 6;
  const f = (h / 60) % 2;
  const x = 1 - Math.abs(f - 1);
  switch (i) {
    case 0: return [1, x, 0];
    case 1: return [x, 1, 0];
    case 2: return [0, 1, x];
    case 3: return [0, x, 1];
    case 4: return [x, 0, 1];
    default: return [1, 0, x];
  }
}

// ---------------------------------------------------------------------------
// component parsing
// ---------------------------------------------------------------------------

interface ColorComponents {
  args: number[]; // 3 or 4 components (alpha optional)
  alpha: number | null;
}

interface MixEntry {
  rgb: [number, number, number];
  weight: number | null;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

function parsePercentOrNumber(node: valueParser.Node, fallback = 1): number {
  if (node.type === 'word') {
    if (node.value.endsWith('%')) return parseFloat(node.value) / 100;
    return parseFloat(node.value);
  }
  return fallback;
}

function parseAngle(node: valueParser.Node): number {
  if (node.type !== 'word') return 0;
  const v = node.value;
  const n = parseFloat(v);
  if (v.endsWith('turn')) return n * 360;
  if (v.endsWith('rad')) return (n * 180) / Math.PI;
  if (v.endsWith('grad')) return n * 0.9;
  return n;
}

// Splits the parsed function-node argument list into numeric components.
// Returns null when the argument shape is not understood (e.g. `from`
// relative-color syntax or var()/calc() functions inside).
const NAMED_COLORS: Record<string, [number, number, number]> = {
  black: [0, 0, 0],
  silver: [192, 192, 192],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  white: [255, 255, 255],
  maroon: [128, 0, 0],
  red: [255, 0, 0],
  purple: [128, 0, 128],
  fuchsia: [255, 0, 255],
  green: [0, 128, 0],
  lime: [0, 255, 0],
  olive: [128, 128, 0],
  yellow: [255, 255, 0],
  navy: [0, 0, 128],
  blue: [0, 0, 255],
  teal: [0, 128, 128],
  aqua: [0, 255, 255],
  orange: [255, 165, 0],
  pink: [255, 192, 203],
  brown: [165, 42, 42],
  cyan: [0, 255, 255],
  magenta: [255, 0, 255],
  limegreen: [50, 205, 50],
  lightgray: [211, 211, 211],
  lightgrey: [211, 211, 211],
  darkgray: [169, 169, 169],
  darkgrey: [169, 169, 169],
  darkred: [139, 0, 0],
  darkgreen: [0, 100, 0],
  darkblue: [0, 0, 139],
  darkorange: [255, 140, 0],
  gold: [255, 215, 0],
  skyblue: [135, 206, 235],
  violet: [238, 130, 238],
  tan: [210, 180, 140],
  beige: [245, 245, 220],
};

function hexToRgb(hex: string): [number, number, number] | null {
  const h = hex.replace(/^#/, '');
  if (!/^[0-9a-fA-F]+$/.test(h)) return null;
  if (h.length === 3 || h.length === 4) {
    const r = parseInt(h[0] + h[0], 16);
    const g = parseInt(h[1] + h[1], 16);
    const b = parseInt(h[2] + h[2], 16);
    return [r / 255, g / 255, b / 255];
  }
  if (h.length === 6 || h.length === 8) {
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return [r / 255, g / 255, b / 255];
  }
  return null;
}

function resolveColorNode(node: valueParser.Node): [number, number, number] | null {
  if (node.type === 'word') {
    const w = node.value;
    if (w.startsWith('#')) return hexToRgb(w);
    const named = NAMED_COLORS[w.toLowerCase()];
    if (named) return [named[0] / 255, named[1] / 255, named[2] / 255];
    return null;
  }
  if (node.type === 'function') {
    const name = node.value.toLowerCase();
    if (name === 'rgb' || name === 'rgba') {
      const comps = parseComponents(node);
      if (!comps) return null;
      const rgb = [comps.args[0] / 255, comps.args[1] / 255, comps.args[2] / 255] as [number, number, number];
      return rgb;
    }
    if (name === 'hsl' || name === 'hsla') {
      const comps = parseComponents(node);
      if (!comps) return null;
      const [h, s, l] = comps.args;
      const pure = hslPure(h);
      const c = (1 - Math.abs(2 * l - 1)) * s;
      const m = l - c / 2;
      return [pure[0] * c + m, pure[1] * c + m, pure[2] * c + m];
    }
    if (CONVERTIBLE_FUNCS.has(name)) {
      const out = convertFunction(node);
      if (!out) return null;
      return parseRgbToNumbers(out);
    }
  }
  return null;
}

function parseComponents(fn: valueParser.FunctionNode): ColorComponents | null {
  const values: number[] = [];
  let alpha: number | null = null;
  let sawSlash = false;
  for (const node of fn.nodes) {
    if (node.type === 'space') continue;
    if (node.type === 'div' && node.value === '/') {
      sawSlash = true;
      continue;
    }
    if (node.type !== 'word') return null; // functions/strings inside → unconvertible
    const word = node.value.toLowerCase();
    if (sawSlash) {
      if (word === 'none') continue;
      if (word.endsWith('%')) alpha = parseFloat(word) / 100;
      else alpha = parseFloat(word);
      if (Number.isNaN(alpha)) return null;
      continue;
    }
    if (word === 'none') {
      values.push(0);
      continue;
    }
    const n = parseFloat(word);
    if (Number.isNaN(n)) return null;
    values.push(n);
  }
  if (values.length < 3 || values.length > 4) return null;
  if (values.length === 4 && alpha === null) {
    alpha = values[3];
    values.pop();
  }
  return { args: values, alpha };
}

// ---------------------------------------------------------------------------
// per-space conversions: returns [r, g, b] in 0..1 or null
// ---------------------------------------------------------------------------

function convertHwb(args: number[]): [number, number, number] | null {
  const [h, w, b] = args;
  if (w + b >= 1) {
    const gray = w / (w + b);
    return [gray, gray, gray];
  }
  const pure = hslPure(h);
  const f = 1 - w - b;
  return [pure[0] * f + w, pure[1] * f + w, pure[2] * f + w];
}

function convertOklab(args: number[]): [number, number, number] | null {
  // percentage lightness: 100% == 1.0
  const L = args[0] > 1 && args[0] <= 100 ? args[0] / 100 : args[0];
  const a = args[1];
  const b = args[2];
  if (L < 0 || L > 1) return null;
  return oklabToSrgb(L, a, b);
}

function convertOklch(args: number[]): [number, number, number] | null {
  const L = args[0] > 1 && args[0] <= 100 ? args[0] / 100 : args[0];
  const c = args[1] > 1 ? args[1] / 100 : args[1]; // 100% == 0.4 max, but accept raw
  const h = args[2];
  if (L < 0 || L > 1) return null;
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  return oklabToSrgb(L, a, b);
}

function convertLab(args: number[]): [number, number, number] | null {
  const l = args[0] <= 100 && args[0] >= 0 ? args[0] : null;
  if (l === null) return null;
  const a = args[1];
  const b = args[2];
  const [x, y, z] = labToXyz(l, a, b);
  return xyzToSrgb(x, y, z);
}

function convertLch(args: number[]): [number, number, number] | null {
  const l = args[0] <= 100 && args[0] >= 0 ? args[0] : null;
  if (l === null) return null;
  const c = args[1];
  const h = args[2];
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const [x, y, z] = labToXyz(l, a, b);
  return xyzToSrgb(x, y, z);
}

function convertColorFn(args: number[], space: string): [number, number, number] | null {
  const name = space.toLowerCase();
  if (name === 'srgb' || name === 'srgb-linear') {
    if (name === 'srgb-linear') return args.map((c) => linearToSrgb(c)) as [number, number, number];
    return [args[0], args[1], args[2]];
  }
  if (name === 'display-p3') {
    // same primaries + D65 white as sRGB → coordinate-identical for in-gamut values
    return [args[0], args[1], args[2]];
  }
  return null;
}

function parseColorMix(fn: valueParser.FunctionNode): { space: string; colors: MixEntry[] } | null {
  let state: 'in' | 'space' | 'color' | 'weight' | 'comma' = 'in';
  let space = '';
  const colors: MixEntry[] = [];
  let current: MixEntry | null = null;
  for (const node of fn.nodes) {
    if (node.type === 'space') continue;
    if (state === 'in') {
      if (node.type === 'word' && node.value.toLowerCase() === 'in') {
        state = 'space';
        continue;
      }
      return null;
    }
    if (state === 'space') {
      if (node.type !== 'word') return null;
      space = node.value;
      state = 'color';
      continue;
    }
    if (state === 'color') {
      if (node.type === 'div' && node.value === ',') continue; // separator after "in <space>"
      const rgb = resolveColorNode(node);
      if (!rgb) return null;
      current = { rgb, weight: null };
      colors.push(current);
      state = 'weight';
      continue;
    }
    if (state === 'weight') {
      if (node.type === 'div' && node.value === ',') {
        state = 'color';
        continue;
      }
      if (node.type === 'word' && node.value.endsWith('%')) {
        const w = parseFloat(node.value) / 100;
        if (Number.isNaN(w) || !current) return null;
        current.weight = w;
        state = 'comma';
        continue;
      }
      return null;
    }
    if (state === 'comma') {
      if (node.type === 'div' && node.value === ',') {
        state = 'color';
        continue;
      }
      return null;
    }
  }
  if (colors.length !== 2) return null;
  return { space, colors };
}

function convertColorMix(space: string, colors: MixEntry[]): [number, number, number] | null {
  const s = space.toLowerCase();
  if (s !== 'srgb' && s !== 'oklab') return null;
  let w1 = colors[0].weight ?? 0.5;
  let w2 = colors[1].weight ?? 0.5;
  if (colors[0].weight === null && colors[1].weight === null) {
    w1 = 0.5;
    w2 = 0.5;
  } else if (colors[0].weight === null) {
    w1 = 1 - w2;
  } else if (colors[1].weight === null) {
    w2 = 1 - w1;
  }
  const total = w1 + w2;
  const toSpace = (rgb: [number, number, number]): [number, number, number] =>
    s === 'oklab' ? srgbToOklab(rgb[0], rgb[1], rgb[2]) : rgb;
  const a = toSpace(colors[0].rgb);
  const b = toSpace(colors[1].rgb);
  const mixed: [number, number, number] = [
    (a[0] * w1 + b[0] * w2) / total,
    (a[1] * w1 + b[1] * w2) / total,
    (a[2] * w1 + b[2] * w2) / total,
  ];
  return s === 'oklab' ? oklabToSrgb(mixed[0], mixed[1], mixed[2]) : mixed;
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

function formatRgb(rgb: [number, number, number], alpha: number | null): string {
  const r = Math.round(clamp01(rgb[0]) * 255);
  const g = Math.round(clamp01(rgb[1]) * 255);
  const b = Math.round(clamp01(rgb[2]) * 255);
  if (alpha !== null) {
    const a = Math.round(clamp01(alpha) * 10000) / 10000;
    return `rgb(${r} ${g} ${b} / ${a})`;
  }
  return `rgb(${r} ${g} ${b})`;
}

function convertFunction(fn: valueParser.FunctionNode): string | null {
  const name = fn.value.toLowerCase();
  if (!CONVERTIBLE_FUNCS.has(name)) return null;
  if (name === 'color-mix') {
    const parsed = parseColorMix(fn);
    if (!parsed) return null;
    const rgb = convertColorMix(parsed.space, parsed.colors);
    if (!rgb) return null;
    return formatRgb(rgb, null);
  }

  // plain color functions: first word is the space for color(), else args
  let space = '';
  const args: number[] = [];
  let sawSlash = false;
  let alpha: number | null = null;
  const fnNodes = fn.nodes;
  for (const node of fnNodes) {
    if (node.type === 'space') continue;
    if (name === 'color' && space === '') {
      if (node.type !== 'word') return null;
      space = node.value;
      continue;
    }
    if (node.type === 'div' && node.value === '/') {
      sawSlash = true;
      continue;
    }
    if (node.type === 'word') {
      const isPct = node.value.endsWith('%');
      const n = parseFloat(node.value);
      if (Number.isNaN(n)) return null;
      if (sawSlash) {
        alpha = n;
        continue;
      }
      args.push(name === 'hwb' && isPct ? n / 100 : n);
      continue;
    }
    return null;
  }
  if (args.length !== 3) return null;
  let rgb: [number, number, number] | null = null;
  if (name === 'hwb') rgb = convertHwb(args);
  else if (name === 'oklab') rgb = convertOklab(args);
  else if (name === 'oklch') rgb = convertOklch(args);
  else if (name === 'lab') rgb = convertLab(args);
  else if (name === 'lch') rgb = convertLch(args);
  else if (name === 'color') rgb = convertColorFn(args, space);
  if (!rgb) return null;
  return formatRgb(rgb, alpha);
}

function parseRgbToNumbers(rgb: string): [number, number, number] | null {
  const m = rgb.match(/^rgb\((\d+) (\d+) (\d+)(?: \/ [\d.]+)?\)$/);
  if (!m) return null;
  return [parseInt(m[1], 10) / 255, parseInt(m[2], 10) / 255, parseInt(m[3], 10) / 255];
}

// Rewrites a whole declaration value. Returns the rewritten value, or null
// when nothing convertible was found / something unconvertible blocks it.
export function convertColorValue(value: string): string | null {
  if (!needsColorRewrite(value)) return null;
  const parsed = valueParser(value);
  let changed = false;
  let blocked = false;
  parsed.walk((node) => {
    if (blocked || node.type !== 'function') return;
    if (!CONVERTIBLE_FUNCS.has(node.value.toLowerCase())) return;
    const out = convertFunction(node);
    if (out === null) {
      blocked = true;
      return;
    }
    // replace the function node with a plain word node (a function node with
    // empty nodes would render as "rgb(...)()")
    (node as unknown as { type: string }).type = 'word';
    node.value = out;
    node.nodes = [];
    changed = true;
  });
  if (blocked) return null;
  if (!changed) return null;
  return parsed.toString();
}
