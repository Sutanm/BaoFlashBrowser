import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { AutomationOcrEngine, AutomationVisionMatcher } from '../src/main/modules/automation/capability-contracts';
import { BrowserViewAutomationCoreSession } from '../src/main/modules/automation/browserview-core-session';
import type { OpenCvWorkerMatcher } from '../src/main/modules/automation/vision-worker-matcher';
import type { AutomationPackageV3 } from '../src/shared/automation/package-v3';
import {
  DEFAULT_IMAGE_MATCH_MASK,
  DEFAULT_IMAGE_MATCH_SCALES,
  DEFAULT_IMAGE_MATCH_THRESHOLD,
  imageMatchScales,
  surfaceReferenceImageScales,
} from '../src/shared/automation/vision-policy';

function capturedImage(width: number, height: number) {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toPNG: () => Buffer.alloc(0),
    toBitmap: () => Buffer.alloc(width * height * 4),
  };
}

function source(): AutomationPackageV3 {
  return {
    manifest: {
      format: 'baoauto', formatVersion: 3, id: 'vision-policy', name: 'Vision policy',
      frontends: { workflow: 'workflow.json', scripts: [], mainEntryId: 'workflow' }, features: [], integrity: {},
    },
    workflow: { formatVersion: 3, id: 'vision-policy', name: 'Vision policy', root: { id: 'root', kind: 'sequence', nodes: [] } },
    scripts: new Map(), assets: new Map(), profiles: new Map(),
  };
}

describe('Automation image recognition policy', () => {
  it('owns immutable ordinary-user defaults in one shared module', () => {
    expect(DEFAULT_IMAGE_MATCH_THRESHOLD).toBe(0.9);
    expect(DEFAULT_IMAGE_MATCH_SCALES).toEqual([0.75, 1, 1.25]);
    expect(DEFAULT_IMAGE_MATCH_MASK).toBe('auto');
    expect(Object.isFrozen(DEFAULT_IMAGE_MATCH_SCALES)).toBe(true);
    const first = imageMatchScales();
    first.push(2);
    expect(imageMatchScales()).toEqual([0.75, 1, 1.25]);
  });

  it('predicts one scale only from consistent isotropic Surface references', () => {
    expect(surfaceReferenceImageScales([{ width: 760, height: 150 }], { width: 950, height: 187.5 })).toEqual([1.25]);
    expect(surfaceReferenceImageScales([
      { width: 760, height: 150 }, { width: 760, height: 150 },
    ], { width: 570, height: 112.5 })).toEqual([0.75]);
    expect(surfaceReferenceImageScales([{ width: 760, height: 150 }], { width: 950, height: 150 })).toBeUndefined();
    expect(surfaceReferenceImageScales([
      { width: 760, height: 150 }, { width: 600, height: 120 },
    ], { width: 760, height: 150 })).toBeUndefined();
  });

  it('uses one normalized full frame plus a logical OpenCV ROI at runtime', async () => {
    const capturePage = vi.fn(async () => capturedImage(1280, 720));
    const findMany = vi.fn<AutomationVisionMatcher['findMany']>(async (_assets, frame, options) => {
      expect(frame.bitmapSize).toEqual({ width: 1280, height: 720 });
      expect(options).toMatchObject({
        threshold: DEFAULT_IMAGE_MATCH_THRESHOLD,
        scales: [0.75, 1, 1.25],
        mask: DEFAULT_IMAGE_MATCH_MASK,
        region: { x: 100, y: 50, width: 400, height: 300 },
      });
      return { x: 120, y: 80, width: 20, height: 10, score: 0.99, asset: 'button.png' };
    });
    const matcher = { find: vi.fn(), findMany, close: vi.fn() } as unknown as OpenCvWorkerMatcher;
    const ocrEngine: AutomationOcrEngine = { recognize: vi.fn(async () => []) };
    const release = vi.fn();
    const session = new BrowserViewAutomationCoreSession({
      tabId: 'tab-1',
      webContents: {
        incrementCapturerCount: vi.fn(), decrementCapturerCount: vi.fn(), capturePage,
      },
      getCssViewport: () => ({ width: 1280, height: 720 }),
      getViewportTransform: () => ({ logicalSize: { width: 1280, height: 720 }, displaySize: { width: 900, height: 600 }, scaleX: 900 / 1280, scaleY: 600 / 720 }),
      getViewportRevision: () => 1,
      assertCurrent: vi.fn(), waitForViewport: vi.fn(async () => undefined), release,
    } as never, source(), undefined, undefined, undefined, { matcher, ocrEngine });

    await expect(session.testImage('button.png', undefined, undefined, undefined, {
      x: 100, y: 50, width: 400, height: 300,
    })).resolves.toMatchObject({ bounds: { x: 120, y: 80, width: 20, height: 10 }, score: 0.99 });
    expect(capturePage).toHaveBeenCalledWith(undefined);
    expect(findMany).toHaveBeenCalledTimes(1);
    await session.close();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('uses one predicted scale for trusted Surface-captured assets in an implicit-scale locator', async () => {
    const capturePage = vi.fn(async () => capturedImage(1280, 720));
    const findMany = vi.fn<AutomationVisionMatcher['findMany']>(async (_assets, _frame, options) => {
      expect(options.scales).toEqual([1.25]);
      expect(options.region).toEqual({ x: 0, y: 0, width: 640, height: 360 });
      return null;
    });
    const matcher = { find: vi.fn(), findMany, close: vi.fn() } as unknown as OpenCvWorkerMatcher;
    const ocrEngine: AutomationOcrEngine = { recognize: vi.fn(async () => []) };
    const base = source();
    const workflow = {
      formatVersion: 3 as const, id: 'surface-scale', name: 'Surface scale', root: {
        id: 'surface', kind: 'with' as const,
        region: { unit: 'logical' as const, x: 0, y: 0, width: 640, height: 360 },
        body: {
          id: 'exists', kind: 'query' as const, assignTo: 'found', valueType: 'boolean' as const,
          query: { kind: 'exists' as const, resultType: 'boolean' as const, locator: { kind: 'image' as const, asset: 'button.png', threshold: .9 } },
        },
      },
    };
    const pkg: AutomationPackageV3 = {
      ...base,
      manifest: { ...base.manifest, assetMetadata: {
        'assets/button.png': { source: 'capture', reference: { kind: 'surface', width: 512, height: 288 } },
      } },
      workflow,
      assets: new Map([['assets/button.png', new Uint8Array([1])]]),
    };
    const release = vi.fn();
    const session = new BrowserViewAutomationCoreSession({
      tabId: 'tab-scale',
      webContents: { incrementCapturerCount: vi.fn(), decrementCapturerCount: vi.fn(), capturePage },
      getCssViewport: () => ({ width: 1280, height: 720 }),
      getViewportTransform: () => ({ logicalSize: { width: 1280, height: 720 }, displaySize: { width: 1280, height: 720 }, scaleX: 1, scaleY: 1 }),
      getViewportRevision: () => 1,
      assertCurrent: vi.fn(), waitForViewport: vi.fn(async () => undefined), release,
    } as never, pkg, undefined, undefined, undefined, { matcher, ocrEngine });

    await expect(session.startWorkflow().completion).resolves.toMatchObject({ status: 'completed' });
    expect(findMany).toHaveBeenCalledTimes(1);
    await session.close();
  });

  it('keeps assistant, workbench and Blockly wired to the shared policy', () => {
    const read = (file: string): string => fs.readFileSync(path.resolve(file), 'utf8');
    const assistant = read('src/main/modules/userscripts/bundled-scripts/automation-frame-assistant.user.js');
    const assistantIpc = read('src/main/ipc/userscripts.ipc.ts');
    const workbench = read('src/renderer/components/automation/AutomationPage.tsx');
    const blockly = read('src/renderer/components/automation/automation-blockly-v2-schema.ts');

    expect(assistant).not.toContain('scales: [.75, 1, 1.25]');
    expect(assistantIpc).toContain('parsed.data.scales');
    expect(workbench).toContain('imageMatchScales()');
    expect(blockly).toContain('DEFAULT_IMAGE_MATCH_THRESHOLD');
  });
});
