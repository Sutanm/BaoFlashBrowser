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
    const transform = { scaleX: 1, scaleY: 1 };
    expect(surfaceReferenceImageScales([{ width: 760, height: 150, viewportTransform: transform }], { width: 950, height: 187.5, viewportTransform: transform })).toEqual([1.25]);
    expect(surfaceReferenceImageScales([
      { width: 760, height: 150, viewportTransform: transform }, { width: 760, height: 150, viewportTransform: transform },
    ], { width: 570, height: 112.5, viewportTransform: transform })).toEqual([0.75]);
    expect(surfaceReferenceImageScales([{ width: 760, height: 150, viewportTransform: transform }], { width: 950, height: 150, viewportTransform: transform })).toBeUndefined();
    expect(surfaceReferenceImageScales([
      { width: 760, height: 150, viewportTransform: transform }, { width: 600, height: 120, viewportTransform: transform },
    ], { width: 760, height: 150, viewportTransform: transform })).toBeUndefined();
    expect(surfaceReferenceImageScales([{ width: 760, height: 150 }], { width: 950, height: 187.5, viewportTransform: transform })).toBeUndefined();
    expect(surfaceReferenceImageScales([
      { width: 760, height: 150, viewportTransform: { scaleX: 2 / 3, scaleY: 2 / 3 } },
    ], { width: 760, height: 150, viewportTransform: transform })?.[0]).toBeCloseTo(2 / 3);
    expect(surfaceReferenceImageScales([
      { width: 760, height: 150, viewportTransform: transform },
    ], { width: 760, height: 150, viewportTransform: { scaleX: .5, scaleY: .75 } })).toBeUndefined();
  });

  it('retries authoring capture when the viewport revision changes mid-frame', async () => {
    let revision = 1; let scale = 1;
    const capturePage = vi.fn(async () => {
      if (revision === 1) { revision = 2; scale = .5; }
      return capturedImage(1280, 720);
    });
    const session = new BrowserViewAutomationCoreSession({
      tabId: 'tab-capture-revision',
      webContents: { incrementCapturerCount: vi.fn(), decrementCapturerCount: vi.fn(), capturePage },
      getCssViewport: () => ({ width: 1280, height: 720 }),
      getViewportTransform: () => ({ logicalSize: { width: 1280, height: 720 }, displaySize: { width: 1280 * scale, height: 720 * scale }, scaleX: scale, scaleY: scale }),
      getViewportRevision: () => revision,
      assertCurrent: vi.fn(), waitForViewport: vi.fn(async () => undefined), release: vi.fn(),
    } as never, source(), undefined, undefined, undefined, { matcher: { close: vi.fn() } as never, ocrEngine: { recognize: vi.fn(async () => []) } });

    await expect(session.capturePreviewWithViewportTransform()).resolves.toMatchObject({ viewportTransform: { scaleX: .5, scaleY: .5 } });
    expect(capturePage).toHaveBeenCalledTimes(2);
    await session.close();
  });

  it('uses the same transform-aware Surface prediction in authoring preview', async () => {
    const capturePage = vi.fn(async () => capturedImage(1280, 720));
    const attemptedScales: number[][] = [];
    const findMany = vi.fn<AutomationVisionMatcher['findMany']>(async (_assets, _frame, options) => {
      attemptedScales.push(options.scales ?? []);
      return { x: 10, y: 20, width: 30, height: 40, score: attemptedScales.length === 1 ? .99 : .2, scale: options.scales?.[0], asset: 'button.png' };
    });
    const session = new BrowserViewAutomationCoreSession({
      tabId: 'tab-authoring-scale',
      webContents: { incrementCapturerCount: vi.fn(), decrementCapturerCount: vi.fn(), capturePage },
      getCssViewport: () => ({ width: 1280, height: 720 }),
      getViewportTransform: () => ({ logicalSize: { width: 1280, height: 720 }, displaySize: { width: 853, height: 480 }, scaleX: 853 / 1280, scaleY: 480 / 720 }),
      getViewportRevision: () => 2,
      assertCurrent: vi.fn(), waitForViewport: vi.fn(async () => undefined), release: vi.fn(),
    } as never, source(), undefined, undefined, undefined, {
      matcher: { find: vi.fn(), findMany, close: vi.fn() } as unknown as OpenCvWorkerMatcher,
      ocrEngine: { recognize: vi.fn(async () => []) },
    });

    await session.testImagePreview('button.png', .9, imageMatchScales(), DEFAULT_IMAGE_MATCH_MASK,
      { x: 0, y: 0, width: 640, height: 360 }, undefined, imageMatchFallbackScales(imageMatchScales()),
      [{ width: 640, height: 360, viewportTransform: { scaleX: 1, scaleY: 1 } }]);
    expect(attemptedScales[0]?.[0]).toBeCloseTo(1.5, 3);
    expect(attemptedScales[1]).not.toContain(1.5);
    await session.close();
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

  it('uses the injected production auto router for both acceptance and yellow authoring diagnostics', async () => {
    const capturePage = vi.fn(async () => capturedImage(1280, 720));
    const templateFindMany = vi.fn<AutomationVisionMatcher['findMany']>(async (_assets, _frame, options) => ({
      x: 10, y: 20, width: 30, height: 40, score: .42, asset: 'button.png', algorithm: 'template',
      matchMs: options.threshold,
    }));
    const automaticFindMany = vi.fn<AutomationVisionMatcher['findMany']>(async (_assets, _frame, options) => (
      options.threshold < 0
        ? { x: 10, y: 20, width: 30, height: 40, score: .42, asset: 'button.png', algorithm: 'color-points' }
        : null
    ));
    const matcher = { find: vi.fn(), findMany: templateFindMany, close: vi.fn() } as unknown as OpenCvWorkerMatcher;
    const colorMatcher = { close: vi.fn() };
    const automaticMatcher = { find: vi.fn(), findMany: automaticFindMany };
    const session = new BrowserViewAutomationCoreSession({
      tabId: 'tab-production-auto',
      webContents: { incrementCapturerCount: vi.fn(), decrementCapturerCount: vi.fn(), capturePage },
      getCssViewport: () => ({ width: 1280, height: 720 }),
      getViewportTransform: () => ({ logicalSize: { width: 1280, height: 720 }, displaySize: { width: 1280, height: 720 }, scaleX: 1, scaleY: 1 }),
      getViewportRevision: () => 1,
      assertCurrent: vi.fn(), waitForViewport: vi.fn(async () => undefined), release: vi.fn(),
    } as never, source(), undefined, undefined, undefined, {
      matcher,
      colorMatcher: colorMatcher as never,
      automaticMatcher: automaticMatcher as never,
      ocrEngine: { recognize: vi.fn(async () => []) },
    });

    const result = await session.testImagePreview('button.png', .9, [1], DEFAULT_IMAGE_MATCH_MASK);
    expect(automaticFindMany).toHaveBeenCalledTimes(2);
    expect(automaticFindMany.mock.calls[0]?.[2].threshold).toBe(.9);
    expect(automaticFindMany.mock.calls[1]?.[2].threshold).toBe(-1);
    expect(templateFindMany).not.toHaveBeenCalled();
    expect(result.bitmapMatch).toMatchObject({ score: .42, algorithm: 'color-points' });
    expect(result.accepted).toBe(false);
    await session.close();
    expect(colorMatcher.close).not.toHaveBeenCalled();
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
        'assets/button.png': { source: 'capture', reference: { kind: 'surface', width: 512, height: 288, viewportTransform: { scaleX: 1, scaleY: 1 } } },
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
        'assets/button.png': { source: 'capture', reference: { kind: 'surface', width: 512, height: 288, viewportTransform: { scaleX: 1, scaleY: 1 } } },
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

  it('REPRO: recomputes the Surface scale to include a runtime page zoom that differs from authoring', async () => {
    // Authoring (取材) happens at zoom=1 -> asset reference records the LOGICAL surface size.
    // Runtime capture happens at zoom=1.5 -> displaySize = innerWidth/innerHeight shrink by 1/zoom,
    // but the surface's LOGICAL size (a same-size region) is unchanged, so a logical-only ratio is 1.0
    // while the true physical display scale (target grew 1.5x) must be 1.5.
    const capturePage = vi.fn(async () => capturedImage(1280, 720));
    const attemptedScales: number[][] = [];
    const findMany = vi.fn<AutomationVisionMatcher['findMany']>(async (_assets, _frame, options) => {
      attemptedScales.push(options.scales ?? []);
      return null;
    });
    const matcher = { find: vi.fn(), findMany, close: vi.fn() } as unknown as OpenCvWorkerMatcher;
    const ocrEngine: AutomationOcrEngine = { recognize: vi.fn(async () => []) };
    const base = source();
    const workflow = {
      formatVersion: 3 as const, id: 'zoom-scale', name: 'Zoom scale', root: {
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
        'assets/button.png': { source: 'capture', reference: { kind: 'surface', width: 512, height: 288, viewportTransform: { scaleX: 1, scaleY: 1 } } },
      } },
      workflow,
      assets: new Map([['assets/button.png', new Uint8Array([1])]]),
    };
    const release = vi.fn();
    const session = new BrowserViewAutomationCoreSession({
      tabId: 'tab-zoom-scale',
      webContents: { incrementCapturerCount: vi.fn(), decrementCapturerCount: vi.fn(), capturePage },
      getCssViewport: () => ({ width: 1280, height: 720 }),
      // zoom=1.5 => displaySize (innerWidth/innerHeight) shrink from 1280x720 to 853x480, scaleX=0.667=1/zoom.
      getViewportTransform: () => ({ logicalSize: { width: 1280, height: 720 }, displaySize: { width: 853, height: 480 }, scaleX: 853 / 1280, scaleY: 480 / 720 }),
      getViewportRevision: () => 1,
      assertCurrent: vi.fn(), waitForViewport: vi.fn(async () => undefined), release,
    } as never, pkg, undefined, undefined, undefined, { matcher, ocrEngine });

    await expect(session.startWorkflow().completion).resolves.toMatchObject({ status: 'completed' });
    // The surface reference is the authored LOGICAL size (512x288); the runtime searchRegion logical size is
    // 640x360 (region unchanged). A logical-only ratio gives 640/512=1.25, which IGNORES the 1.5x zoom.
    // The true physical display scale (target rendered 1.5x larger at runtime) must be 1.25*1.5=1.875.
    expect(attemptedScales[0]?.[0]).toBeCloseTo(1.875, 3);
    await session.close();
  });

  it('reuses and migrates a successful implicit fallback scale when runtime zoom changes', async () => {
    const capturePage = vi.fn(async () => capturedImage(1280, 720));
    const attemptedScales: number[][] = [];
    let viewportScale = 1;
    let revision = 1;
    const findMany = vi.fn<AutomationVisionMatcher['findMany']>(async (_assets, _frame, options) => {
      attemptedScales.push(options.scales ?? []);
      if (attemptedScales.length === 1) return null;
      const scale = attemptedScales.length === 2
        ? .5
        : options.scales?.[Math.floor((options.scales?.length ?? 1) / 2)] ?? .5;
      if (attemptedScales.length === 3) { viewportScale = .5; revision = 2; }
      return { x: 20, y: 30, width: 40, height: 50, score: .99, asset: 'direction-1.png', scale };
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
            { id: 'third', kind: 'query', assignTo: 'thirdFound', valueType: 'boolean', query: { kind: 'exists', resultType: 'boolean', locator: { kind: 'image', asset: 'direction-1.png', alternatives: ['direction-2.png'], threshold: .9 } } },
          ],
        },
      },
    };
    const session = new BrowserViewAutomationCoreSession({
      tabId: 'tab-learn-image-scale',
      webContents: { incrementCapturerCount: vi.fn(), decrementCapturerCount: vi.fn(), capturePage },
      getCssViewport: () => ({ width: 1280, height: 720 }),
      getViewportTransform: () => ({ logicalSize: { width: 1280, height: 720 }, displaySize: { width: 1280 * viewportScale, height: 720 * viewportScale }, scaleX: viewportScale, scaleY: viewportScale }),
      getViewportRevision: () => revision,
      assertCurrent: vi.fn(), waitForViewport: vi.fn(async () => undefined), release: vi.fn(),
    } as never, pkg, undefined, undefined, undefined, { matcher, ocrEngine: { recognize: vi.fn(async () => []) } });

    await expect(session.startWorkflow().completion).resolves.toMatchObject({ status: 'completed' });
    expect(attemptedScales).toEqual([
      [0.75, 1, 1.25],
      [0.5, 1 / 1.75, 1 / 1.5, 0.8],
      [0.5],
      [1],
    ]);
    await session.close();
  });

  it('falls back to nearby and ordinary scales when the learned exact scale misses', async () => {
    const capturePage = vi.fn(async () => capturedImage(1280, 720));
    const attemptedScales: number[][] = [];
    const findMany = vi.fn<AutomationVisionMatcher['findMany']>(async (_assets, _frame, options) => {
      attemptedScales.push(options.scales ?? []);
      if (attemptedScales.length === 1 || attemptedScales.length === 3) return null;
      return { x: 20, y: 30, width: 40, height: 50, score: .99, asset: 'button.png', scale: .5 };
    });
    const matcher = { find: vi.fn(), findMany, close: vi.fn() } as unknown as OpenCvWorkerMatcher;
    const base = source();
    const pkg: AutomationPackageV3 = {
      ...base,
      workflow: {
        formatVersion: 3, id: 'learn-image-scale-fallback', name: 'Learn image scale fallback', root: {
          id: 'root', kind: 'sequence', nodes: [
            { id: 'first', kind: 'query', assignTo: 'firstFound', valueType: 'boolean', query: { kind: 'exists', resultType: 'boolean', locator: { kind: 'image', asset: 'button.png', threshold: .9 } } },
            { id: 'second', kind: 'query', assignTo: 'secondFound', valueType: 'boolean', query: { kind: 'exists', resultType: 'boolean', locator: { kind: 'image', asset: 'button.png', threshold: .9 } } },
          ],
        },
      },
    };
    const session = new BrowserViewAutomationCoreSession({
      tabId: 'tab-learn-image-scale-fallback',
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
      [0.5 * .97, 0.5 * 1.03, 0.75, 1, 1.25, 1 / 1.75, 1 / 1.5, 0.8],
    ]);
    await session.close();
  });

  it('keeps assistant, workbench and Blockly wired to the shared policy', () => {    const read = (file: string): string => fs.readFileSync(path.resolve(file), 'utf8');
    const assistant = read('src/main/modules/userscripts/bundled-scripts/automation-frame-assistant.user.js');
    const assistantIpc = read('src/main/ipc/automation-userscript-bridge.ipc.ts');
    const workbench = read('src/renderer/components/automation/AutomationPage.tsx');
    const blockly = read('src/renderer/components/automation/automation-blockly-v2-schema.ts');

    expect(assistant).not.toContain('scales: [0.75, 1, 1.25]');
    expect(assistant).toContain('Windows-DPI fallback policy');
    expect(assistant).toContain('bao-selected-asset');
    expect(assistant).toContain('data-panel="match"].bao-active{height:100%;min-height:0');
    expect(assistant).toContain('function mountRecognitionPreview');
    expect(assistant).toContain('function withAssistantTimeout');
    expect(assistant).toContain('async function monitorTick()');
    expect(assistant).toContain("setMonitorVisual(matched ? 'hit' : 'miss')");
    expect(assistant).toContain('renderPageCross(value)');
    expect(assistant).not.toContain('monitorCollapsed');
    expect(read('src/main/modules/automation/browserview-core-session.ts')).not.toMatch(/\[find(?:Image|Text)\]/u);
    expect(assistantIpc).toContain('parsed.data.scales');
    expect(workbench).toContain('imageMatchScales()');
    expect(blockly).toContain('DEFAULT_IMAGE_MATCH_THRESHOLD');
  });
});
