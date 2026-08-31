import { withObservationScope, type LocatorContext } from './locator';
import { AutomationLocatorQueries } from './locator-query';
import type { ExistsQuery, FindQuery, ReadNumberQuery, ReadTextQuery, RuntimeQuerySpec, RuntimeValue } from './workflow-ir';

export interface RuntimeQueryExecutor<Q extends RuntimeQuerySpec = RuntimeQuerySpec> {
  readonly kind: Q['kind'];
  execute(query: Q, context: LocatorContext): Promise<RuntimeValue>;
}

export class RuntimeQueryRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeQueryRegistryError';
  }
}

export class AutomationRuntimeQueryRegistry {
  private readonly entries = new Map<string, (query: RuntimeQuerySpec, context: LocatorContext) => Promise<RuntimeValue>>();
  private frozen = false;

  register<Q extends RuntimeQuerySpec>(executor: RuntimeQueryExecutor<Q>): void {
    if (this.frozen) throw new RuntimeQueryRegistryError('query registry is frozen');
    if (this.entries.has(executor.kind)) throw new RuntimeQueryRegistryError(`query executor already registered: ${executor.kind}`);
    this.entries.set(executor.kind, (query, context) => executor.execute(query as Q, context));
  }

  freeze(): void { this.frozen = true; }
  get isFrozen(): boolean { return this.frozen; }

  async execute(query: RuntimeQuerySpec, context: LocatorContext): Promise<RuntimeValue> {
    if (context.signal.aborted) throw new Error('automation cancelled');
    const executor = this.entries.get(query.kind);
    if (!executor) throw new RuntimeQueryRegistryError(`query executor is not registered: ${query.kind}`);
    return executor(query, withObservationScope({ ...context, observationScope: undefined }));
  }
}

export function registerLocatorQueries(registry: AutomationRuntimeQueryRegistry, queries: AutomationLocatorQueries): void {
  registry.register<FindQuery>({ kind: 'find', execute: (query, context) => queries.find(query.target, context) });
  registry.register<ExistsQuery>({ kind: 'exists', execute: (query, context) => queries.exists(query.locator, context) });
}

export interface AutomationTextQueryPort {
  readText(query: ReadTextQuery, context: LocatorContext): Promise<string>;
  readNumber(query: ReadNumberQuery, context: LocatorContext): Promise<number>;
}

export function registerTextQueries(registry: AutomationRuntimeQueryRegistry, port: AutomationTextQueryPort): void {
  registry.register<ReadTextQuery>({ kind: 'readText', execute: (query, context) => port.readText(query, context) });
  registry.register<ReadNumberQuery>({ kind: 'readNumber', execute: (query, context) => port.readNumber(query, context) });
}
