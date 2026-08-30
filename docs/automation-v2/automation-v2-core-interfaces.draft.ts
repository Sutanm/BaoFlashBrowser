/**
 * Automation 2.0 Core interface draft.
 * DESIGN ARTIFACT ONLY — not included by product TypeScript builds.
 */

export type Brand<T, B extends string> = T & { readonly __brand: B };
export type OperationId = Brand<string, 'OperationId'>;
export type RunId = Brand<string, 'RunId'>;
export type TargetId = Brand<string, 'TargetId'>;
export type SurfaceId = Brand<string, 'SurfaceId'>;
export type FrameId = Brand<string, 'FrameId'>;
export type LocatedTargetId = Brand<string, 'LocatedTargetId'>;
export type AssetId = Brand<string, 'AssetId'>;
export type ProfileSurfaceName = Brand<string, 'ProfileSurfaceName'>;
export type Generation = Brand<number, 'Generation'>;
export type FiniteNumber = Brand<number, 'FiniteNumber'>;
export type TimestampMs = Brand<number, 'TimestampMs'>;

export interface TargetGenerationRef {
  readonly targetId: TargetId;
  readonly targetGeneration: Generation;
  readonly viewportGeneration: Generation;
}

export interface ViewportSpaceRef extends TargetGenerationRef {
  readonly kind: 'viewport';
}

export interface SurfaceSpaceRef extends TargetGenerationRef {
  readonly kind: 'surface';
  readonly surfaceId: SurfaceId;
  readonly surfaceGeneration: Generation;
}

export type SpaceRef = ViewportSpaceRef | SurfaceSpaceRef;
export type GeometryUnit = 'ratio' | 'logical';

export interface Point<U extends GeometryUnit = GeometryUnit> {
  readonly kind: 'point';
  readonly unit: U;
  readonly space: SpaceRef;
  readonly x: FiniteNumber;
  readonly y: FiniteNumber;
}

export interface Vector<U extends GeometryUnit = GeometryUnit> {
  readonly kind: 'vector';
  readonly unit: U;
  readonly space: SpaceRef;
  readonly dx: FiniteNumber;
  readonly dy: FiniteNumber;
}

export interface Region<U extends GeometryUnit = GeometryUnit> {
  readonly kind: 'region';
  readonly unit: U;
  readonly space: SpaceRef;
  readonly x: FiniteNumber;
  readonly y: FiniteNumber;
  readonly width: FiniteNumber;
  readonly height: FiniteNumber;
}

export type PersistedSpaceRef =
  | { readonly kind: 'context' }
  | { readonly kind: 'viewport' }
  | { readonly kind: 'surface'; readonly name: ProfileSurfaceName };

export interface PersistedPoint {
  readonly unit: GeometryUnit;
  readonly space?: PersistedSpaceRef;
  readonly x: number;
  readonly y: number;
}

export interface PersistedRegion {
  readonly unit: GeometryUnit;
  readonly space?: PersistedSpaceRef;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PersistedVector {
  readonly unit: GeometryUnit;
  readonly space?: PersistedSpaceRef;
  readonly dx: number;
  readonly dy: number;
}

export type SurfaceElementHint = 'flash' | 'ruffle' | 'canvas' | 'iframe' | 'container';

export type SurfaceSpec =
  | { readonly kind: 'viewport' }
  | {
      readonly kind: 'element';
      readonly parent?: SurfaceSpec;
      readonly selector?: string;
      readonly framePath?: readonly string[];
      readonly elementHint?: SurfaceElementHint;
      readonly fingerprint?: string;
    }
  | {
      readonly kind: 'visual';
      readonly parent?: SurfaceSpec;
      readonly visualHint: SurfaceElementHint;
      readonly fingerprint?: string;
    }
  | {
      readonly kind: 'region';
      readonly parent: SurfaceSpec;
      readonly region: PersistedRegion;
      readonly overflow?: 'clip' | 'strict';
    }
  | { readonly kind: 'named'; readonly name: ProfileSurfaceName };

export interface AffineTransform2D {
  readonly a: FiniteNumber;
  readonly b: FiniteNumber;
  readonly c: FiniteNumber;
  readonly d: FiniteNumber;
  readonly e: FiniteNumber;
  readonly f: FiniteNumber;
}

export interface ResolvedSurface {
  readonly id: SurfaceId;
  readonly spec: SurfaceSpec;
  readonly space: SurfaceSpaceRef;
  readonly parentSpace: SpaceRef;
  readonly boundsInParent: Region<'logical'>;
  readonly localSize: { readonly width: FiniteNumber; readonly height: FiniteNumber };
  readonly toViewport: AffineTransform2D;
  readonly resolvedAt: TimestampMs;
  readonly evidence?: SurfaceEvidence;
}

export interface SurfaceEvidence {
  readonly resolver: string;
  readonly summary: string;
  readonly fingerprint?: string;
}

export interface CoordinateResolver {
  toLogical(point: Point): Point<'logical'>;
  toLogical(region: Region): Region<'logical'>;
  convert(point: Point, target: SpaceRef): Point<'logical'>;
  convert(region: Region, target: SpaceRef): Region<'logical'>;
  assertCurrent(space: SpaceRef): void;
}

export type ResolutionPolicy =
  | { readonly kind: 'once' }
  | { readonly kind: 'wait'; readonly pollIntervalMs?: number }
  | { readonly kind: 'refresh-if-stale' };

export interface SurfaceResolver {
  resolve(spec: SurfaceSpec, context: ExecutionContext, policy: ResolutionPolicy): Promise<ResolvedSurface>;
}

export interface LocatorSpecMap {
  readonly coordinate: CoordinateLocator;
  readonly image: ImageLocator;
  readonly text: TextLocator;
  readonly firstOf: CompositeLocator;
}

export type LocatorSpec = LocatorSpecMap[keyof LocatorSpecMap];

export interface CoordinateLocator {
  readonly kind: 'coordinate';
  readonly point: PersistedPoint;
}

export interface ImageLocator {
  readonly kind: 'image';
  readonly asset: AssetId;
  readonly threshold: number;
  readonly scales?: readonly number[];
  readonly mask?: 'auto' | 'none' | 'alpha';
  readonly region?: PersistedRegion;
}

export interface TextLocator {
  readonly kind: 'text';
  readonly text: string;
  readonly match: 'exact' | 'contains' | 'normalized';
  readonly minConfidence: number;
  readonly region?: PersistedRegion;
  readonly languageHint?: string;
}

export interface CompositeLocator {
  readonly kind: 'firstOf';
  readonly locators: readonly LocatorSpec[];
}

export type Anchor =
  | 'center'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | { readonly xRatio: number; readonly yRatio: number };

export interface TargetRef {
  readonly locator: LocatorSpec;
  readonly anchor?: Anchor;
  readonly offset?: PersistedVector;
  readonly selection?: SelectionPolicy;
}

export type SelectionPolicy =
  | { readonly kind: 'best' }
  | { readonly kind: 'first' }
  | { readonly kind: 'last' }
  | { readonly kind: 'index'; readonly index: number }
  | { readonly kind: 'nearest'; readonly to: PersistedPoint };

export interface EvidenceRef {
  readonly frameId: FrameId;
  readonly provider: string;
  readonly token: string;
}

export interface LocatedTarget {
  readonly id: LocatedTargetId;
  readonly space: SpaceRef;
  readonly activationPoint: Point<'logical'>;
  readonly bounds?: Region<'logical'>;
  readonly confidence?: number;
  readonly frameId?: FrameId;
  readonly evidence?: EvidenceRef;
  readonly locatorFingerprint: string;
  readonly resolvedAt: TimestampMs;
}

export type LocateOutcome =
  | { readonly status: 'matched'; readonly targets: readonly LocatedTarget[] }
  | { readonly status: 'not-found'; readonly reason: string };

export interface LocateRequest {
  readonly locator: LocatorSpec;
  readonly selection?: SelectionPolicy;
  readonly maxCandidates?: number;
}

export interface LocatorResolver<L extends LocatorSpec = LocatorSpec> {
  readonly kind: L['kind'];
  locate(locator: L, request: LocateRequest, context: ExecutionContext): Promise<LocateOutcome>;
}

export interface LocatorRegistry {
  register<L extends LocatorSpec>(resolver: LocatorResolver<L>): void;
  freeze(): void;
  locate(request: LocateRequest, context: ExecutionContext): Promise<LocateOutcome>;
  resolveTarget(target: TargetRef, context: ExecutionContext): Promise<LocatedTarget>;
}

export type ActionSpec =
  | ClickAction
  | MoveAction
  | DragAction
  | KeyPressAction
  | TextInputAction
  | ScrollAction
  | NavigateAction
  | ReloadAction
  | LogAction
  | NotifyAction;

export interface TargetUsePolicy {
  readonly stale: 'fail' | 'reacquire';
  readonly verifyIfOlderThanMs?: number;
}

export interface ClickAction {
  readonly kind: 'click';
  readonly target: TargetRef;
  readonly button?: 'primary' | 'middle' | 'secondary';
  readonly count?: number;
  readonly modifiers?: readonly ('alt' | 'control' | 'meta' | 'shift')[];
  readonly targetPolicy?: TargetUsePolicy;
}

export interface MoveAction {
  readonly kind: 'move';
  readonly target: TargetRef;
  readonly durationMs?: number;
  readonly targetPolicy?: TargetUsePolicy;
}

export interface DragAction {
  readonly kind: 'drag';
  readonly from: TargetRef;
  readonly to: TargetRef;
  readonly durationMs?: number;
  readonly holdBeforeMs?: number;
  readonly holdAfterMs?: number;
  readonly targetPolicy?: TargetUsePolicy;
}

export interface KeyPressAction {
  readonly kind: 'keyPress';
  readonly key: string;
  readonly modifiers?: readonly string[];
}

export interface TextInputAction {
  readonly kind: 'textInput';
  readonly text: ValueExpression<'string'>;
  readonly intervalMs?: number;
}

export interface ScrollAction {
  readonly kind: 'scroll';
  readonly deltaX: number;
  readonly deltaY: number;
  readonly unit: 'logical';
  readonly target?: TargetRef;
}

export interface NavigateAction { readonly kind: 'navigate'; readonly url: ValueExpression<'string'> }
export interface ReloadAction { readonly kind: 'reload' }
export interface LogAction { readonly kind: 'log'; readonly level: 'debug' | 'info' | 'warn' | 'error'; readonly message: ValueExpression<'string'> }
export interface NotifyAction { readonly kind: 'notify'; readonly title: ValueExpression<'string'>; readonly body?: ValueExpression<'string'> }

export type QuerySpec = FindOneQuery | ExistsQuery | ReadTextQuery | ReadNumberQuery;
export interface FindOneQuery { readonly kind: 'findOne'; readonly target: TargetRef }
export interface ExistsQuery { readonly kind: 'exists'; readonly locator: LocatorSpec }

export type ReadSource =
  | { readonly kind: 'context-region' }
  | { readonly kind: 'region'; readonly region: PersistedRegion }
  | { readonly kind: 'target-bounds'; readonly target: TargetRef };

export interface ReadTextQuery {
  readonly kind: 'readText';
  readonly source: ReadSource;
  readonly languageHint?: string;
  readonly minConfidence?: number;
}

export interface NumberParsePolicy {
  readonly locale?: string;
  readonly decimalSeparator?: '.' | ',';
  readonly groupingSeparator?: ',' | '.' | ' ';
  readonly allowSign?: boolean;
  readonly allowParenthesesNegative?: boolean;
  readonly currency?: readonly string[];
  readonly units?: readonly string[];
  readonly corrections?: Readonly<Record<string, string>>;
  readonly select?: 'first' | 'last' | 'highest-confidence' | 'only';
}

export interface ReadNumberQuery {
  readonly kind: 'readNumber';
  readonly source: ReadSource;
  readonly recognition?: Omit<ReadTextQuery, 'kind' | 'source'>;
  readonly parse: NumberParsePolicy;
}

export interface TextReadValue {
  readonly kind: 'text-read';
  readonly text: string;
  readonly confidence: number;
  readonly frameId: FrameId;
  readonly evidence?: EvidenceRef;
}

export interface NumberReadValue {
  readonly kind: 'number-read';
  readonly value: FiniteNumber;
  readonly sourceText: string;
  readonly confidence: number;
  readonly frameId: FrameId;
  readonly parse: { readonly decimalSeparator?: string; readonly unit?: string; readonly currency?: string };
}

export type CoreValue = null | boolean | FiniteNumber | string | Point | Region | LocatedTarget | TextReadValue | NumberReadValue;
export type ValueType = 'null' | 'boolean' | 'number' | 'string' | 'point' | 'region' | 'located-target' | 'text-read' | 'number-read';

export type ValueExpression<T extends ValueType = ValueType> =
  | { readonly kind: 'literal'; readonly valueType: T; readonly value: unknown }
  | { readonly kind: 'variable'; readonly valueType: T; readonly name: string }
  | { readonly kind: 'unary'; readonly valueType: T; readonly operator: 'not' | 'negate'; readonly operand: ValueExpression }
  | { readonly kind: 'binary'; readonly valueType: T; readonly operator: string; readonly left: ValueExpression; readonly right: ValueExpression }
  | { readonly kind: 'project'; readonly valueType: T; readonly source: ValueExpression; readonly field: string };

export type WorkflowNode =
  | SequenceNode
  | IfNode
  | LoopNode
  | BreakNode
  | ContinueNode
  | WaitNode
  | ActionNode
  | QueryNode
  | LetNode
  | SetNode
  | WithContextNode;

export interface NodeBase { readonly id: string }
export interface SequenceNode extends NodeBase { readonly kind: 'sequence'; readonly nodes: readonly WorkflowNode[] }
export interface IfNode extends NodeBase { readonly kind: 'if'; readonly condition: ValueExpression<'boolean'>; readonly then: WorkflowNode; readonly else?: WorkflowNode }
export interface LoopNode extends NodeBase { readonly kind: 'loop'; readonly mode: 'repeat' | 'while'; readonly count?: ValueExpression<'number'>; readonly condition?: ValueExpression<'boolean'>; readonly body: WorkflowNode }
export interface BreakNode extends NodeBase { readonly kind: 'break' }
export interface ContinueNode extends NodeBase { readonly kind: 'continue' }
export interface WaitNode extends NodeBase { readonly kind: 'wait'; readonly durationMs?: ValueExpression<'number'>; readonly query?: QuerySpec; readonly until?: ValueExpression<'boolean'>; readonly timeoutMs?: number; readonly onTimeout: 'fail' | 'continue' }
export interface ActionNode extends NodeBase { readonly kind: 'action'; readonly action: ActionSpec }
export interface QueryNode extends NodeBase { readonly kind: 'query'; readonly query: QuerySpec; readonly assignTo: string }
export interface LetNode extends NodeBase { readonly kind: 'let'; readonly name: string; readonly valueType: ValueType; readonly value: ValueExpression }
export interface SetNode extends NodeBase { readonly kind: 'set'; readonly name: string; readonly value: ValueExpression }
export interface WithContextNode extends NodeBase { readonly kind: 'with'; readonly surface?: SurfaceSpec; readonly region?: PersistedRegion; readonly timeoutMs?: number; readonly frameReuse?: FrameReusePolicy; readonly body: WorkflowNode }

export interface WorkflowDocumentV3 {
  readonly formatVersion: 3;
  readonly id: string;
  readonly name: string;
  readonly root: WorkflowNode;
}

export interface FrameReusePolicy { readonly mode: 'fresh' | 'reuse-compatible'; readonly maxAgeMs?: number }
export interface ExecutionContext {
  readonly operationId: OperationId;
  readonly runId: RunId;
  readonly target: TargetGenerationRef;
  readonly surface: ResolvedSurface;
  readonly region?: Region<'logical'>;
  readonly deadlineAt: TimestampMs;
  readonly signal: AbortSignal;
  readonly frameReuse: FrameReusePolicy;
  readonly grants: GrantView;
  derive(change: ContextChange): ExecutionContext;
}

export interface ContextChange {
  readonly surface?: ResolvedSurface;
  readonly region?: Region<'logical'>;
  readonly deadlineAt?: TimestampMs;
  readonly frameReuse?: FrameReusePolicy;
}

export interface CaptureRequest {
  readonly surface: ResolvedSurface;
  readonly region: Region<'logical'>;
  readonly output: { readonly scale: number; readonly format: 'bgra8' | 'rgba8' };
  readonly freshness: FrameReusePolicy;
}

export interface FrameTransform {
  readonly frameId: FrameId;
  readonly capturedSpace: SpaceRef;
  readonly bitmapSize: { readonly width: number; readonly height: number };
  readonly capturedRegion: Region<'logical'>;
  bitmapPointToSpace(point: { readonly x: number; readonly y: number }): Point<'logical'>;
  bitmapRegionToSpace(region: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): Region<'logical'>;
  assertCurrent(context: ExecutionContext): void;
}

export interface PixelLease {
  readonly bytes: Uint8Array;
  release(): Promise<void>;
}

export interface CaptureFrame {
  readonly id: FrameId;
  readonly space: SpaceRef;
  readonly capturedAt: TimestampMs;
  readonly sequence: number;
  readonly transform: FrameTransform;
  acquirePixels(): Promise<PixelLease>;
  release(): Promise<void>;
}

export interface CaptureService { capture(request: CaptureRequest, context: ExecutionContext): Promise<CaptureFrame> }

export interface VisionCandidate { readonly score: number; readonly bitmapBounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }; readonly polygon?: readonly { readonly x: number; readonly y: number }[] }
export interface VisionProvider { readonly id: string; match(frame: CaptureFrame, request: ImageLocator, context: ExecutionContext): Promise<readonly VisionCandidate[]>; close(): Promise<void> }
export interface RecognizedTextItem { readonly text: string; readonly confidence: number; readonly polygon: readonly { readonly x: number; readonly y: number }[] }
export interface TextRecognizer { readonly id: string; recognize(frame: CaptureFrame, request: { readonly languageHint?: string }, context: ExecutionContext): Promise<readonly RecognizedTextItem[]>; close(): Promise<void> }

export interface InputService {
  click(target: LocatedTarget, action: ClickAction, context: ExecutionContext): Promise<void>;
  move(target: LocatedTarget, action: MoveAction, context: ExecutionContext): Promise<void>;
  drag(from: LocatedTarget, to: LocatedTarget, action: DragAction, context: ExecutionContext): Promise<void>;
  keyPress(action: KeyPressAction, context: ExecutionContext): Promise<void>;
  textInput(text: string, action: TextInputAction, context: ExecutionContext): Promise<void>;
  scroll(action: ScrollAction, context: ExecutionContext): Promise<void>;
  releaseAll(context: ExecutionContext): Promise<void>;
}

export interface CoreErrorDetails { readonly [key: string]: string | number | boolean | null }
export type CoreErrorCategory = 'validation' | 'target' | 'surface' | 'recognition' | 'input-browser' | 'permission' | 'budget' | 'cancel' | 'internal';
export interface CoreError extends Error { readonly code: string; readonly category: CoreErrorCategory; readonly operationId?: OperationId; readonly nodeId?: string; readonly safeDetails?: CoreErrorDetails }

export type Permission = 'trustedInput' | 'navigation' | 'notifications' | 'clipboardRead' | 'network' | 'fileRead' | 'fileWrite';
export interface GrantView { allows(permission: Permission, scope?: unknown): boolean }

export type RunState = 'created' | 'resolving-target' | 'running' | 'paused' | 'cancelling' | 'completed' | 'cancelled' | 'failed';
export interface RunResult { readonly runId: RunId; readonly state: 'completed' | 'cancelled' | 'failed'; readonly error?: CoreError }
export interface RunEvent { readonly runId: RunId; readonly type: string; readonly at: TimestampMs; readonly nodeId?: string; readonly payload?: Readonly<Record<string, unknown>> }
export interface RunHandle { readonly id: RunId; readonly owner: string; readonly state: RunState; readonly completion: Promise<RunResult>; cancel(reason?: string): Promise<RunResult>; events(listener: (event: RunEvent) => void): () => void }

export interface RuntimeHost {
  start(workflow: WorkflowDocumentV3, options: { readonly owner: string; readonly targetId: TargetId; readonly grant: GrantView }): Promise<RunHandle>;
  shutdown(): Promise<void>;
}

export interface PackageManifestV3 {
  readonly formatVersion: 3;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly coreVersion: string;
  readonly defaultEntrypoint: string;
  readonly entrypoints: Readonly<Record<string, { readonly kind: 'workflow' | 'javascript'; readonly path: string }>>;
  readonly features: readonly ('workflow' | 'javascript' | 'vision' | 'ocr')[];
  readonly permissions: readonly Permission[];
  readonly assetsRoot: 'assets/';
  readonly profilesRoot: 'profiles/';
}
