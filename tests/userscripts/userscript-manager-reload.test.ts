import { describe, expect, it } from 'vitest';
import { UserscriptManager } from '@main/modules/userscripts/userscript-manager';
import { ValueStore } from '@main/modules/userscripts/userscript-store';
import type { InstalledUserscript, ParsedUserscriptMetadata } from '@shared/userscript-types';

function makeScript(id: string, enabled = true): InstalledUserscript {
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
  };
  return {
    id,
    source: `/* source of ${id} */`,
    enabled,
    metadata,
    installedAt: 0,
    updatedAt: 0,
    revision: 1,
  };
}

function makeManager(): UserscriptManager {
  const manager = new UserscriptManager(new ValueStore());
  manager.registerView(7, { mode: 'ppapi', generation: 1, token: 't' });
  return manager;
}

// Regression: disabling/uninstalling a script must take effect immediately —
// loadScripts() rebuilds the index instead of merging incrementally.
describe('userscript-manager loadScripts rebuild', () => {
  it('disabled script stops matching after reload (no restart needed)', () => {
    const manager = makeManager();
    manager.loadScripts([makeScript('s1')]);
    expect(manager.snapshotFor(7, 'https://example.com/', true).scripts.some((s) => s.id === 's1')).toBe(true);

    manager.loadScripts([makeScript('s1', false)]);
    const snap = manager.snapshotFor(7, 'https://example.com/', true);
    expect(snap.scripts.some((s) => s.id === 's1')).toBe(false);
    expect(manager.matchingFor('https://example.com/').some((s) => s.id === 's1')).toBe(false);
  });

  it('removed script stops matching after reload', () => {
    const manager = makeManager();
    manager.loadScripts([makeScript('s1'), makeScript('s2')]);
    manager.loadScripts([makeScript('s2')]);
    const snap = manager.snapshotFor(7, 'https://example.com/', true);
    expect(snap.scripts.some((s) => s.id === 's1')).toBe(false);
    expect(snap.scripts.some((s) => s.id === 's2')).toBe(true);
  });

  it('re-enabled script matches again after reload', () => {
    const manager = makeManager();
    manager.loadScripts([makeScript('s1', false)]);
    expect(manager.snapshotFor(7, 'https://example.com/', true).scripts.length).toBe(0);
    manager.loadScripts([makeScript('s1', true)]);
    expect(manager.snapshotFor(7, 'https://example.com/', true).scripts.some((s) => s.id === 's1')).toBe(true);
  });
});
