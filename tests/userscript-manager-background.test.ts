import { describe, it, expect } from 'vitest';
import { UserscriptManager } from '../src/main/modules/userscripts/userscript-manager';
import { ValueStore } from '../src/main/modules/userscripts/userscript-store';
import { backoffDelayMs } from '../src/main/modules/userscripts/userscript-background';
import type { InstalledUserscript, ParsedUserscriptMetadata } from '../src/shared/userscript-types';

function makeScript(id: string, overrides?: Partial<ParsedUserscriptMetadata>): InstalledUserscript {
  const metadata: ParsedUserscriptMetadata = {
    name: id,
    namespace: 'https://demo.local/ns',
    version: '1.0.0',
    description: '',
    match: ['*://*/*'],
    include: [],
    exclude: [],
    excludeMatch: [],
    runAt: 'document-end',
    grant: [],
    connect: [],
    noframes: false,
    background: false,
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

function makeManager(): UserscriptManager {
  const manager = new UserscriptManager(new ValueStore(), { sendToWc: () => {} });
  manager.registerView(1, { mode: 'ppapi', generation: 1, token: 't' });
  return manager;
}

describe('userscript manager background', () => {
  it('background scripts are excluded from snapshotFor URL matching', () => {
    const manager = makeManager();
    manager.loadScripts([makeScript('bg', { background: true }), makeScript('tab')]);
    const snap = manager.snapshotFor(1, 'http://example.com/', true);
    expect(snap.scripts.some((s) => s.id === 'bg')).toBe(false);
    expect(snap.scripts.some((s) => s.id === 'tab')).toBe(true);
  });

  it('background scripts are excluded from matchingFor (sidebar)', () => {
    const manager = makeManager();
    manager.loadScripts([makeScript('bg', { background: true }), makeScript('tab')]);
    const matched = manager.matchingFor('http://example.com/');
    expect(matched.some((s) => s.id === 'bg')).toBe(false);
    expect(matched.some((s) => s.id === 'tab')).toBe(true);
  });

  it('snapshotBackground requires a kind:background view and returns only background scripts', () => {
    const manager = makeManager();
    manager.loadScripts([makeScript('bg', { background: true }), makeScript('tab')]);
    // 未注册 kind:'background' 的 view → ok:false
    expect(manager.snapshotBackground(1).ok).toBe(false);
    manager.registerView(1, { mode: 'ppapi', generation: 1, token: 't', kind: 'background' });
    const bg = manager.snapshotBackground(1);
    expect(bg.ok).toBe(true);
    expect(bg.scripts.some((s) => s.id === 'bg')).toBe(true);
    expect(bg.scripts.some((s) => s.id === 'tab')).toBe(false);
  });

  it('backgroundScripts() lists only background scripts', () => {
    const manager = makeManager();
    manager.loadScripts([makeScript('bg', { background: true }), makeScript('tab')]);
    expect(manager.backgroundScripts().map((s) => s.id)).toEqual(['bg']);
  });

  it('spaNavigate is skipped for background views', () => {
    const manager = makeManager();
    manager.registerView(2, { mode: 'ppapi', generation: 1, token: 't', kind: 'background' });
    manager.spaNavigate(2, 'http://example.com/', 'pushState');
    expect(manager.getSpaNavigations().length).toBe(0);
  });

  it('snapshotBackground filters by backgroundScriptId (per-script windows)', () => {
    const manager = makeManager();
    manager.loadScripts([makeScript('bg1', { background: true }), makeScript('bg2', { background: true })]);
    manager.registerView(1, { mode: 'ppapi', generation: 1, token: 't', kind: 'background', backgroundScriptId: 'bg1' });
    const snap = manager.snapshotBackground(1);
    expect(snap.scripts.map((s) => s.id)).toEqual(['bg1']);
    // 未指定 backgroundScriptId 的窗口(旧语义)返回全部
    manager.registerView(2, { mode: 'ppapi', generation: 1, token: 't', kind: 'background' });
    expect(manager.snapshotBackground(2).scripts.map((s) => s.id).sort()).toEqual(['bg1', 'bg2']);
  });
});

describe('backoffDelayMs', () => {
  it('produces 1s,2s,4s,8s,60s for attempts 1..5', () => {
    expect(backoffDelayMs(1)).toBe(1000);
    expect(backoffDelayMs(2)).toBe(2000);
    expect(backoffDelayMs(3)).toBe(4000);
    expect(backoffDelayMs(4)).toBe(8000);
    expect(backoffDelayMs(5)).toBe(60000);
    expect(backoffDelayMs(10)).toBe(60000);
  });
  it('invalid attempts fall back to 1s', () => {
    expect(backoffDelayMs(0)).toBe(1000);
    expect(backoffDelayMs(-1)).toBe(1000);
  });
});
