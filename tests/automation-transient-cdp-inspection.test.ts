import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);
vi.mock('../src/main/modules/password-capture', () => ({
  teardownCapture: () => calls.push('teardown'),
  setupCapture: () => calls.push('setup'),
}));

import { inspectWithPasswordCapturePaused } from '../src/main/modules/automation/transient-cdp-inspection';

const target = { isDestroyed: () => false } as Electron.WebContents;

describe('transient Automation CDP inspection', () => {
  it('pauses password capture before inspection and restores it afterward', async () => {
    calls.length = 0;
    await expect(inspectWithPasswordCapturePaused(target, async () => { calls.push('inspect'); return 7; })).resolves.toBe(7);
    expect(calls).toEqual(['teardown', 'inspect', 'setup']);
  });

  it('restores password capture after an inspection failure', async () => {
    calls.length = 0;
    await expect(inspectWithPasswordCapturePaused(target, async () => { calls.push('inspect'); throw new Error('failed'); })).rejects.toThrow('failed');
    expect(calls).toEqual(['teardown', 'inspect', 'setup']);
  });

  it('routes the assistant Surface IPC through TabManager inspection', () => {
    const source = fs.readFileSync(path.resolve('src/main/ipc/userscripts.ipc.ts'), 'utf8');
    const route = source.slice(source.indexOf("ipcMain.handle('userscript:automation-v3-surfaces'"), source.indexOf('// Script logging'));
    expect(route).toContain('tabManager.inspectAutomationTarget(targetTabId, detectGameSurfaces)');
    expect(route).not.toContain('detectGameSurfaces(event.sender)');
  });
});
