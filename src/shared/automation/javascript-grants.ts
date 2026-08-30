import type { JavaScriptAutomationCapability } from './javascript-api';

export const JAVASCRIPT_AUTOMATION_CAPABILITIES: readonly JavaScriptAutomationCapability[] = Object.freeze([
  'input', 'vision', 'ocr', 'page.read', 'page.navigate', 'log', 'notify',
]);

export type JavaScriptAutomationManifest = {
  readonly entry: string;
  readonly permissions: readonly JavaScriptAutomationCapability[];
};

export type JavaScriptInstallGrant = {
  readonly packageId: string;
  readonly approved: ReadonlySet<JavaScriptAutomationCapability>;
};

export type JavaScriptRunGrant = {
  readonly packageId: string;
  readonly runId: string;
  readonly capabilities: ReadonlySet<JavaScriptAutomationCapability>;
};

export class JavaScriptGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JavaScriptGrantError';
  }
}

function capabilities(values: readonly string[]): ReadonlySet<JavaScriptAutomationCapability> {
  const allowed = new Set(JAVASCRIPT_AUTOMATION_CAPABILITIES);
  const result = new Set<JavaScriptAutomationCapability>();
  for (const value of values) {
    if (!allowed.has(value as JavaScriptAutomationCapability)) throw new JavaScriptGrantError(`unknown JavaScript automation capability: ${value}`);
    result.add(value as JavaScriptAutomationCapability);
  }
  return new Proxy(result, {
    get(target, property) {
      if (property === 'add' || property === 'delete' || property === 'clear') {
        return () => { throw new JavaScriptGrantError('capability grant is immutable'); };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function validateJavaScriptAutomationManifest(manifest: JavaScriptAutomationManifest): void {
  const segments = manifest.entry.split('/');
  if (!/^[A-Za-z0-9._/-]+$/u.test(manifest.entry) || manifest.entry.includes('\\') || manifest.entry.includes(':')
    || segments.some((segment) => !segment || segment === '.' || segment === '..') || !manifest.entry.endsWith('.js')) {
    throw new JavaScriptGrantError('JavaScript automation entry must be a package-relative .js path');
  }
  capabilities(manifest.permissions);
}

export function createJavaScriptInstallGrant(
  packageId: string,
  manifest: JavaScriptAutomationManifest,
  approved: readonly JavaScriptAutomationCapability[],
): JavaScriptInstallGrant {
  validateJavaScriptAutomationManifest(manifest);
  const requested = capabilities(manifest.permissions);
  const accepted = capabilities(approved);
  for (const capability of accepted) if (!requested.has(capability)) throw new JavaScriptGrantError(`install grant exceeds manifest permissions: ${capability}`);
  return Object.freeze({ packageId, approved: accepted });
}

export function createJavaScriptRunGrant(
  install: JavaScriptInstallGrant,
  runId: string,
  requested: readonly JavaScriptAutomationCapability[],
): JavaScriptRunGrant {
  const selected = capabilities(requested);
  for (const capability of selected) if (!install.approved.has(capability)) throw new JavaScriptGrantError(`run grant exceeds install grant: ${capability}`);
  return Object.freeze({ packageId: install.packageId, runId, capabilities: selected });
}
