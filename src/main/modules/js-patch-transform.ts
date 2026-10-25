// js-patch-transform: URL-layer JS patching with esbuild fallback.
// The regex patch (css-fixer-core patchModernJs) only covers simple
// `static{this.X=ref}` blocks; esbuild degrades complex static blocks and
// `using` declarations with full edge coverage. esbuild is lazy-required
// (Node-only; this module must NEVER be imported from browser-bundled code).
//
// Preflight is deliberately loose (`static{`, `static {`, `using` only):
// class declarations and `.static =` assignments are native to Chromium 87
// and must not trigger the esbuild path ("zero overhead" promise).

import { patchModernJs } from './userscripts/bundled-scripts/css-fixer-core';
import { getJsCompiler } from './js-compiler';

const PREFLIGHT_RE = /static\s*\{|\busing\s+\w/;

export interface PatchResult {
  text: string | null;
  mode: 'esbuild' | 'regex' | 'verbatim';
}

export async function patchModernJsAsync(text: string): Promise<PatchResult> {
  if (!PREFLIGHT_RE.test(text)) return { text: null, mode: 'verbatim' };
  try {
    const out = await getJsCompiler().transform(text, { target: 'chrome87', loader: 'js' });
    // esbuild re-serializes even untouched input (line wrapping, trailing
    // newline); compare whitespace-insensitively so no-op runs stay verbatim.
    if (out.code.replace(/\s+/g, '') === text.replace(/\s+/g, '')) return { text: null, mode: 'verbatim' };
    return { text: out.code, mode: 'esbuild' };
  } catch {
    const regex = patchModernJs(text);
    return regex === null ? { text: null, mode: 'verbatim' } : { text: regex, mode: 'regex' };
  }
}
