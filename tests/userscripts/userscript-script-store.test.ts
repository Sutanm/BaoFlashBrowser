import { describe, expect, it } from 'vitest';
import { ScriptStore, scriptIdFor, type KeyValueBackend } from '@main/modules/userscripts/script-store';

function memoryBackend(): KeyValueBackend {
  const data = new Map<string, unknown>();
  return { get: (key) => data.get(key), set: (key, value) => void data.set(key, value) };
}

const SCRIPT: Parameters<ScriptStore['save']>[0] = {
  id: 'demo:test',
  source: '// ==UserScript==\n// @name Test\n// @namespace demo\n// ==/UserScript==\n',
  enabled: true,
  metadata: { name: 'Test', namespace: 'demo', version: '1.0.0', description: '', runAt: 'document-end', match: [], include: [], exclude: [], excludeMatch: [], grant: [], connect: [], require: [], resource: [], noframes: false },
  installedAt: 1,
  updatedAt: 1,
  revision: 1,
};

describe('ScriptStore persistence', () => {
  it('saves, lists and removes scripts', () => {
    const store = new ScriptStore({ backend: memoryBackend() });
    store.save(SCRIPT);
    expect(store.list()).toHaveLength(1);
    expect(store.get('demo:test')?.metadata.name).toBe('Test');
    expect(store.remove('demo:test')).toBe(true);
    expect(store.remove('demo:test')).toBe(false);
    expect(store.list()).toHaveLength(0);
  });

  it('replaces by id and keeps installedAt', () => {
    const store = new ScriptStore({ backend: memoryBackend() });
    store.save(SCRIPT);
    store.save({ ...SCRIPT, source: '// v2', updatedAt: 2, revision: 2 });
    const stored = store.get('demo:test');
    expect(stored?.source).toBe('// v2');
    expect(stored?.revision).toBe(2);
    expect(stored?.installedAt).toBe(1);
    expect(store.list()).toHaveLength(1);
  });

  it('enforces the script count cap', () => {
    const tiny = new ScriptStore({ backend: memoryBackend(), maxScripts: 1 });
    tiny.save(SCRIPT);
    expect(() => tiny.save({ ...SCRIPT, id: 'demo:other' })).toThrow(/full/);
  });
});

describe('scriptIdFor', () => {
  it('normalizes namespaces and names', () => {
    expect(scriptIdFor('Test', 'https://demo.local/ns')).toBe('https://demo.local/ns:Test'.replace(/[^a-zA-Z0-9._:-]/g, '_'));
    expect(scriptIdFor('Simplified/Traditional', '')).toBe('local:Simplified_Traditional');
    expect(scriptIdFor('a'.repeat(200), 'ns')).toHaveLength(120);
  });
});
