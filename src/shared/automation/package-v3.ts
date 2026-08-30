import type { WorkflowDocumentV3 } from './core/workflow-ir';
import type { JavaScriptAutomationCapability } from './javascript-api';

export type AutomationV3ScriptEntry = {
  readonly id: string;
  readonly name: string;
  readonly path: `scripts/${string}.${'js' | 'ts'}`;
  readonly language?: 'javascript' | 'typescript';
  readonly permissions: readonly JavaScriptAutomationCapability[];
};

export type AutomationPackageManifestV3 = {
  readonly format: 'baoauto';
  readonly formatVersion: 3;
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly frontends: {
    readonly workflow?: 'workflow.json';
    readonly scripts: readonly AutomationV3ScriptEntry[];
    readonly mainEntryId?: 'workflow' | string;
  };
  readonly features: readonly ('workflow' | 'javascript' | 'assets' | 'profiles')[];
  readonly integrity: Readonly<Record<string, string>>;
};

export type AutomationProfileV3 = {
  readonly id: string;
  readonly name: string;
  readonly entryId: 'workflow' | string;
  readonly variables?: Readonly<Record<string, null | boolean | number | string>>;
  readonly surfaces?: Readonly<Record<string, unknown>>;
};

export type AutomationPackageV3 = {
  readonly manifest: AutomationPackageManifestV3;
  readonly workflow?: WorkflowDocumentV3;
  readonly scripts: ReadonlyMap<string, string>;
  readonly assets: ReadonlyMap<string, Uint8Array>;
  readonly profiles: ReadonlyMap<string, AutomationProfileV3>;
};

export type AutomationFrontendEntryV3 =
  | { readonly id: 'workflow'; readonly kind: 'blockly'; readonly name: string }
  | { readonly id: string; readonly kind: 'javascript'; readonly name: string; readonly path: string; readonly permissions: readonly JavaScriptAutomationCapability[] };

export function listAutomationFrontendEntries(source: AutomationPackageV3): readonly AutomationFrontendEntryV3[] {
  return Object.freeze([
    ...(source.workflow ? [{ id: 'workflow' as const, kind: 'blockly' as const, name: source.workflow.name }] : []),
    ...source.manifest.frontends.scripts.map((script) => ({ id: script.id, kind: 'javascript' as const, name: script.name, path: script.path, permissions: script.permissions })),
  ]);
}

export function automationMainEntryId(source: AutomationPackageV3): string {
  return source.manifest.frontends.mainEntryId ?? (source.workflow ? 'workflow' : source.manifest.frontends.scripts[0]?.id ?? '');
}
