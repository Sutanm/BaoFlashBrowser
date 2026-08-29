export type AutomationRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type AutomationImageMask = 'auto' | 'none' | 'alpha';

export type AutomationCoordinate = {
  x: number;
  y: number;
};

export type AutomationRelativeRegion = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type ImageCondition = {
  type: 'image-visible';
  asset: string;
  alternatives?: string[];
  threshold?: number;
  region?: AutomationRegion;
  scales?: number[];
  mask?: AutomationImageMask;
};

export type AutomationTextMatchMode = 'contains' | 'exact';

export type TextCondition = {
  type: 'text-visible';
  text: string;
  match?: AutomationTextMatchMode;
  minScore?: number;
  region?: AutomationRegion;
};

export type AllCondition = {
  type: 'all';
  conditions: AutomationCondition[];
};

export type AnyCondition = {
  type: 'any';
  conditions: AutomationCondition[];
};

export type NotCondition = {
  type: 'not';
  condition: AutomationCondition;
};

export type PositionCompareTarget =
  | { kind: 'coordinate'; coordinate: AutomationCoordinate }
  | { kind: 'image'; asset: string; alternatives?: string[]; threshold?: number; region?: AutomationRegion; scales?: number[]; mask?: AutomationImageMask; offset?: { x: number; y: number } };

export type PositionRelation = 'vertical' | 'horizontal' | 'overlap';

export type PositionRelationCondition = {
  type: 'position-relation';
  targetA: PositionCompareTarget;
  targetB: PositionCompareTarget;
  relation: PositionRelation;
  tolerancePx: number;
};

export type AutomationCondition = ImageCondition | TextCondition | AllCondition | AnyCondition | NotCondition | PositionRelationCondition;

export type SequenceStep = {
  id?: string;
  type: 'sequence';
  steps: AutomationStep[];
};

export type DelayStep = {
  id?: string;
  type: 'delay';
  durationMs: number;
};

export type WaitImageStep = {
  id?: string;
  type: 'wait-image';
  asset: string;
  alternatives?: string[];
  threshold?: number;
  timeoutMs?: number;
  minCycleMs?: number;
  region?: AutomationRegion;
  scales?: number[];
  mask?: AutomationImageMask;
};

export type WaitImageStateStep = {
  id?: string;
  type: 'wait-image-state';
  asset: string;
  alternatives?: string[];
  state: 'visible' | 'hidden';
  threshold?: number;
  timeoutMs?: number;
  minCycleMs?: number;
  region?: AutomationRegion;
  scales?: number[];
  mask?: AutomationImageMask;
};

export type ClickImageStep = {
  id?: string;
  type: 'click-image';
  asset: string;
  alternatives?: string[];
  threshold?: number;
  timeoutMs?: number;
  minCycleMs?: number;
  region?: AutomationRegion;
  scales?: number[];
  mask?: AutomationImageMask;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  offset?: { x: number; y: number };
  verifyBeforeClick?: boolean;
  maxMovementPx?: number;
};

export type ClickCoordinateStep = {
  id?: string;
  type: 'click-coordinate';
  coordinate: AutomationCoordinate;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
};

export type RandomClickRegionStep = {
  id?: string;
  type: 'random-click-region';
  region: AutomationRelativeRegion;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  padding?: number;
};

export type WaitTextStateStep = {
  id?: string;
  type: 'wait-text-state';
  text: string;
  match?: AutomationTextMatchMode;
  state: 'visible' | 'hidden';
  minScore?: number;
  timeoutMs?: number;
  minCycleMs?: number;
  region?: AutomationRegion;
};

export type ClickTextStep = {
  id?: string;
  type: 'click-text';
  text: string;
  match?: AutomationTextMatchMode;
  minScore?: number;
  timeoutMs?: number;
  minCycleMs?: number;
  region?: AutomationRegion;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  offset?: { x: number; y: number };
};

export type AutomationViewport = {
  mode: 'fixed';
  width: 1280;
  height: 720;
};

export const DEFAULT_AUTOMATION_VIEWPORT: AutomationViewport = Object.freeze({
  mode: 'fixed',
  width: 1280,
  height: 720,
});

export type VisionRegionStep = {
  id?: string;
  type: 'vision-region';
  region: AutomationRelativeRegion;
  body: SequenceStep;
};

export type AutomationCoordinateSpace = 'page' | 'game';

export type AutomationGameSurfaceLocator = {
  version: 1;
  kind: 'flash' | 'ruffle' | 'canvas' | 'frame';
  label: string;
  source: string;
  frameUrl: string;
  width: number;
  height: number;
};

export type CoordinateSpaceStep = {
  id?: string;
  type: 'coordinate-space';
  space: AutomationCoordinateSpace;
  body: SequenceStep;
};

export type KeyPressStep = {
  id?: string;
  type: 'key-press';
  key: string;
  modifiers?: Array<'alt' | 'control' | 'meta' | 'shift'>;
};

export type KeyHoldUntilImageStep = {
  id?: string;
  type: 'key-hold-until-image';
  key: string;
  modifiers?: Array<'alt' | 'control' | 'meta' | 'shift'>;
  asset: string;
  alternatives?: string[];
  state: 'visible' | 'hidden';
  threshold?: number;
  timeoutMs?: number;
  minCycleMs?: number;
  region?: AutomationRegion;
  scales?: number[];
  mask?: AutomationImageMask;
};

export type MoveToImageStep = {
  id?: string;
  type: 'move-to-image';
  asset: string;
  alternatives?: string[];
  threshold?: number;
  timeoutMs?: number;
  minCycleMs?: number;
  region?: AutomationRegion;
  scales?: number[];
  mask?: AutomationImageMask;
  offset?: { x: number; y: number };
};

export type TextInputStep = {
  id?: string;
  type: 'text-input';
  text: string;
  intervalMs?: number;
};

export type ScrollStep = {
  id?: string;
  type: 'scroll';
  deltaX: number;
  deltaY: number;
};

export type NavigateStep = {
  id?: string;
  type: 'navigate';
  url: string;
};

export type ReloadStep = {
  id?: string;
  type: 'reload';
};

export type LogStep = {
  id?: string;
  type: 'log';
  message: string;
};

export type NotificationStep = {
  id?: string;
  type: 'notification';
  title: string;
  body: string;
};

export type IfImageStep = {
  id?: string;
  type: 'if-image';
  condition: ImageCondition;
  negate?: boolean;
  then: SequenceStep;
  else?: SequenceStep;
};

export type MoveToCoordinateStep = {
  id?: string;
  type: 'move-to-coordinate';
  coordinate: AutomationCoordinate;
};

export type DragImageStep = {
  id?: string;
  type: 'drag-image';
  source: ImageCondition;
  target: ImageCondition;
  timeoutMs?: number;
  minCycleMs?: number;
  button?: 'left' | 'right' | 'middle';
  durationMs?: number;
};

export type AutomationPointerTarget =
  | { kind: 'coordinate'; coordinate: AutomationCoordinate }
  | { kind: 'image'; condition: ImageCondition };

export type DragStep = {
  id?: string;
  type: 'drag';
  source: AutomationPointerTarget;
  target: AutomationPointerTarget;
  timeoutMs?: number;
  minCycleMs?: number;
  button?: 'left' | 'right' | 'middle';
  durationMs?: number;
};

export type IfConditionStep = {
  id?: string;
  type: 'if-condition';
  condition: AutomationCondition;
  then: SequenceStep;
  else?: SequenceStep;
};

export type WaitConditionStep = {
  id?: string;
  type: 'wait-condition';
  condition: AutomationCondition;
  timeoutMs?: number;
  minCycleMs?: number;
};

export type WaitConditionBranchStep = {
  id?: string;
  type: 'wait-condition-branch';
  condition: AutomationCondition;
  timeoutMs?: number;
  minCycleMs?: number;
  success: SequenceStep;
  timeout: SequenceStep;
};

export type EndStep = {
  id?: string;
  type: 'end';
  result: 'success' | 'failure';
  message?: string;
};

export type RepeatUntilConditionStep = {
  id?: string;
  type: 'repeat-until-condition';
  condition: AutomationCondition;
  maxIterations: number;
  delayMs?: number;
  body: SequenceStep;
};

export type RepeatUntilImageStep = {
  id?: string;
  type: 'repeat-until-image';
  condition: ImageCondition;
  until: 'visible' | 'hidden';
  maxIterations: number;
  delayMs?: number;
  body: SequenceStep;
};

export type RepeatStep = {
  id?: string;
  type: 'repeat';
  times: number;
  body: SequenceStep;
};

export type ForeverStep = {
  id?: string;
  type: 'forever';
  body: SequenceStep;
};

export type BreakStep = {
  id?: string;
  type: 'break';
};

export type PositionCompareStep = {
  id?: string;
  type: 'position-compare';
  targetA: PositionCompareTarget;
  targetB: PositionCompareTarget;
  relation: PositionRelation;
  tolerancePx: number;
  then: SequenceStep;
  else?: SequenceStep;
};

export type AutomationStep =
  | SequenceStep
  | DelayStep
  | WaitImageStep
  | WaitImageStateStep
  | ClickImageStep
  | ClickCoordinateStep
  | WaitTextStateStep
  | ClickTextStep
  | RandomClickRegionStep
  | VisionRegionStep
  | CoordinateSpaceStep
  | KeyPressStep
  | KeyHoldUntilImageStep
  | MoveToImageStep
  | MoveToCoordinateStep
  | DragImageStep
  | DragStep
  | TextInputStep
  | ScrollStep
  | NavigateStep
  | ReloadStep
  | LogStep
  | NotificationStep
  | IfImageStep
  | IfConditionStep
  | WaitConditionStep
  | WaitConditionBranchStep
  | EndStep
  | RepeatStep
  | ForeverStep
  | BreakStep
  | RepeatUntilImageStep
  | RepeatUntilConditionStep
  | PositionCompareStep;

export type AutomationWorkflow = {
  formatVersion: 2;
  viewport: AutomationViewport;
  id: string;
  name: string;
  description?: string;
  coordinateSpace?: AutomationCoordinateSpace;
  gameSurface?: AutomationGameSurfaceLocator;
  gameSurfaceTimeoutMs?: number;
  searchRegion?: AutomationRelativeRegion;
  readyWhen?: AutomationCondition;
  root: SequenceStep;
};

export type AutomationPackageManifest = {
  format: 'baoauto';
  formatVersion: 2;
  id: string;
  name: string;
  workflow: 'workflow.json';
  assets: 'assets/';
  createdBy?: string;
  minimumAppVersion?: string;
  capabilities?: AutomationCapability[];
};

export type AutomationCapability =
  | 'vision'
  | 'ocr'
  | 'alpha-mask'
  | 'image-groups'
  | 'multi-scale'
  | 'trusted-input'
  | 'navigation'
  | 'combined-conditions';

export type AutomationAsset = {
  id: string;
  absolutePath: string;
  bytes: number;
  extension: '.png' | '.jpg' | '.jpeg' | '.webp';
};

export type AutomationMessage =
  | { key: 'status.checkingAsset'; params: { asset: string } }
  | { key: 'status.assetMatch'; params: { score: string } }
  | { key: 'status.assetNoMatch'; params: { asset: string } }
  | { key: 'status.readyCheckFailed'; params: { detail: string } }
  | { key: 'status.runFailed'; params: { detail: string } }
  | { key: 'status.assetTestStopped'; params: { detail: string } }
  | { key: 'status.assetTestFailed'; params: { detail: string } }
  | { key: 'status.stepNext' }
  | { key: 'status.scriptCompleted' }
  | { key: 'status.scriptStopped' }
  | { key: 'status.imageMatch'; params: { asset: string; score: string; totalMs: string; captureMs: string; matchMs: string } }
  | { key: 'status.textMatch'; params: { text: string; score: string; totalMs: string; captureMs: string } }
  | { key: 'status.randomClickCoordinate'; params: { x: number; y: number } }
  | { key: 'status.pausedNext'; params: { step: AutomationMessage } }
  | { key: 'step.sequence' }
  | { key: 'step.waitImage'; params: { asset: string } }
  | { key: 'step.waitImageState'; params: { asset: string; state: 'visible' | 'hidden' } }
  | { key: 'step.clickImage'; params: { asset: string } }
  | { key: 'step.clickCoordinate'; params: { x: number; y: number } }
  | { key: 'step.waitTextState'; params: { text: string; state: 'visible' | 'hidden' } }
  | { key: 'step.clickText'; params: { text: string } }
  | { key: 'step.randomClickRegion' }
  | { key: 'step.visionRegion'; params: AutomationRelativeRegion }
  | { key: 'step.coordinateSpace'; params: { space: string } }
  | { key: 'step.moveToImage'; params: { asset: string } }
  | { key: 'step.moveToCoordinate'; params: { x: number; y: number } }
  | { key: 'step.dragImage'; params: { source: string; target: string } }
  | { key: 'step.drag' }
  | { key: 'step.delay'; params: { ms: number } }
  | { key: 'step.keyPress'; params: { key: string } }
  | { key: 'step.keyHoldUntilImage'; params: { key: string; state: 'visible' | 'hidden'; asset: string } }
  | { key: 'step.textInput' }
  | { key: 'step.scroll' }
  | { key: 'step.navigate' }
  | { key: 'step.reload' }
  | { key: 'step.log'; params: { message: string } }
  | { key: 'step.notification'; params: { title: string } }
  | { key: 'step.ifImage'; params: { asset: string } }
  | { key: 'step.ifCondition' }
  | { key: 'step.waitCondition' }
  | { key: 'step.waitConditionBranch' }
  | { key: 'step.end'; params: { result: 'success' | 'failure'; message: string } }
  | { key: 'step.repeat'; params: { times: number } }
  | { key: 'step.forever' }
  | { key: 'step.breakLoop' }
  | { key: 'step.repeatUntilImage'; params: { asset: string } }
  | { key: 'step.repeatUntilCondition' }
  | { key: 'step.positionCompare'; params: { relation: string } }
  | { key: 'step.positionRelation' }
  | { key: 'raw'; params: { text: string } };
