import {
  AutomationGeometryError,
  type Point,
  type Region,
  type SpaceRef,
  type PersistedPoint,
  type PersistedVector,
  assertCurrentSpace,
  point,
  region,
  regionContainsPoint,
} from './geometry';
import type { AutomationCoordinateResolver } from './coordinate-resolver';
import type { FrameId } from './frame-geometry';
import type { PersistedRegion } from './surface';

export type CoordinateLocator = { readonly kind: 'coordinate'; readonly point: PersistedPoint };
export type ImageLocator = {
  readonly kind: 'image';
  readonly asset: string;
  /** Additional templates compared against the same captured frame. */
  readonly alternatives?: readonly string[];
  readonly threshold: number;
  readonly scales?: readonly number[];
  readonly mask?: 'auto' | 'none' | 'alpha';
  readonly region?: PersistedRegion;
};
export type TextLocator = {
  readonly kind: 'text';
  readonly text: string;
  readonly match: 'exact' | 'contains' | 'normalized';
  readonly minConfidence: number;
  readonly region?: PersistedRegion;
  readonly languageHint?: string;
};
export type FirstOfLocator = { readonly kind: 'firstOf'; readonly locators: readonly LocatorSpec[] };

export interface LocatorSpecMap {
  readonly coordinate: CoordinateLocator;
  readonly image: ImageLocator;
  readonly text: TextLocator;
  readonly firstOf: FirstOfLocator;
}

export type LocatorSpec = LocatorSpecMap[keyof LocatorSpecMap];
export type LocatorKind = LocatorSpec['kind'];

export type Anchor =
  | 'center'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | { readonly xRatio: number; readonly yRatio: number };

export type SelectionPolicy =
  | { readonly kind: 'best' }
  | { readonly kind: 'first' }
  | { readonly kind: 'last' }
  | { readonly kind: 'index'; readonly index: number }
  | { readonly kind: 'nearest'; readonly to: PersistedPoint };

export type TargetRef = {
  readonly locator: LocatorSpec;
  readonly anchor?: Anchor;
  readonly offset?: PersistedVector;
  readonly selection?: SelectionPolicy;
};

export type EvidenceRef = {
  readonly frameId: FrameId;
  readonly provider: string;
  readonly token: string;
};

export type LocatedTarget = {
  readonly id: string;
  readonly space: SpaceRef;
  readonly activationPoint: Point<'logical'>;
  readonly bounds?: Region<'logical'>;
  readonly confidence?: number;
  readonly frameId?: FrameId;
  readonly evidence?: EvidenceRef;
  readonly locatorFingerprint: string;
  readonly resolvedAt: number;
};

export type LocateOutcome =
  | { readonly status: 'matched'; readonly targets: readonly LocatedTarget[] }
  | { readonly status: 'not-found'; readonly reason: string };

export type LocatorErrorCode =
  | 'LOCATOR_NOT_REGISTERED'
  | 'LOCATOR_REGISTRY_FROZEN'
  | 'LOCATOR_DUPLICATE'
  | 'LOCATOR_INVALID'
  | 'TARGET_NOT_FOUND'
  | 'TARGET_SELECTION_INVALID'
  | 'TARGET_HAS_NO_REGION';

export class AutomationLocatorError extends Error {
  readonly code: LocatorErrorCode;

  constructor(code: LocatorErrorCode, message: string) {
    super(message);
    this.name = 'AutomationLocatorError';
    this.code = code;
  }
}

export type LocatorContext = {
  readonly currentSpace: SpaceRef;
  readonly coordinateResolver: AutomationCoordinateResolver;
  /** Default recognition/OCR region inherited from the active Context block. */
  readonly defaultRegion?: PersistedRegion;
  readonly signal: AbortSignal;
  readonly now: () => number;
};

/** Resolve an explicit or inherited recognition region into viewport logical coordinates. */
export function resolveLocatorCaptureRegion(value: PersistedRegion | undefined, context: LocatorContext): Region<'logical'> | undefined {
  const selected = value ?? context.defaultRegion;
  if (selected) return context.coordinateResolver.toViewport(region(selected.unit, context.currentSpace, selected.x, selected.y, selected.width, selected.height));
  if (context.currentSpace.kind === 'viewport') return undefined;
  const currentSize = context.coordinateResolver.sizeOf(context.currentSpace);
  return context.coordinateResolver.toViewport(region('logical', context.currentSpace, 0, 0, currentSize.width, currentSize.height));
}

export type LocateRequest = {
  readonly locator: LocatorSpec;
  readonly maxCandidates?: number;
};

export interface LocatorResolver<L extends LocatorSpec = LocatorSpec> {
  readonly kind: L['kind'];
  locate(locator: L, request: LocateRequest, context: LocatorContext): Promise<LocateOutcome>;
}

let nextLocatedTargetId = 1;

export function locatedTarget(input: Omit<LocatedTarget, 'id'> & { readonly id?: string }): LocatedTarget {
  assertCurrentSpace(input.activationPoint.space, input.space);
  if (input.bounds) assertCurrentSpace(input.bounds.space, input.space);
  if (input.confidence !== undefined && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) {
    throw new AutomationLocatorError('LOCATOR_INVALID', 'target confidence must be inside [0,1]');
  }
  if (!Number.isFinite(input.resolvedAt)) throw new AutomationLocatorError('LOCATOR_INVALID', 'target resolvedAt must be finite');
  return Object.freeze({ ...input, id: input.id ?? `located-${nextLocatedTargetId++}` });
}

function applyAnchor(target: LocatedTarget, anchor: Anchor | undefined): Point<'logical'> {
  if (!anchor || anchor === 'center') return target.activationPoint;
  const bounds = target.bounds;
  if (!bounds) throw new AutomationLocatorError('TARGET_HAS_NO_REGION', 'target anchor requires bounds');
  const ratio = typeof anchor === 'object' ? anchor : ({
    'top-left': { xRatio: 0, yRatio: 0 },
    'top-right': { xRatio: 1, yRatio: 0 },
    'bottom-left': { xRatio: 0, yRatio: 1 },
    'bottom-right': { xRatio: 1, yRatio: 1 },
  } as const)[anchor];
  if (ratio.xRatio < 0 || ratio.xRatio > 1 || ratio.yRatio < 0 || ratio.yRatio > 1) {
    throw new AutomationLocatorError('LOCATOR_INVALID', 'custom anchor must be inside [0,1]');
  }
  return point('logical', target.space,
    bounds.x + bounds.width * ratio.xRatio,
    bounds.y + bounds.height * ratio.yRatio);
}

function resolvePersistedPoint(value: PersistedPoint, context: LocatorContext): Point<'logical'> {
  return context.coordinateResolver.toLogical(point(value.unit, context.currentSpace, value.x, value.y));
}

function shapeTarget(target: LocatedTarget, ref: TargetRef, context: LocatorContext): LocatedTarget {
  let activationPoint = applyAnchor(target, ref.anchor);
  if (ref.offset) {
    const size = context.coordinateResolver.sizeOf(target.space);
    const dx = ref.offset.unit === 'ratio' ? ref.offset.dx * size.width : ref.offset.dx;
    const dy = ref.offset.unit === 'ratio' ? ref.offset.dy * size.height : ref.offset.dy;
    activationPoint = point('logical', target.space,
      activationPoint.x + dx, activationPoint.y + dy);
  }
  return activationPoint === target.activationPoint ? target : Object.freeze({ ...target, activationPoint });
}

function distanceSquared(first: Point<'logical'>, second: Point<'logical'>): number {
  assertCurrentSpace(first.space, second.space);
  return (first.x - second.x) ** 2 + (first.y - second.y) ** 2;
}

export class AutomationLocatorRegistry {
  private readonly entries = new Map<string, (locator: LocatorSpec, request: LocateRequest, context: LocatorContext) => Promise<LocateOutcome>>();
  private frozen = false;

  register<L extends LocatorSpec>(resolver: LocatorResolver<L>): void {
    if (this.frozen) throw new AutomationLocatorError('LOCATOR_REGISTRY_FROZEN', 'locator registry is frozen');
    if (this.entries.has(resolver.kind)) throw new AutomationLocatorError('LOCATOR_DUPLICATE', `locator resolver already registered: ${resolver.kind}`);
    this.entries.set(resolver.kind, (locator, request, context) => resolver.locate(locator as L, request, context));
  }

  freeze(): void { this.frozen = true; }

  async locate(request: LocateRequest, context: LocatorContext): Promise<LocateOutcome> {
    if (context.signal.aborted) throw new Error('automation cancelled');
    const entry = this.entries.get(request.locator.kind);
    if (!entry) throw new AutomationLocatorError('LOCATOR_NOT_REGISTERED', `locator resolver is not registered: ${request.locator.kind}`);
    const outcome = await entry(request.locator, request, context);
    if (outcome.status === 'not-found') return outcome;
    const maxCandidates = request.maxCandidates ?? 100;
    if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || outcome.targets.length > maxCandidates) {
      throw new AutomationLocatorError('LOCATOR_INVALID', `locator candidate budget exceeded: ${outcome.targets.length}/${maxCandidates}`);
    }
    for (const target of outcome.targets) context.coordinateResolver.assertSpaceCurrent(target.space);
    return Object.freeze({ status: 'matched', targets: Object.freeze([...outcome.targets]) });
  }

  async resolveTarget(ref: TargetRef, context: LocatorContext): Promise<LocatedTarget> {
    const outcome = await this.locate({ locator: ref.locator }, context);
    if (outcome.status === 'not-found' || outcome.targets.length === 0) {
      throw new AutomationLocatorError('TARGET_NOT_FOUND', outcome.status === 'not-found' ? outcome.reason : 'locator returned no candidates');
    }
    return shapeTarget(this.select(outcome.targets, ref.selection, context), ref, context);
  }

  private select(targets: readonly LocatedTarget[], policy: SelectionPolicy = { kind: 'best' }, context: LocatorContext): LocatedTarget {
    if (policy.kind === 'first') return targets[0];
    if (policy.kind === 'last') return targets[targets.length - 1];
    if (policy.kind === 'index') {
      if (!Number.isSafeInteger(policy.index) || policy.index < 0 || policy.index >= targets.length) {
        throw new AutomationLocatorError('TARGET_SELECTION_INVALID', `target index is out of range: ${policy.index}`);
      }
      return targets[policy.index];
    }
    if (policy.kind === 'nearest') {
      const target = resolvePersistedPoint(policy.to, context);
      return targets.reduce((best, candidate) => distanceSquared(candidate.activationPoint, target) < distanceSquared(best.activationPoint, target) ? candidate : best);
    }
    return targets.reduce((best, candidate) => (candidate.confidence ?? 1) > (best.confidence ?? 1) ? candidate : best);
  }
}

export class CoordinateLocatorResolver implements LocatorResolver<CoordinateLocator> {
  readonly kind = 'coordinate' as const;

  async locate(locator: CoordinateLocator, _request: LocateRequest, context: LocatorContext): Promise<LocateOutcome> {
    const activationPoint = resolvePersistedPoint(locator.point, context);
    return {
      status: 'matched',
      targets: [locatedTarget({
        space: activationPoint.space,
        activationPoint,
        locatorFingerprint: `coordinate:${locator.point.unit}:${locator.point.x},${locator.point.y}`,
        resolvedAt: context.now(),
      })],
    };
  }
}

export class FirstOfLocatorResolver implements LocatorResolver<FirstOfLocator> {
  readonly kind = 'firstOf' as const;
  private readonly registry: AutomationLocatorRegistry;

  constructor(registry: AutomationLocatorRegistry) { this.registry = registry; }

  async locate(locator: FirstOfLocator, request: LocateRequest, context: LocatorContext): Promise<LocateOutcome> {
    if (locator.locators.length === 0) throw new AutomationLocatorError('LOCATOR_INVALID', 'firstOf requires at least one locator');
    for (const candidate of locator.locators) {
      const result = await this.registry.locate({ ...request, locator: candidate }, context);
      if (result.status === 'matched' && result.targets.length > 0) return result;
    }
    return { status: 'not-found', reason: 'none of the fallback locators matched' };
  }
}

export type RecognitionCandidate = {
  readonly space: SpaceRef;
  readonly bounds: Region<'logical'>;
  readonly confidence: number;
  readonly frameId?: FrameId;
  readonly evidence?: EvidenceRef;
  readonly fingerprint: string;
};

export interface LocatorRecognitionPort {
  locateImage(locator: ImageLocator, context: LocatorContext): Promise<readonly RecognitionCandidate[]>;
  locateText(locator: TextLocator, context: LocatorContext): Promise<readonly RecognitionCandidate[]>;
}

function candidateTarget(candidate: RecognitionCandidate, now: number): LocatedTarget {
  assertCurrentSpace(candidate.bounds.space, candidate.space);
  const activationPoint = point('logical', candidate.space,
    candidate.bounds.x + candidate.bounds.width / 2,
    candidate.bounds.y + candidate.bounds.height / 2);
  if (!regionContainsPoint(candidate.bounds, activationPoint)) throw new AutomationGeometryError('INVALID_POINT', 'candidate center is outside its bounds');
  return locatedTarget({
    space: candidate.space,
    activationPoint,
    bounds: candidate.bounds,
    confidence: candidate.confidence,
    frameId: candidate.frameId,
    evidence: candidate.evidence,
    locatorFingerprint: candidate.fingerprint,
    resolvedAt: now,
  });
}

export class ImageLocatorResolver implements LocatorResolver<ImageLocator> {
  readonly kind = 'image' as const;
  constructor(private readonly port: LocatorRecognitionPort) {}
  async locate(locator: ImageLocator, _request: LocateRequest, context: LocatorContext): Promise<LocateOutcome> {
    const candidates = await this.port.locateImage(locator, context);
    return candidates.length ? { status: 'matched', targets: candidates.map((item) => candidateTarget(item, context.now())) }
      : { status: 'not-found', reason: `image not found: ${locator.asset}` };
  }
}

export class TextLocatorResolver implements LocatorResolver<TextLocator> {
  readonly kind = 'text' as const;
  constructor(private readonly port: LocatorRecognitionPort) {}
  async locate(locator: TextLocator, _request: LocateRequest, context: LocatorContext): Promise<LocateOutcome> {
    const candidates = await this.port.locateText(locator, context);
    return candidates.length ? { status: 'matched', targets: candidates.map((item) => candidateTarget(item, context.now())) }
      : { status: 'not-found', reason: `text not found: ${locator.text}` };
  }
}
