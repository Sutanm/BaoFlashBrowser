import { describe, it, expect } from 'vitest';
import { mergeSidebarCommands, resolveCommandRoute } from '../src/main/modules/userscripts/userscript-sidebar';
import type { ScriptCommand } from '../src/shared/userscript-types';

const tabCmd: ScriptCommand = { commandId: 'd:s:1', scriptId: 's', documentId: 'd', title: 'T', isMainFrame: true };
const bgCmd: ScriptCommand = { commandId: 'bd:bs:1', scriptId: 'bs', documentId: 'bd', title: 'B', isMainFrame: true };

describe('mergeSidebarCommands', () => {
  it('keeps tab commands unchanged and marks background commands', () => {
    const merged = mergeSidebarCommands([tabCmd], [bgCmd]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual(tabCmd);
    expect(merged[0].background).toBeUndefined();
    expect(merged[1].background).toBe(true);
  });

  it('works with empty background list', () => {
    expect(mergeSidebarCommands([tabCmd], [])).toHaveLength(1);
  });
});

describe('resolveCommandRoute', () => {
  it('prefers the tab view', () => expect(resolveCommandRoute(true, true)).toBe('tab'));
  it('falls back to the background runtime', () => expect(resolveCommandRoute(false, true)).toBe('background'));
  it('returns none when nothing matches', () => expect(resolveCommandRoute(false, false)).toBe('none'));
});
