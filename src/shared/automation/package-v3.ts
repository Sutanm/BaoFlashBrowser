import type { WorkflowDocumentV3 } from './core/workflow-ir';
import type { JavaScriptAutomationCapability } from './javascript-api';

export type AutomationV3ScriptEntry = {
  readonly id: string;
  readonly name: string;
  readonly path: `scripts/${string}.${'js' | 'ts'}`;
  readonly language?: 'javascript' | 'typescript';
  readonly permissions: readonly JavaScriptAutomationCapability[];
};

/**
 * 包可显式声明的运行预算。缺省的字段一律沿用平台默认值
 * （10,000 次调用 / 30 分钟），所以旧包的行为不变。
 *
 * 长期挂机脚本（例如一次跑 24 小时）需要在这里声明，否则会被默认预算截断。
 * 声明值受 {@link AUTOMATION_BUDGET_CEILING} 约束，超过上限的包在导入时直接拒绝，
 * 避免「一个包把沙箱变成无限制执行器」。
 */
export type AutomationBudgetV3 = {
  /** 单次脚本运行的 API 调用上限（默认 10,000）。 */
  readonly maxCalls?: number;
  /** 单次运行的墙钟上限，毫秒（默认 30 分钟）。工作流与脚本共用。 */
  readonly maxWallTimeMs?: number;
  /** 单次工作流运行最多执行的节点数（默认 100,000）。 */
  readonly maxExecutedNodes?: number;
  /** 单次工作流运行中单个循环的最大迭代次数（默认 10,000）。 */
  readonly maxLoopIterations?: number;
};

/** 包声明预算的硬上限：写再大也只按这个值生效（实际是导入时拒绝）。 */
export const AUTOMATION_BUDGET_CEILING: Readonly<Required<AutomationBudgetV3>> = Object.freeze({
  maxCalls: 20_000_000,
  maxWallTimeMs: 7 * 24 * 60 * 60 * 1000,
  maxExecutedNodes: 20_000_000,
  maxLoopIterations: 20_000_000,
});

export type AutomationAssetMetadataV3 = {
  readonly source: 'capture';
  readonly reference: {
    readonly kind: 'viewport' | 'region' | 'surface';
    readonly width: number;
    readonly height: number;
    /** BrowserView display/logical transform at capture time. Absent on legacy assets. */
    readonly viewportTransform?: {
      readonly scaleX: number;
      readonly scaleY: number;
    };
  };
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
  /** 可选：包声明的运行预算，缺省字段用平台默认值。 */
  readonly limits?: AutomationBudgetV3;
  /** Optional because externally imported and early v3 assets have no reliable capture reference. */
  readonly assetMetadata?: Readonly<Record<string, AutomationAssetMetadataV3>>;
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
