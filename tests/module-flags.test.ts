import { describe, expect, it } from 'vitest';
import { ALL_MODULES, moduleDefines, moduleSummary, parseModules } from '../build/module-flags.mjs';

describe('modular build flags', () => {
  it('keeps the historical full build by default', () => {
    expect([...parseModules()]).toEqual(ALL_MODULES);
    expect([...parseModules('default')]).toEqual(ALL_MODULES);
    expect([...parseModules('all')]).toEqual(ALL_MODULES);
  });

  it('always includes core and normalizes a selected module list', () => {
    const modules = parseModules(' automation, userscripts,automation ');
    expect([...modules]).toEqual(['core', 'automation', 'userscripts']);
    expect(moduleSummary(modules)).toBe('core,userscripts,automation');
  });

  it('rejects unknown names instead of silently producing an incomplete build', () => {
    expect(() => parseModules('core,autmation')).toThrow('autmation');
  });

  it('emits literal booleans suitable for esbuild and Vite tree shaking', () => {
    const defines = moduleDefines(parseModules('core,automation'));
    expect(defines.MODULE_AUTOMATION).toBe('true');
    expect(defines.MODULE_USERSCRIPTS).toBe('false');
    expect(defines.MODULE_MEMORY_MONITOR).toBe('false');
  });
});
