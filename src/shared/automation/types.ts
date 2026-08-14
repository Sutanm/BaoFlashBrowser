export type AutomationRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ImageCondition = {
  type: 'image-visible';
  asset: string;
  threshold?: number;
  region?: AutomationRegion;
  scales?: number[];
  mask?: 'none' | 'alpha';
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

export type AutomationCondition = ImageCondition | AllCondition | AnyCondition | NotCondition;

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
  threshold?: number;
  timeoutMs?: number;
  pollMs?: number;
  region?: AutomationRegion;
  scales?: number[];
  mask?: 'none' | 'alpha';
};

export type WaitImageStateStep = {
  id?: string;
  type: 'wait-image-state';
  asset: string;
  state: 'visible' | 'hidden';
  threshold?: number;
  timeoutMs?: number;
  pollMs?: number;
  region?: AutomationRegion;
  scales?: number[];
  mask?: 'none' | 'alpha';
};

export type ClickImageStep = {
  id?: string;
  type: 'click-image';
  asset: string;
  threshold?: number;
  timeoutMs?: number;
  pollMs?: number;
  region?: AutomationRegion;
  scales?: number[];
  mask?: 'none' | 'alpha';
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  offset?: { x: number; y: number };
  verifyBeforeClick?: boolean;
  maxMovementPx?: number;
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
  state: 'visible' | 'hidden';
  threshold?: number;
  timeoutMs?: number;
  pollMs?: number;
  region?: AutomationRegion;
  scales?: number[];
  mask?: 'none' | 'alpha';
};

export type MoveToImageStep = {
  id?: string;
  type: 'move-to-image';
  asset: string;
  threshold?: number;
  timeoutMs?: number;
  pollMs?: number;
  region?: AutomationRegion;
  scales?: number[];
  mask?: 'none' | 'alpha';
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

export type IfImageStep = {
  id?: string;
  type: 'if-image';
  condition: ImageCondition;
  negate?: boolean;
  then: SequenceStep;
  else?: SequenceStep;
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
  pollMs?: number;
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

export type AutomationStep =
  | SequenceStep
  | DelayStep
  | WaitImageStep
  | WaitImageStateStep
  | ClickImageStep
  | KeyPressStep
  | KeyHoldUntilImageStep
  | MoveToImageStep
  | TextInputStep
  | ScrollStep
  | NavigateStep
  | ReloadStep
  | LogStep
  | IfImageStep
  | IfConditionStep
  | WaitConditionStep
  | RepeatStep
  | RepeatUntilImageStep
  | RepeatUntilConditionStep;

export type AutomationWorkflow = {
  formatVersion: 1;
  id: string;
  name: string;
  description?: string;
  readyWhen?: AutomationCondition;
  root: SequenceStep;
};

export type AutomationPackageManifest = {
  format: 'baoauto';
  formatVersion: 1;
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
  | 'alpha-mask'
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
  | { key: 'status.imageMatch'; params: { asset: string; score: string; ms: string } }
  | { key: 'status.pausedNext'; params: { step: AutomationMessage } }
  | { key: 'step.sequence' }
  | { key: 'step.waitImage'; params: { asset: string } }
  | { key: 'step.waitImageState'; params: { asset: string; state: 'visible' | 'hidden' } }
  | { key: 'step.clickImage'; params: { asset: string } }
  | { key: 'step.moveToImage'; params: { asset: string } }
  | { key: 'step.delay'; params: { ms: number } }
  | { key: 'step.keyPress'; params: { key: string } }
  | { key: 'step.keyHoldUntilImage'; params: { key: string; state: 'visible' | 'hidden'; asset: string } }
  | { key: 'step.textInput' }
  | { key: 'step.scroll' }
  | { key: 'step.navigate' }
  | { key: 'step.reload' }
  | { key: 'step.log'; params: { message: string } }
  | { key: 'step.ifImage'; params: { asset: string } }
  | { key: 'step.ifCondition' }
  | { key: 'step.waitCondition' }
  | { key: 'step.repeat'; params: { times: number } }
  | { key: 'step.repeatUntilImage'; params: { asset: string } }
  | { key: 'step.repeatUntilCondition' }
  | { key: 'raw'; params: { text: string } };
