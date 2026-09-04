export const OPTIONAL_MODULES: readonly string[];
export const ALL_MODULES: readonly string[];
export function parseModules(raw?: string): Set<string>;
export function moduleDefines(modules: ReadonlySet<string>): Record<string, string>;
export function moduleSummary(modules: ReadonlySet<string>): string;
