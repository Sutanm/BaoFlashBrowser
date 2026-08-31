import { describe, expect, it, vi } from 'vitest';
import {
  AutomationActionRegistry,
  affine,
  AutomationLocatorQueries,
  AutomationLocatorRegistry,
  CoordinateLocatorResolver,
  FirstOfLocatorResolver,
  ImageLocatorResolver,
  TextLocatorResolver,
  generation,
  locatedTarget,
  point,
  region,
  registerPointerActions,
  resolveLocatorCaptureRegion,
  resolvedSurface,
  size,
  surfaceId,
  targetId,
  viewportSpace,
  type ImageLocator,
  type LocatedTargetInputPort,
  type LocatorContext,
  type LocatorRecognitionPort,
  type LocatorResolver,
  type LocatorSpec,
  type RecognitionCandidate,
} from '../src/shared/automation/core';
import { AutomationCoordinateResolver } from '../src/shared/automation/core/coordinate-resolver';

type ColorLocator = { readonly kind: 'color'; readonly rgb: readonly [number, number, number]; readonly tolerance: number };

declare module '../src/shared/automation/core/locator' {
  interface LocatorSpecMap {
    readonly color: ColorLocator;
  }
}

const viewport = viewportSpace({ targetId: targetId('tab-1'), targetGeneration: generation(1), viewportGeneration: generation(1) });

function context(now = vi.fn(() => 100)): LocatorContext {
  return {
    currentSpace: viewport,
    coordinateResolver: new AutomationCoordinateResolver({ viewport, viewportSize: size(1000, 600) }),
    signal: new AbortController().signal,
    now,
  };
}

class ColorResolver implements LocatorResolver<ColorLocator> {
  readonly kind = 'color' as const;
  async locate(locator: ColorLocator): Promise<{ status: 'matched'; targets: readonly ReturnType<typeof locatedTarget>[] }> {
    return {
      status: 'matched',
      targets: [locatedTarget({
        space: viewport,
        activationPoint: point('logical', viewport, locator.rgb[0], locator.rgb[1]),
        bounds: region('logical', viewport, locator.rgb[0] - 5, locator.rgb[1] - 5, 10, 10),
        confidence: 1,
        locatorFingerprint: `color:${locator.rgb.join(',')}`,
        resolvedAt: 100,
      })],
    };
  }
}

function registries(input: LocatedTargetInputPort): { locators: AutomationLocatorRegistry; actions: AutomationActionRegistry } {
  const locators = new AutomationLocatorRegistry();
  locators.register(new CoordinateLocatorResolver());
  locators.register(new ColorResolver());
  locators.register(new FirstOfLocatorResolver(locators));
  locators.freeze();
  const actions = new AutomationActionRegistry();
  registerPointerActions(actions, locators, input);
  actions.freeze();
  return { locators, actions };
}

describe('Automation 2.0 Locator × Action Core', () => {
  it('scopes recognition to the active game Surface and inherited Region', () => {
    const surface = resolvedSurface({
      id: surfaceId('game'), generation: generation(1), target: viewport,
      spec: { kind: 'named', name: 'game' }, parentSpace: viewport,
      boundsInParent: region('logical', viewport, 100, 50, 400, 300), localSize: size(400, 300),
      toViewport: affine(1, 0, 0, 1, 100, 50),
    });
    const coordinateResolver = new AutomationCoordinateResolver({ viewport, viewportSize: size(1000, 600), surfaces: [surface] });
    const base: LocatorContext = { ...context(), currentSpace: surface.space, coordinateResolver };
    expect(resolveLocatorCaptureRegion(undefined, base)).toMatchObject({ x: 100, y: 50, width: 400, height: 300, space: viewport });
    expect(resolveLocatorCaptureRegion(undefined, { ...base, defaultRegion: { unit: 'ratio', x: .25, y: .2, width: .5, height: .5 } }))
      .toMatchObject({ x: 200, y: 110, width: 200, height: 150, space: viewport });
  });

  it('resolves CoordinateLocator into a generation-bound LocatedTarget', async () => {
    const locators = new AutomationLocatorRegistry();
    locators.register(new CoordinateLocatorResolver());
    const target = await locators.resolveTarget({ locator: { kind: 'coordinate', point: { unit: 'ratio', x: .5, y: .25 } } }, context());
    expect(target.activationPoint).toMatchObject({ x: 499.5, y: 149.75, space: viewport });
    expect(target.bounds).toBeUndefined();
  });

  it('uses selection, anchor and offset without exposing Locator kind to Actions', async () => {
    const locators = new AutomationLocatorRegistry();
    locators.register(new ColorResolver());
    const target = await locators.resolveTarget({
      locator: { kind: 'color', rgb: [20, 30, 40], tolerance: 2 },
      anchor: 'bottom-right',
      offset: { unit: 'logical', dx: 2, dy: -3 },
    }, context());
    expect(target.activationPoint).toMatchObject({ x: 27, y: 32 });
  });

  it('executes Click, Move and Drag with a newly added ColorLocator and zero Action variants', async () => {
    const input: LocatedTargetInputPort = { click: vi.fn(), move: vi.fn(), drag: vi.fn() };
    const { actions } = registries(input);
    const color: ColorLocator = { kind: 'color', rgb: [100, 120, 10], tolerance: 3 };
    const coordinate = { kind: 'coordinate', point: { unit: 'logical', x: 400, y: 300 } } as const;
    await actions.execute({ kind: 'click', target: { locator: color } }, context());
    await actions.execute({ kind: 'move', target: { locator: color }, durationMs: 25 }, context());
    await actions.execute({ kind: 'drag', from: { locator: color }, to: { locator: coordinate }, durationMs: 50 }, context());
    expect(input.click).toHaveBeenCalledTimes(1);
    expect(input.move).toHaveBeenCalledTimes(1);
    expect(input.drag).toHaveBeenCalledTimes(1);
    expect(vi.mocked(input.click).mock.calls[0][0].activationPoint).toMatchObject({ x: 100, y: 120 });
  });

  it('shares one observation scope inside Drag but not across separate Actions', async () => {
    const scopes: Array<object | undefined> = [];
    const port: LocatorRecognitionPort = {
      locateImage: vi.fn(async (_locator, locatorContext) => {
        scopes.push(locatorContext.observationScope);
        return [{
          space: viewport,
          bounds: region('logical', viewport, 10 + scopes.length * 10, 20, 20, 20),
          confidence: .99,
          fingerprint: `scope-${scopes.length}`,
        }];
      }),
      locateText: vi.fn(async () => []),
    };
    const locators = new AutomationLocatorRegistry();
    locators.register(new ImageLocatorResolver(port));
    const input: LocatedTargetInputPort = { click: vi.fn(), move: vi.fn(), drag: vi.fn() };
    const actions = new AutomationActionRegistry();
    registerPointerActions(actions, locators, input);
    const target = (asset: string) => ({ locator: { kind: 'image', asset, threshold: .9 } as ImageLocator });

    await actions.execute({ kind: 'drag', from: target('from.png'), to: target('to.png') }, context());
    await actions.execute({ kind: 'click', target: target('click.png') }, context());

    expect(scopes).toHaveLength(3);
    expect(scopes[0]).toBeDefined();
    expect(scopes[1]).toBe(scopes[0]);
    expect(scopes[2]).not.toBe(scopes[0]);
  });

  it('adapts Image and Text recognition candidates to the same LocatedTarget shape', async () => {
    const candidate = (confidence: number): RecognitionCandidate => ({
      space: viewport,
      bounds: region('logical', viewport, 100, 200, 80, 40),
      confidence,
      fingerprint: `candidate:${confidence}`,
    });
    const port: LocatorRecognitionPort = {
      locateImage: vi.fn(async (_locator, _context, maxCandidates) => [candidate(.95), candidate(.8)].slice(0, maxCandidates)),
      locateText: vi.fn(async () => [candidate(.9)]),
    };
    const locators = new AutomationLocatorRegistry();
    locators.register(new ImageLocatorResolver(port));
    locators.register(new TextLocatorResolver(port));
    const image = await locators.resolveTarget({ locator: { kind: 'image', asset: 'buy.png', threshold: .8 } }, context());
    const text = await locators.resolveTarget({ locator: { kind: 'text', text: '购买', match: 'exact', minConfidence: .7 } }, context());
    expect(image).toMatchObject({ confidence: .95, activationPoint: { x: 140, y: 220 } });
    expect(text).toMatchObject({ confidence: .9, activationPoint: { x: 140, y: 220 } });
  });

  it('requests multiple image candidates only for spatial selection policies', async () => {
    const candidates: RecognitionCandidate[] = [
      { space: viewport, bounds: region('logical', viewport, 10, 20, 20, 20), confidence: .82, fingerprint: 'first' },
      { space: viewport, bounds: region('logical', viewport, 300, 120, 20, 20), confidence: .99, fingerprint: 'best' },
      { space: viewport, bounds: region('logical', viewport, 700, 400, 20, 20), confidence: .9, fingerprint: 'last' },
    ];
    const locateImage = vi.fn(async (_locator: ImageLocator, _context: LocatorContext, maxCandidates: number) => (
      maxCandidates === 1 ? [candidates[1]] : candidates.slice(0, maxCandidates)
    ));
    const port: LocatorRecognitionPort = { locateImage, locateText: vi.fn(async () => []) };
    const locators = new AutomationLocatorRegistry();
    locators.register(new ImageLocatorResolver(port));
    const locator: ImageLocator = { kind: 'image', asset: 'repeated.png', threshold: .8 };

    await expect(locators.resolveTarget({ locator }, context())).resolves.toMatchObject({ confidence: .99 });
    await expect(locators.resolveTarget({ locator, selection: { kind: 'first' } }, context()))
      .resolves.toMatchObject({ activationPoint: { x: 20, y: 30 } });
    await expect(locators.resolveTarget({ locator, selection: { kind: 'last' } }, context()))
      .resolves.toMatchObject({ activationPoint: { x: 710, y: 410 } });
    await expect(locators.resolveTarget({ locator, selection: { kind: 'index', index: 1 } }, context()))
      .resolves.toMatchObject({ confidence: .99 });
    await expect(locators.resolveTarget({ locator, selection: { kind: 'nearest', to: { unit: 'logical', x: 680, y: 390 } } }, context()))
      .resolves.toMatchObject({ activationPoint: { x: 710, y: 410 } });
    expect(locateImage.mock.calls.map((call) => call[2])).toEqual([1, 100, 100, 100, 100]);
  });

  it('supports generic firstOf fallback and typed miss', async () => {
    const port: LocatorRecognitionPort = { locateImage: vi.fn(async () => []), locateText: vi.fn(async () => []) };
    const locators = new AutomationLocatorRegistry();
    locators.register(new CoordinateLocatorResolver());
    locators.register(new ImageLocatorResolver(port));
    locators.register(new FirstOfLocatorResolver(locators));
    const fallback: LocatorSpec = {
      kind: 'firstOf',
      locators: [
        { kind: 'image', asset: 'missing.png', threshold: .9 } as ImageLocator,
        { kind: 'coordinate', point: { unit: 'logical', x: 25, y: 35 } },
      ],
    };
    expect(await locators.resolveTarget({ locator: fallback }, context())).toMatchObject({ activationPoint: { x: 25, y: 35 } });
    await expect(locators.resolveTarget({ locator: { kind: 'image', asset: 'missing.png', threshold: .9 } }, context()))
      .rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' });
  });

  it('Find/Exists/Wait only soften a definite miss', async () => {
    let calls = 0;
    let clock = 0;
    const port: LocatorRecognitionPort = {
      locateImage: vi.fn(async () => ++calls >= 3 ? [{
        space: viewport, bounds: region('logical', viewport, 10, 20, 30, 40), confidence: .9, fingerprint: 'found',
      }] : []),
      locateText: vi.fn(async () => []),
    };
    const locators = new AutomationLocatorRegistry();
    locators.register(new ImageLocatorResolver(port));
    const queries = new AutomationLocatorQueries(locators);
    const locator: ImageLocator = { kind: 'image', asset: 'late.png', threshold: .8 };
    const base = context(() => clock);
    expect(await queries.exists(locator, base)).toBe(false);
    const found = await queries.wait(locator, { state: 'visible', timeoutMs: 1000, pollIntervalMs: 50 }, {
      ...base,
      sleep: async (duration) => { clock += duration; },
    });
    expect(found).toMatchObject({ activationPoint: { x: 25, y: 40 } });
  });

  it('freezes registries and rejects stale LocatedTarget generations before input', async () => {
    const input: LocatedTargetInputPort = { click: vi.fn(), move: vi.fn(), drag: vi.fn() };
    const { locators, actions } = registries(input);
    expect(() => locators.register(new ColorResolver())).toThrowError(expect.objectContaining({ code: 'LOCATOR_REGISTRY_FROZEN' }));
    const staleContext = {
      ...context(),
      coordinateResolver: new AutomationCoordinateResolver({
        viewport: { ...viewport, viewportGeneration: generation(2) }, viewportSize: size(1000, 600),
      }),
    };
    await expect(actions.execute({ kind: 'click', target: { locator: { kind: 'color', rgb: [1, 2, 3], tolerance: 1 } } }, staleContext))
      .rejects.toMatchObject({ code: 'VIEWPORT_STALE' });
    expect(input.click).not.toHaveBeenCalled();
  });
});
