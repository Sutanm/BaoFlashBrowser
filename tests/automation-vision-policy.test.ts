import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { AutomationOcrEngine, AutomationVisionMatcher } from '../src/main/modules/automation/capability-contracts';
import { BrowserViewAutomationCoreSession } from '../src/main/modules/automation/browserview-core-session';
import type { OpenCvWorkerMatcher } from '../src/main/modules/automation/vision-worker-matcher';
import type { AutomationPackageV3 } from '../src/shared/automation/package-v3';
import {
  DEFAULT_IMAGE_MATCH_MASK,
  DEFAULT_IMAGE_MATCH_DPI_FALLBACK_SCALES,
  DEFAULT_IMAGE_MATCH_SCALES,
  DEFAULT_IMAGE_MATCH_THRESHOLD,
  imageMatchFallbackScales,
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
    expect(DEFAULT_IMAGE_MATCH_DPI_FALLBACK_SCALES).toEqual([0.5, 1 / 1.75, 1 / 1.5, 0.8]);
    expect(DEFAULT_IMAGE_MATCH_MASK).toBe('auto');
    expect(Object.isFrozen(DEFAULT_IMAGE_MATCH_SCALES)).toBe(true);
    expect(Object.isFrozen(DEFAULT_IMAGE_MATCH_DPI_FALLBACK_SCALES)).toBe(true);
    const first = imageMatchScales();
    first.push(2);
    expect(imageMatchScales()).toEqual([0.75, 1, 1.25]);
    expect(imageMatchFallbackScales([1.249])).toEqual([0.75, 1, 0.5, 1 / 1.75, 1 / 1.5, 0.8]);
    expect(imageMatchFallbackScales([0.75])).toEqual([1, 1.25, 0.5, 1 / 1.75, 1 / 1.5, 0.8]);
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

  it('reuses one live frame and keeps the stronger common-DPI fallback candidate in authoring', async () => {
    const capturePage = vi.fn(async () => capturedImage(1280, 720));
    const attemptedScales: number[][] = [];
    const findMany = vi.fn<AutomationVisionMatcher['findMany']>(async (_assets, _frame, options) => {
      attemptedScales.push(options.scales ?? []);
      return attemptedScales.length === 1
        ? { x: 10, y: 20, width: 30, height: 40, score: .28, scale: .75, asset: 'button.png' }
        : { x: 100, y: 200, width: 30, height: 40, score: .99, scale: 1 / 1.5, asset: 'button.png' };
    });
    const matcher = { find: vi.fn(), findMany, close: vi.fn() } as unknown as OpenCvWorkerMatcher;
    const session = new BrowserViewAutomationCoreSession({
      tabId: 'tab-authoring-dpi',
      webContents: { incrementCapturerCount: vi.fn(), decrementCapturerCount: vi.fn(), capturePage },
      getCssViewport: () => ({ width: 1280, height: 720 }),
      getViewportTransform: () => ({ logicalSize: { width: 1280, height: 720 }, displaySize: { width: 1280, height: 720 }, scaleX: 1, scaleY: 1 }),
      getViewportRevision: () => 1,
      assertCurrent: vi.fn(), waitForViewport: vi.fn(async () => undefined), release: vi.fn(),
    } as never, source(), undefined, undefined, undefined, { matcher, ocrEngine: { recognize: vi.fn(async () => []) } });

    const result = await session.testImagePreview(
      'button.png', .9, imageMatchScales(), DEFAULT_IMAGE_MATCH_MASK, undefined, undefined,
      [...DEFAULT_IMAGE_MATCH_DPI_FALLBACK_SCALES],
    );
    expect(capturePage).toHaveBeenCalledTimes(1);
    expect(attemptedScales).toEqual([[0.75, 1, 1.25], [0.5, 1 / 1.75, 1 / 1.5, 0.8]]);
    expect(result.bitmapMatch).toMatchObject({ score: .99, scale: 1 / 1.5, x: 100, y: 200 });
    await session.close();
  });

  it('falls back to the remaining ordinary-user scales when a trusted Surface prediction misses', async () => {
    const capturePage = vi.fn(async () => capturedImage(1280, 720));
    const attemptedScales: number[][] = [];
    const findMany = vi.fn<AutomationVisionMatcher['findMany']>(async (_assets, _frame, options) => {
      attemptedScales.push(options.scales ?? []);
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
    expect(attemptedScales).toEqual([[1.25], [0.75, 1, 0.5, 1 / 1.75, 1 / 1.5, 0.8]]);
    expect(findMany).toHaveBeenCalledTimes(2);
    await session.close();
  });

  it('keeps the Surface prediction as the single fast pass when it reaches the locator threshold', async () => {
    const capturePage = vi.fn(async () => capturedImage(1280, 720));
    const findMany = vi.fn<AutomationVisionMatcher['findMany']>(async (_assets, _frame, options) => ({
      x: 20, y: 30, width: 40, height: 50, score: .98, asset: 'button.png', scale: options.scales?.[0],
    }));
    const matcher = { find: vi.fn(), findMany, close: vi.fn() } as unknown as OpenCvWorkerMatcher;
    const ocrEngine: AutomationOcrEngine = { recognize: vi.fn(async () => []) };
    const base = source();
    const pkg: AutomationPackageV3 = {
      ...base,
      manifest: { ...base.manifest, assetMetadata: {
        'assets/button.png': { source: 'capture', reference: { kind: 'surface', width: 512, height: 288 } },
      } },
      workflow: {
        formatVersion: 3, id: 'surface-fast-hit', name: 'Surface fast hit', root: {
          id: 'surface', kind: 'with', region: { unit: 'logical', x: 0, y: 0, width: 640, height: 360 },
          body: {
            id: 'exists', kind: 'query', assignTo: 'found', valueType: 'boolean',
            query: { kind: 'exists', resultType: 'boolean', locator: { kind: 'image', asset: 'button.png', threshold: .9 } },
          },
        },
      },
      assets: new Map([['assets/button.png', new Uint8Array([1])]]),
    };
    const session = new BrowserViewAutomationCoreSession({
      tabId: 'tab-fast-hit',
      webContents: { incrementCapturerCount: vi.fn(), decrementCapturerCount: vi.fn(), capturePage },
      getCssViewport: () => ({ width: 1280, height: 720 }),
      getViewportTransform: () => ({ logicalSize: { width: 1280, height: 720 }, displaySize: { width: 1280, height: 720 }, scaleX: 1, scaleY: 1 }),
      getViewportRevision: () => 1,
      assertCurrent: vi.fn(), waitForViewport: vi.fn(async () => undefined), release: vi.fn(),
    } as never, pkg, undefined, undefined, undefined, { matcher, ocrEngine });

    await expect(session.startWorkflow().completion).resolves.toMatchObject({ status: 'completed' });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0]?.[2].scales).toEqual([1.25]);
    await session.close();
  });

  it('reuses a successful implicit fallback scale for repeated image-group lookups', async () => {
    const capturePage = vi.fn(async () => capturedImage(1280, 720));
    const attemptedScales: number[][] = [];
    const findMany = vi.fn<AutomationVisionMatcher['findMany']>(async (_assets, _frame, options) => {
      attemptedScales.push(options.scales ?? []);
      if (attemptedScales.length === 1) return null;
      return { x: 20, y: 30, width: 40, height: 50, score: .99, asset: 'direction-1.png', scale: .5 };
    });
    const matcher = { find: vi.fn(), findMany, close: vi.fn() } as unknown as OpenCvWorkerMatcher;
    const base = source();
    const pkg: AutomationPackageV3 = {
      ...base,
      workflow: {
        formatVersion: 3, id: 'learn-image-scale', name: 'Learn image scale', root: {
          id: 'root', kind: 'sequence', nodes: [
            { id: 'first', kind: 'query', assignTo: 'firstFound', valueType: 'boolean', query: { kind: 'exists', resultType: 'boolean', locator: { kind: 'image', asset: 'direction-1.png', alternatives: ['direction-2.png'], threshold: .9 } } },
            { id: 'second', kind: 'query', assignTo: 'secondFound', valueType: 'boolean', query: { kind: 'exists', resultType: 'boolean', locator: { kind: 'image', asset: 'direction-1.png', alternatives: ['direction-2.png'], threshold: .9 } } },
          ],
        },
      },
    };
    const session = new BrowserViewAutomationCoreSession({
      tabId: 'tab-learn-image-scale',
      webContents: { incrementCapturerCount: vi.fn(), decrementCapturerCount: vi.fn(), capturePage },
      getCssViewport: () => ({ width: 1280, height: 720 }),
      getViewportTransform: () => ({ logicalSize: { width: 1280, height: 720 }, displaySize: { width: 1280, height: 720 }, scaleX: 1, scaleY: 1 }),
      getViewportRevision: () => 1,
      assertCurrent: vi.fn(), waitForViewport: vi.fn(async () => undefined), release: vi.fn(),
    } as never, pkg, undefined, undefined, undefined, { matcher, ocrEngine: { recognize: vi.fn(async () => []) } });

    await expect(session.startWorkflow().completion).resolves.toMatchObject({ status: 'completed' });
    expect(attemptedScales).toEqual([
      [0.75, 1, 1.25],
      [0.5, 1 / 1.75, 1 / 1.5, 0.8],
      [0.5],
    ]);
    await session.close();
  });

  it('keeps assistant, workbench and Blockly wired to the shared policy', () => {
    const read = (file: string): string => fs.readFileSync(path.resolve(file), 'utf8');
    const assistant = read('src/main/modules/userscripts/bundled-scripts/automation-frame-assistant.user.js');
    const assistantIpc = read('src/main/ipc/userscripts.ipc.ts');
    const workbench = read('src/renderer/components/automation/AutomationPage.tsx');
    const blockly = read('src/renderer/components/automation/automation-blockly-v2-schema.ts');

    expect(assistant).not.toContain('scales: [0.75, 1, 1.25]');
    expect(assistant).toContain('Windows-DPI fallback policy');
    expect(assistant).toContain('bao-selected-asset');
    expect(assistant).toContain('data-panel="match"].bao-active{height:100%;min-height:0');
    expect(assistant).toContain('function mountRecognitionPreview');
    expect(assistant).toContain('function withAssistantTimeout');
    expect(assistant).toContain('if (state.monitor) stopMonitor()');
    expect(read('src/main/modules/automation/browserview-core-session.ts')).not.toMatch(/\[find(?:Image|Text)\]/u);
    expect(assistantIpc).toContain('parsed.data.scales');
    expect(workbench).toContain('imageMatchScales()');
    expect(blockly).toContain('DEFAULT_IMAGE_MATCH_THRESHOLD');
  });
});
