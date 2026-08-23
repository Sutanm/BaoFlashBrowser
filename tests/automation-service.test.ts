import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserView: class {},
  Menu: {},
  nativeImage: {},
}));
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('../src/main/modules/tabs', () => ({ tabManager: { beginAutomation: vi.fn() } }));

import { AutomationService } from '../src/main/modules/automation/service';
import { tabManager } from '../src/main/modules/tabs';

const temporaryRoots: string[] = [];
afterEach(() => { for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('AutomationService feature boundary', () => {
  it('enables the production automation feature by default', () => {
    const service = new AutomationService();
    expect(service.getStatus()).toEqual({ enabled: true, state: 'idle' });
  });

  it('allows package authoring while execution is disabled', async () => {
    const service = new AutomationService({ enabled: false });
    expect(service.getStatus()).toEqual({ enabled: false, state: 'idle' });
    const created = await service.createPackage('offline-authoring', '离线编辑');
    expect(service.getPackage(created.packageId).workflow.name).toBe('离线编辑');
    await expect(service.checkReady(created.packageId, 'tab-1')).rejects.toThrow(/disabled/);
  });

  it('emits a terminal status when an idle service is cancelled', async () => {
    const statuses: unknown[] = [];
    const service = new AutomationService({ enabled: true, emitStatus: (status) => statuses.push(status) });
    await service.cancel();
    expect(statuses).toEqual([]);
    expect(service.getStatus()).toEqual({ enabled: true, state: 'idle' });
  });

  it('releases the active-tab reservation after a standalone readiness check', async () => {
    const release = vi.fn();
    vi.mocked(tabManager.beginAutomation).mockReturnValue({
      tabId: 'tab-1', engine: 'ppapi', release,
      webContents: { id: 1 }, getCssViewport: () => ({ width: 800, height: 600 }), assertCurrent: vi.fn(),
    } as never);
    const service = new AutomationService({ enabled: true });
    const created = await service.createPackage('ready-release', 'Ready release');
    await expect(service.checkReady(created.packageId, 'tab-1')).resolves.toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('persists created, edited, duplicated and deleted packages', async () => {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baoauto-service-'));
    temporaryRoots.push(storageDir);
    const service = new AutomationService({ enabled: true, storageDir });
    await service.whenReady();
    const created = await service.createPackage('daily-login', '每日登录');
    await service.updateWorkflow(created.packageId, {
      formatVersion: 1, id: 'daily-login', name: '每日登录 v2',
      root: { type: 'sequence', steps: [{ type: 'delay', durationMs: 50 }] },
    });
    await service.importAssets(created.packageId, new Map([['buttons/start.png', new Uint8Array([137, 80, 78, 71])]]));
    const copied = await service.duplicatePackage(created.packageId, 'daily-login-copy', '每日登录副本');
    expect(fs.existsSync(path.join(storageDir, 'daily-login.baoauto'))).toBe(true);
    expect(fs.existsSync(path.join(storageDir, 'daily-login-copy.baoauto'))).toBe(true);

    const reloaded = new AutomationService({ enabled: true, storageDir });
    await reloaded.whenReady();
    expect(reloaded.listPackages().map((entry) => entry.id).sort()).toEqual(['daily-login', 'daily-login-copy']);
    expect(reloaded.getPackage(created.packageId).workflow.name).toBe('每日登录 v2');
    expect(reloaded.getPackage(copied.packageId).assets).toEqual(['buttons/start.png']);
    const asset = reloaded.getAsset(created.packageId, 'buttons/start.png');
    expect([...asset.bytes]).toEqual([137, 80, 78, 71]);
    asset.bytes[0] = 0;
    expect(reloaded.getAsset(created.packageId, 'buttons/start.png').bytes[0]).toBe(137);
    expect(() => reloaded.getAsset(created.packageId, '../missing.png')).toThrow(/missing/);
    expect(reloaded.getAssetReferences(created.packageId, 'buttons/start.png')).toEqual({ referenced: false });
    await reloaded.updateWorkflow(created.packageId, {
      formatVersion: 1, id: 'daily-login', name: '每日登录 v2',
      root: { type: 'sequence', steps: [{ type: 'click-image', asset: 'buttons/start.png' }] },
    });
    expect(reloaded.getAssetReferences(created.packageId, 'buttons/start.png')).toEqual({ referenced: true });
    await expect(reloaded.deleteAsset(created.packageId, 'buttons/start.png')).rejects.toThrow(/referenced/);
    expect(await reloaded.deleteAsset(copied.packageId, 'buttons/start.png')).toEqual([]);
    await reloaded.deletePackage(copied.packageId);
    expect(reloaded.listPackages()).toHaveLength(1);
    expect(fs.existsSync(path.join(storageDir, 'daily-login-copy.baoauto'))).toBe(false);
  });

  it('diagnoses packages and persists bounded terminal run history', async () => {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baoauto-diagnostics-'));
    temporaryRoots.push(storageDir);
    const release = vi.fn();
    vi.mocked(tabManager.beginAutomation).mockReturnValue({
      tabId: 'tab-history', engine: 'ppapi', release,
      webContents: { id: 3 }, getCssViewport: () => ({ width: 800, height: 600 }), assertCurrent: vi.fn(),
    } as never);
    const service = new AutomationService({ enabled: true, storageDir, appVersion: '1.0.1' });
    await service.whenReady();
    const created = await service.createPackage('history-test', 'History test');
    const diagnostic = service.diagnosePackage(created.packageId);
    expect(diagnostic.valid).toBe(true);
    expect(diagnostic.issues.some((issue) => issue.code === 'empty-workflow')).toBe(true);
    await expect(service.start(created.packageId, 'tab-history')).resolves.toBe(true);
    const history = await service.listRunHistory(created.packageId);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ packageId: created.packageId, state: 'completed', mode: 'run', executedSteps: 1 });
    const reloaded = new AutomationService({ enabled: true, storageDir, appVersion: '1.0.1' });
    await reloaded.whenReady();
    expect(await reloaded.listRunHistory(created.packageId)).toHaveLength(1);
    await reloaded.clearRunHistory(created.packageId);
    expect(await reloaded.listRunHistory(created.packageId)).toEqual([]);
  });
});
