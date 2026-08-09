// Script executor. Runs userscript source with Node bindings shadowed and GM
// APIs injected as function parameters (lexical injection, never globals).
//
// Execution strategy by mode:
// - ppapi (contextIsolation: true): preload runs in the isolated world, which
//   page CSP does not cover, so `new Function` compiles freely.
// - ruffle (contextIsolation: false): preload shares the page world and page
//   CSP blocks `new Function`/eval on strict-CSP pages. Fall back to
//   `vm.runInThisContext`, which compiles at the V8 level (no CSP eval check)
//   and only sees global scope — Node bindings live in the preload closure,
//   not on the page global, so they stay unreachable.
// Mirrors the planned src/webview-preload/userscripts/sandbox.ts.

const SHADOWED_NODE_NAMES = [
  'require',
  'process',
  'module',
  'exports',
  'Buffer',
  'global',
  '__filename',
  '__dirname',
] as const;

// Classic Greasemonkey names, injected as lexical variables (never globals).
const LEGACY_GM_NAMES = [
  'GM_getValue',
  'GM_setValue',
  'GM_deleteValue',
  'GM_listValues',
  'GM_getValues',
  'GM_getResourceText',
  'GM_getResourceURL',
  'GM_addStyle',
  'GM_addElement',
  'GM_registerMenuCommand',
  'GM_unregisterMenuCommand',
  'GM_openInTab',
  'GM_xmlhttpRequest',
  'GM_download',
  'GM_addValueChangeListener',
  'GM_removeValueChangeListener',
  'GM_setClipboard',
  'GM_notification',
  'GM_log',
  'GM_cookie',
  'GM_webRequest',
] as const;

export interface SandboxHost {
  mode: 'ppapi' | 'ruffle';
  unsafeWindow: unknown;
  window: unknown;
  document: unknown;
  GM: Record<string, unknown>;
  GM_info: unknown;
  legacyGm: Record<string, unknown>;
}

export interface ExecutionResult {
  ok: boolean;
  error?: string;
  usedVmFallback: boolean;
}

const PARAMS = [
  ...SHADOWED_NODE_NAMES,
  'unsafeWindow',
  'window',
  'document',
  'GM',
  'GM_info',
  'legacyGm',
] as const;

function buildWrappedSource(source: string): string {
  const prelude = LEGACY_GM_NAMES
    .map((name) => `var ${name} = legacyGm[${JSON.stringify(name)}];`)
    .join('\n');
  return `(function(){${prelude}\n(function(){${source}\n})();})();`;
}

function callWith(
  fn: (...args: unknown[]) => unknown,
  host: SandboxHost,
  window: unknown,
): unknown {
  const args: unknown[] = [
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    host.unsafeWindow, window, host.document, host.GM, host.GM_info, host.legacyGm,
  ];
  return fn.apply(window, args);
}

export function executeUserscript(source: string, host: SandboxHost): ExecutionResult {
  const wrapped = buildWrappedSource(source);
  let usedVmFallback = false;

  let invoke: (host: SandboxHost, window: unknown) => unknown;
  try {
    const fn = new Function(...PARAMS, wrapped) as (...args: unknown[]) => unknown;
    invoke = (h, window) => callWith(fn, h, window);
  } catch {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const vm = require('vm');
      const factory = vm.runInThisContext(
        '(function(' + PARAMS.join(',') + '){' + wrapped + '})',
        { filename: 'userscript-sandbox' },
      ) as (...args: unknown[]) => unknown;
      invoke = (h, window) => callWith(factory, h, window);
      usedVmFallback = true;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), usedVmFallback };
    }
  }

  try {
    invoke(host, host.window);
    return { ok: true, usedVmFallback };
  } catch (error) {
    return {
      ok: false,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      usedVmFallback,
    };
  }
}
