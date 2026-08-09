import { describe, expect, it, vi } from 'vitest';
import { UserscriptManager } from '@main/modules/userscripts/userscript-manager';
import { ValueStore } from '@main/modules/userscripts/userscript-store';
import type { GMSerializable, InstalledUserscript, ParsedUserscriptMetadata } from '@shared/userscript-types';

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

function makeManager(sendToWc?: (wcId: number, channel: string, payload: unknown) => void): UserscriptManager {
  const manager = new UserscriptManager(new ValueStore(), { sendToWc });
  manager.loadScripts([makeScript('s:values')]);
  manager.registerView(7, { mode: 'ppapi', generation: 1, token: 'a' });
  manager.registerView(8, { mode: 'ppapi', generation: 1, token: 'b' });
  return manager;
}

describe('userscript-manager value listeners', () => {
  it('registers and removes value listeners', () => {
    const manager = makeManager();
    expect(manager.addValueListener(7, 's:values', 'key-a', 1)).toBe(true);
    expect(manager.addValueListener(7, 's:values', 'key-a', 2)).toBe(true);
    expect(manager.removeValueListener(7, 's:values', 2)).toBe(true);
    expect(manager.removeValueListener(7, 's:values', 2)).toBe(false);
    expect(manager.removeValueListener(7, 's:values', 1)).toBe(true);
  });

  it('rejects listeners for uninstalled scripts', () => {
    const manager = makeManager();
    expect(manager.addValueListener(7, 'nope', 'key-a', 1)).toBe(false);
  });

  it('broadcasts value changes to other views with old and new values', () => {
    const sent: Array<{ wcId: number; channel: string; payload: unknown }> = [];
    const manager = makeManager((wcId, channel, payload) => sent.push({ wcId, channel, payload }));
    manager.addValueListener(8, 's:values', 'key-a', 1);
    const result = manager.setValue(7, 's:values', 'key-a', 42);
    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].wcId).toBe(8);
    expect(sent[0].channel).toBe('userscript:value-changed');
    const payload = sent[0].payload as { scriptId: string; key: string; oldValue: unknown; newValue: unknown; remote: boolean };
    expect(payload.scriptId).toBe('s:values');
    expect(payload.key).toBe('key-a');
    expect(payload.oldValue).toBeUndefined();
    expect(payload.newValue).toBe(42);
    expect(payload.remote).toBe(true);
  });

  it('does not broadcast to the source view', () => {
    const sent: Array<{ wcId: number }> = [];
    const manager = makeManager((wcId) => sent.push({ wcId }));
    manager.addValueListener(7, 's:values', 'key-a', 1);
    manager.setValue(7, 's:values', 'key-a', 1);
    expect(sent).toHaveLength(0);
  });

  it('broadcasts only to listeners of the same key', () => {
    const sent: Array<{ wcId: number }> = [];
    const manager = makeManager((wcId) => sent.push({ wcId }));
    manager.addValueListener(8, 's:values', 'other-key', 1);
    manager.setValue(7, 's:values', 'key-a', 1);
    expect(sent).toHaveLength(0);
  });

  it('broadcasts delete operations with undefined as the new value', () => {
    const sent: Array<{ payload: unknown }> = [];
    const manager = makeManager((_wc, _ch, payload) => sent.push({ payload }));
    manager.setValue(7, 's:values', 'key-a', 1);
    manager.addValueListener(8, 's:values', 'key-a', 1);
    manager.deleteValue(7, 's:values', 'key-a');
    const payload = sent[0].payload as { oldValue: unknown; newValue: unknown };
    expect(payload.oldValue).toBe(1);
    expect(payload.newValue).toBeUndefined();
  });

  it('clears listeners when a view is unregistered', () => {
    const sent: Array<{ wcId: number }> = [];
    const manager = makeManager((wcId) => sent.push({ wcId }));
    manager.addValueListener(8, 's:values', 'key-a', 1);
    manager.unregisterView(8);
    manager.setValue(7, 's:values', 'key-a', 2);
    expect(sent).toHaveLength(0);
  });

  it('records setValue old values', () => {
    const manager = makeManager();
    manager.setValue(7, 's:values', 'key-a', 1);
    const result = manager.setValue(7, 's:values', 'key-a', 2);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.oldValue).toBe(1);
  });

  it('clearScriptValues removes the whole script bucket', () => {
    const manager = makeManager();
    manager.setValue(7, 'gone', 'k', 'v');
    manager.setValue(7, 'stay', 'k', 'v');
    manager.clearScriptValues('gone');
    expect(manager.getValuesFor(7, 'gone')).toEqual({});
    expect(manager.getValuesFor(7, 'stay').k).toBe('v');
  });

  it('admin value methods work without a registered view', () => {
    const manager = makeManager();
    expect(manager.setScriptValue('adm', 'k', 'v')).toBe(true);
    expect(manager.getScriptValue('adm', 'k')).toBe('v');
    expect(manager.listScriptValues('adm')).toEqual({ k: 'v' });
    expect(manager.deleteScriptValue('adm', 'k')).toBe(true);
    expect(manager.listScriptValues('adm')).toEqual({});
  });

  it('admin setScriptValue rejects invalid values', () => {
    const manager = makeManager();
    expect(manager.setScriptValue('adm', 'k', () => 1 as unknown as GMSerializable)).toBe(false);
    expect(manager.setScriptValue('adm', '', 'v')).toBe(false);
  });
});
