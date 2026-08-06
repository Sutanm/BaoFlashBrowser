import { describe, expect, it } from 'vitest';
import { UserscriptManager } from '@main/modules/userscripts/userscript-manager';
import { ValueStore } from '@main/modules/userscripts/userscript-store';
import { RequireCache } from '@main/modules/userscripts/userscript-require-cache';
import type { InstalledUserscript, ParsedUserscriptMetadata } from '@shared/userscript-types';

function makeScript(id: string, overrides?: Partial<ParsedUserscriptMetadata>): InstalledUserscript {
  const metadata: ParsedUserscriptMetadata = {
    name: id,
    namespace: 'https://demo.local/ns',
    version: '1.0.0',
    description: '',
    match: [],
    include: [],
    exclude: [],
    excludeMatch: [],
    runAt: 'document-end',
    grant: [],
    connect: [],
    noframes: false,
    require: [],
    resource: [],
    rawHeader: '// ==UserScript==',
    ...overrides,
  };
  return {
    id,
    source: `/* source of ${id} */`,
    enabled: true,
    metadata,
    installedAt: 0,
    updatedAt: 0,
    revision: 1,
  };
}

function makeManager(requireSources: Record<string, string>): { manager: UserscriptManager; cache: RequireCache } {
  const cache = new RequireCache({
    fetcher: async (url) => {
      const source = requireSources[url];
      if (source === undefined) throw new Error('not found');
      return source;
    },
  });
  const manager = new UserscriptManager(new ValueStore(), { requireCache: cache });
  manager.registerView(7, { mode: 'ppapi', generation: 1, token: 't' });
  return { manager, cache };
}

describe('userscript-manager require expansion', () => {
  it('expands ready requires into the snapshot source', async () => {
    const { manager, cache } = makeManager({ 'http://x/lib.js': 'var LIB = { v: 42 };' });
    await cache.ensure('http://x/lib.js');
    manager.loadScripts([makeScript('s:req', { require: ['http://x/lib.js'] })]);
    const snapshot = manager.snapshotFor(7, 'http://page.test/', true);
    expect(snapshot.scripts).toHaveLength(1);
    expect(snapshot.scripts[0].source.startsWith('var LIB = { v: 42 };\n/* source of s:req */')).toBe(true);
  });

  it('skips scripts whose requires are not ready and records the gap', () => {
    const { manager } = makeManager({});
    manager.loadScripts([makeScript('s:req', { require: ['http://x/missing.js'] })]);
    const snapshot = manager.snapshotFor(7, 'http://page.test/', true);
    expect(snapshot.scripts).toHaveLength(0);
    expect(manager.getRequireGaps('s:req')).toEqual(['http://x/missing.js']);
  });

  it('includes scripts again once their requires are ensured', async () => {
    const { manager, cache } = makeManager({ 'http://x/lib.js': 'var LIB = 1;' });
    manager.loadScripts([makeScript('s:req', { require: ['http://x/lib.js'] })]);
    expect(manager.snapshotFor(7, 'http://page.test/', true).scripts).toHaveLength(0);
    await manager.ensureRequires();
    expect(manager.snapshotFor(7, 'http://page.test/', true).scripts).toHaveLength(1);
  });

  it('includes resource snapshots with text and data urls', async () => {
    const { manager, cache } = makeManager({ 'http://x/data.txt': 'hello-resource' });
    await cache.ensure('http://x/data.txt');
    manager.loadScripts([makeScript('s:res', { resource: [{ name: 'demo-data', url: 'http://x/data.txt' }] })]);
    const snapshot = manager.snapshotFor(7, 'http://page.test/', true);
    const resource = snapshot.resources?.['s:res']?.['demo-data'];
    expect(resource?.text).toBe('hello-resource');
    expect(resource?.url.startsWith('data:text/plain;charset=utf-8;base64,')).toBe(true);
  });

  it('omits resources above the per-page budget', async () => {
    const { manager, cache } = makeManager({ 'http://x/big.bin': 'x'.repeat(80 * 1024) });
    await cache.ensure('http://x/big.bin');
    manager.loadScripts([makeScript('s:res', { resource: [{ name: 'big', url: 'http://x/big.bin' }] })]);
    const snapshot = manager.snapshotFor(7, 'http://page.test/', true);
    expect(snapshot.resources?.['s:res']?.['big']).toBeUndefined();
  });

  it('counts expanded require sources toward the page source budget', async () => {
    const { manager, cache } = makeManager({ 'http://x/huge.js': 'x'.repeat(600 * 1024) });
    await cache.ensure('http://x/huge.js');
    manager.loadScripts([makeScript('s:big', { require: ['http://x/huge.js'] })]);
    const snapshot = manager.snapshotFor(7, 'http://page.test/', true);
    expect(snapshot.scripts).toHaveLength(0);
  });
});
