import type { LocatedTarget, LocatorContext, TargetRef } from './locator';
import { AutomationLocatorRegistry } from './locator';

export type ClickAction = {
  readonly kind: 'click';
  readonly target: TargetRef;
  readonly button?: 'primary' | 'middle' | 'secondary';
  readonly count?: number;
};

export type MoveAction = {
  readonly kind: 'move';
  readonly target: TargetRef;
  readonly durationMs?: number;
};

export type DragAction = {
  readonly kind: 'drag';
  readonly from: TargetRef;
  readonly to: TargetRef;
  readonly button?: 'primary' | 'middle' | 'secondary';
  readonly durationMs?: number;
  readonly holdBeforeMs?: number;
  readonly holdAfterMs?: number;
};

export type KeyPressAction = { readonly kind: 'keyPress'; readonly key: string; readonly modifiers?: readonly ('alt' | 'control' | 'meta' | 'shift')[] };
export type TypeTextAction = { readonly kind: 'typeText'; readonly text: string; readonly intervalMs?: number };
export type ScrollAction = { readonly kind: 'scroll'; readonly deltaX: number; readonly deltaY: number };
export type NavigateAction = { readonly kind: 'navigate'; readonly url: string };
export type ReloadAction = { readonly kind: 'reload' };
export type LogAction = { readonly kind: 'log'; readonly message: string };
export type NotifyAction = { readonly kind: 'notify'; readonly title: string; readonly body?: string };

export interface ActionSpecMap {
  readonly click: ClickAction;
  readonly move: MoveAction;
  readonly drag: DragAction;
  readonly keyPress: KeyPressAction;
  readonly typeText: TypeTextAction;
  readonly scroll: ScrollAction;
  readonly navigate: NavigateAction;
  readonly reload: ReloadAction;
  readonly log: LogAction;
  readonly notify: NotifyAction;
}

export type ActionSpec = ActionSpecMap[keyof ActionSpecMap];
export type ActionContext = LocatorContext;

export interface LocatedTargetInputPort {
  click(target: LocatedTarget, action: ClickAction, context: ActionContext): Promise<void>;
  move(target: LocatedTarget, action: MoveAction, context: ActionContext): Promise<void>;
  drag(from: LocatedTarget, to: LocatedTarget, action: DragAction, context: ActionContext): Promise<void>;
}

export interface AutomationUtilityActionPort {
  keyPress(key: string, modifiers: readonly ('alt' | 'control' | 'meta' | 'shift')[], context: ActionContext): Promise<void>;
  typeText(text: string, intervalMs: number, context: ActionContext): Promise<void>;
  scroll(deltaX: number, deltaY: number, context: ActionContext): Promise<void>;
  navigate(url: string, context: ActionContext): Promise<void>;
  reload(context: ActionContext): Promise<void>;
  log(message: string, context: ActionContext): Promise<void>;
  notify(title: string, body: string | undefined, context: ActionContext): Promise<void>;
}

export interface ActionExecutor<A extends ActionSpec = ActionSpec> {
  readonly kind: A['kind'];
  execute(action: A, context: ActionContext): Promise<void>;
}

export type ActionErrorCode = 'ACTION_NOT_REGISTERED' | 'ACTION_REGISTRY_FROZEN' | 'ACTION_DUPLICATE' | 'ACTION_INVALID';

export class AutomationActionError extends Error {
  readonly code: ActionErrorCode;
  constructor(code: ActionErrorCode, message: string) {
    super(message);
    this.name = 'AutomationActionError';
    this.code = code;
  }
}

abstract class PointerActionExecutor {
  protected readonly locators: AutomationLocatorRegistry;
  protected readonly input: LocatedTargetInputPort;

  constructor(locators: AutomationLocatorRegistry, input: LocatedTargetInputPort) {
    this.locators = locators;
    this.input = input;
  }

  protected assertCurrent(target: LocatedTarget, context: ActionContext): void {
    context.coordinateResolver.assertSpaceCurrent(target.space);
  }
}

export class ClickActionExecutor extends PointerActionExecutor implements ActionExecutor<ClickAction> {
  readonly kind = 'click' as const;
  async execute(action: ClickAction, context: ActionContext): Promise<void> {
    if (!Number.isSafeInteger(action.count ?? 1) || (action.count ?? 1) < 1 || (action.count ?? 1) > 10) {
      throw new AutomationActionError('ACTION_INVALID', 'click count must be an integer from 1 to 10');
    }
    const target = await this.locators.resolveTarget(action.target, context);
    this.assertCurrent(target, context);
    await this.input.click(target, action, context);
  }
}

export class MoveActionExecutor extends PointerActionExecutor implements ActionExecutor<MoveAction> {
  readonly kind = 'move' as const;
  async execute(action: MoveAction, context: ActionContext): Promise<void> {
    if (action.durationMs !== undefined && (!Number.isFinite(action.durationMs) || action.durationMs < 0)) {
      throw new AutomationActionError('ACTION_INVALID', 'move duration must be non-negative and finite');
    }
    const target = await this.locators.resolveTarget(action.target, context);
    this.assertCurrent(target, context);
    await this.input.move(target, action, context);
  }
}

export class DragActionExecutor extends PointerActionExecutor implements ActionExecutor<DragAction> {
  readonly kind = 'drag' as const;
  async execute(action: DragAction, context: ActionContext): Promise<void> {
    for (const [label, value] of [['duration', action.durationMs], ['holdBefore', action.holdBeforeMs], ['holdAfter', action.holdAfterMs]] as const) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
        throw new AutomationActionError('ACTION_INVALID', `${label} must be non-negative and finite`);
      }
    }
    const from = await this.locators.resolveTarget(action.from, context);
    const to = await this.locators.resolveTarget(action.to, context);
    this.assertCurrent(from, context);
    this.assertCurrent(to, context);
    await this.input.drag(from, to, action, context);
  }
}

export class AutomationActionRegistry {
  private readonly entries = new Map<string, (action: ActionSpec, context: ActionContext) => Promise<void>>();
  private frozen = false;

  register<A extends ActionSpec>(executor: ActionExecutor<A>): void {
    if (this.frozen) throw new AutomationActionError('ACTION_REGISTRY_FROZEN', 'action registry is frozen');
    if (this.entries.has(executor.kind)) throw new AutomationActionError('ACTION_DUPLICATE', `action executor already registered: ${executor.kind}`);
    this.entries.set(executor.kind, (action, context) => executor.execute(action as A, context));
  }

  freeze(): void { this.frozen = true; }
  get isFrozen(): boolean { return this.frozen; }

  async execute(action: ActionSpec, context: ActionContext): Promise<void> {
    if (context.signal.aborted) throw new Error('automation cancelled');
    const executor = this.entries.get(action.kind);
    if (!executor) throw new AutomationActionError('ACTION_NOT_REGISTERED', `action executor is not registered: ${action.kind}`);
    await executor(action, context);
  }
}

export function registerPointerActions(
  actions: AutomationActionRegistry,
  locators: AutomationLocatorRegistry,
  input: LocatedTargetInputPort,
): void {
  actions.register(new ClickActionExecutor(locators, input));
  actions.register(new MoveActionExecutor(locators, input));
  actions.register(new DragActionExecutor(locators, input));
}

export function registerUtilityActions(actions: AutomationActionRegistry, port: AutomationUtilityActionPort): void {
  actions.register<KeyPressAction>({ kind: 'keyPress', execute: (action, context) => port.keyPress(action.key, action.modifiers ?? [], context) });
  actions.register<TypeTextAction>({ kind: 'typeText', execute: (action, context) => port.typeText(action.text, action.intervalMs ?? 0, context) });
  actions.register<ScrollAction>({ kind: 'scroll', execute: (action, context) => port.scroll(action.deltaX, action.deltaY, context) });
  actions.register<NavigateAction>({ kind: 'navigate', execute: (action, context) => port.navigate(action.url, context) });
  actions.register<ReloadAction>({ kind: 'reload', execute: (_action, context) => port.reload(context) });
  actions.register<LogAction>({ kind: 'log', execute: (action, context) => port.log(action.message, context) });
  actions.register<NotifyAction>({ kind: 'notify', execute: (action, context) => port.notify(action.title, action.body, context) });
}
