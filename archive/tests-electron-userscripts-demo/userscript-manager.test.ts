import { describe, expect, it } from 'vitest';
import { UserscriptManager } from './userscript-manager';
import { ValueStore } from './userscript-store';

function makeManager(): UserscriptManager {
  const manager = new UserscriptManager(new ValueStore());
  manager.registerView(7, { mode: 'ppapi', generation: 1, token: 't' });
  return manager;
}

describe('userscript-manager menu commands', () => {
  it('accepts a well-formed scoped commandId', () => {
    const manager = makeManager();
    expect(manager.registerMenuCommand(7, 'demo:menu', 'doc-1', 'Title', 'doc-1:demo:menu:1')).toBe(true);
    expect(manager.commandTarget('doc-1:demo:menu:1')).toEqual({ wcId: 7, documentId: 'doc-1' });
  });

  it('rejects commandId whose scriptId does not match the payload', () => {
    const manager = makeManager();
    expect(manager.registerMenuCommand(7, 'demo:menu', 'doc-1', 'Title', 'doc-1:other:1')).toBe(false);
    expect(manager.registerMenuCommand(7, 'demo:menu', 'doc-1', 'Title', 'doc-1:demo:menu2:1')).toBe(false);
  });

  it('rejects non-positive or non-integer local ids', () => {
    const manager = makeManager();
    expect(manager.registerMenuCommand(7, 'demo:menu', 'doc-1', 'Title', 'doc-1:demo:menu:0')).toBe(false);
    expect(manager.registerMenuCommand(7, 'demo:menu', 'doc-1', 'Title', 'doc-1:demo:menu:-1')).toBe(false);
    expect(manager.registerMenuCommand(7, 'demo:menu', 'doc-1', 'Title', 'doc-1:demo:menu:abc')).toBe(false);
    expect(manager.registerMenuCommand(7, 'demo:menu', 'doc-1', 'Title', 'doc-1:demo:menu:1.5')).toBe(false);
    expect(manager.registerMenuCommand(7, 'demo:menu', 'doc-1', 'Title', 'doc-1:demo:menu:')).toBe(false);
  });

  it('rejects commandId for a different document', () => {
    const manager = makeManager();
    expect(manager.registerMenuCommand(7, 'demo:menu', 'doc-1', 'Title', 'doc-2:demo:menu:1')).toBe(false);
  });

  it('rejects commands from unregistered views', () => {
    const manager = new UserscriptManager(new ValueStore());
    expect(manager.registerMenuCommand(99, 'demo:menu', 'doc-1', 'Title', 'doc-1:demo:menu:1')).toBe(false);
  });

  it('unregisters and clears targets', () => {
    const manager = makeManager();
    manager.registerMenuCommand(7, 'demo:menu', 'doc-1', 'Title', 'doc-1:demo:menu:1');
    expect(manager.unregisterMenuCommand(7, 'doc-1:demo:menu:1')).toBe(true);
    expect(manager.commandTarget('doc-1:demo:menu:1')).toBeNull();
    expect(manager.unregisterMenuCommand(7, 'doc-1:demo:menu:1')).toBe(false);
  });

  it('rejects commandId longer than the cap', () => {
    const manager = makeManager();
    const longId = `doc-1:demo:menu:${'1'.repeat(400)}`;
    expect(manager.registerMenuCommand(7, 'demo:menu', 'doc-1', 'Title', longId)).toBe(false);
  });

  it('scopes commands per view', () => {
    const manager = makeManager();
    manager.registerView(8, { mode: 'ruffle', generation: 2, token: 't2' });
    manager.registerMenuCommand(8, 'demo:menu', 'doc-9', 'Title', 'doc-9:demo:menu:1');
    expect(manager.commandTarget('doc-9:demo:menu:1')).toEqual({ wcId: 8, documentId: 'doc-9' });
    expect(manager.commandsFor(7)).toEqual([]);
    expect(manager.commandsFor(8)).toHaveLength(1);
  });
});
