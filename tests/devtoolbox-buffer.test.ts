import { describe, expect, it } from 'vitest';
import type { DevToolEntry } from '@shared/types/devtoolbox';
import {
  classifyMainLog,
  clip,
  EntryBuffer,
  mapConsoleLevel,
  MAX_TEXT,
} from '@main/modules/devtoolbox-buffer';

function entry(id: number): DevToolEntry {
  return { id, ts: id, source: 'main', level: 'info', text: `entry-${id}` };
}

describe('devtoolbox buffer helpers', () => {
  it('clip keeps short text intact and truncates long text with an ellipsis', () => {
    expect(clip('short')).toBe('short');
    const long = 'x'.repeat(MAX_TEXT + 10);
    const clipped = clip(long);
    expect(clipped.endsWith('…')).toBe(true);
    expect(clipped.length).toBe(MAX_TEXT + 1);
  });

  it('maps Electron console levels to toolbox levels', () => {
    expect(mapConsoleLevel(0)).toBe('verbose');
    expect(mapConsoleLevel(1)).toBe('info');
    expect(mapConsoleLevel(2)).toBe('warning');
    expect(mapConsoleLevel(3)).toBe('error');
    expect(mapConsoleLevel(9)).toBe('error');
  });

  it('classifies main-process log lines by module prefix', () => {
    expect(classifyMainLog('[PasswordCapture] captured host=a.com')).toBe('capture');
    expect(classifyMainLog('[Keyring] backend active: win-dpapi')).toBe('capture');
    expect(classifyMainLog('[ViewGate] verify start')).toBe('capture');
    expect(classifyMainLog('[Flash] Version: 34.0.0.330')).toBe('flash');
    expect(classifyMainLog('[Ruffle] source=bundled')).toBe('flash');
    expect(classifyMainLog('[IPC] tab:create failed')).toBe('log');
    expect(classifyMainLog('plain message')).toBe('log');
  });
});

describe('EntryBuffer', () => {
  it('rejects a non-positive capacity', () => {
    expect(() => new EntryBuffer(0)).toThrow(/positive/);
  });

  it('keeps only the most recent entries in the snapshot', () => {
    const buffer = new EntryBuffer(3);
    for (let i = 1; i <= 5; i += 1) buffer.push(entry(i));
    expect(buffer.snapshot().map((item) => item.id)).toEqual([3, 4, 5]);
  });

  it('drains pending batches in order and respects the batch size', () => {
    const buffer = new EntryBuffer(10);
    for (let i = 1; i <= 5; i += 1) buffer.push(entry(i));
    expect(buffer.pending).toBe(5);

    expect(buffer.takePending(2).map((item) => item.id)).toEqual([1, 2]);
    expect(buffer.pending).toBe(3);
    expect(buffer.takePending(10).map((item) => item.id)).toEqual([3, 4, 5]);
    expect(buffer.takePending(10)).toEqual([]);
  });

  it('clears both the snapshot and the pending queue', () => {
    const buffer = new EntryBuffer(10);
    buffer.push(entry(1));
    buffer.clear();
    expect(buffer.snapshot()).toEqual([]);
    expect(buffer.pending).toBe(0);
  });

  it('keeps the snapshot independent from later mutations', () => {
    const buffer = new EntryBuffer(10);
    buffer.push(entry(1));
    const snapshot = buffer.snapshot();
    buffer.push(entry(2));
    expect(snapshot.map((item) => item.id)).toEqual([1]);
  });
});
