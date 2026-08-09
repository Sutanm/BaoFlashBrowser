// @vitest-environment node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decideCapture, getScreenshotDir, type DecideInput } from '../src/main/modules/screenshot';

const mockState = vi.hoisted(() => ({ screenshotDir: '', pictures: '' }));

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'pictures' ? mockState.pictures : 'USERDATA') },
}));
vi.mock('../src/main/modules/config', () => ({ loadConfig: () => ({ screenshotDir: mockState.screenshotDir }) }));
vi.mock('../src/main/modules/window', () => ({ getMainWindow: () => null }));
vi.mock('../src/main/modules/tabs', () => ({ tabManager: {} }));

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  mockState.screenshotDir = '';
  mockState.pictures = '';
});

const base: DecideInput = { hasWindow: true, minimized: false, hasWebContents: true, isActive: true, hiddenCaptureEnabled: false };

describe('capture policy decisions', () => {
  it('captures the active tab in any window state', () => {
    expect(decideCapture({ ...base, minimized: true })).toEqual({ action: 'capture' });
    expect(decideCapture(base)).toEqual({ action: 'capture' });
  });

  it('rejects when window or tab is gone', () => {
    expect(decideCapture({ ...base, hasWindow: false }).action).toBe('error');
    expect(decideCapture({ ...base, hasWebContents: false }).action).toBe('error');
  });

  it('rejects inactive tab while minimized', () => {
    const d = decideCapture({ ...base, isActive: false, minimized: true });
    expect(d.action).toBe('error');
    if (d.action === 'error') expect(d.code).toBe('MINIMIZED_INACTIVE');
  });

  it('rejects inactive tab when hidden capture is not verified yet', () => {
    const d = decideCapture({ ...base, isActive: false, minimized: false, hiddenCaptureEnabled: false });
    expect(d.action).toBe('error');
    if (d.action === 'error') expect(d.code).toBe('HIDDEN_UNCAPTURABLE');
  });

  it('allows inactive tab once hidden capture is enabled', () => {
    expect(decideCapture({ ...base, isActive: false, minimized: false, hiddenCaptureEnabled: true })).toEqual({ action: 'capture' });
  });
});

describe('screenshot directory resolution', () => {
  it('prefers configured directory', () => {
    mockState.screenshotDir = 'C:\\shots';
    expect(getScreenshotDir()).toBe('C:\\shots');
  });

  it('falls back to Pictures/BaoFlashBrowser when pictures exists and is writable', () => {
    const pic = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-pic-'));
    tempDirs.push(pic);
    mockState.pictures = pic;
    expect(getScreenshotDir()).toBe(path.join(pic, 'BaoFlashBrowser'));
  });

  it('falls back to userData/screenshots when pictures is missing', () => {
    mockState.pictures = '';
    expect(getScreenshotDir()).toBe(path.join('USERDATA', 'screenshots'));
  });
});
