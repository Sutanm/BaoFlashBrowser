import {
  AutomationLocatorRegistry,
  type LocatedTarget,
  type LocatorContext,
  type LocatorSpec,
  type TargetRef,
  withObservationScope,
} from './locator';

export type WaitLocatorPolicy = {
  readonly state: 'visible' | 'hidden';
  readonly timeoutMs: number;
  readonly pollIntervalMs?: number;
};

export type WaitLocatorContext = LocatorContext & {
  readonly sleep: (durationMs: number, signal: AbortSignal) => Promise<void>;
};

export class AutomationLocatorQueries {
  constructor(private readonly registry: AutomationLocatorRegistry) {}

  find(target: TargetRef, context: LocatorContext): Promise<LocatedTarget> {
    return this.registry.resolveTarget(target, context);
  }

  async exists(locator: LocatorSpec, context: LocatorContext): Promise<boolean> {
    const outcome = await this.registry.locate({ locator, maxCandidates: 1 }, withObservationScope({ ...context, observationScope: undefined }));
    return outcome.status === 'matched' && outcome.targets.length > 0;
  }

  async wait(locator: LocatorSpec, policy: WaitLocatorPolicy, context: WaitLocatorContext): Promise<LocatedTarget | null> {
    if (!Number.isFinite(policy.timeoutMs) || policy.timeoutMs < 0) throw new Error('wait timeout must be non-negative and finite');
    const pollIntervalMs = policy.pollIntervalMs ?? 100;
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) throw new Error('wait poll interval must be non-negative and finite');
    const deadline = context.now() + policy.timeoutMs;
    for (;;) {
      if (context.signal.aborted) throw new Error('automation cancelled');
      const outcome = await this.registry.locate({ locator, maxCandidates: 1 }, withObservationScope({ ...context, observationScope: undefined }));
      const target = outcome.status === 'matched' ? outcome.targets[0] : undefined;
      if (policy.state === 'visible' && target) return target;
      if (policy.state === 'hidden' && !target) return null;
      const remaining = deadline - context.now();
      if (remaining <= 0) throw new Error(`locator wait timed out after ${policy.timeoutMs}ms`);
      await context.sleep(Math.min(pollIntervalMs, remaining), context.signal);
    }
  }
}
