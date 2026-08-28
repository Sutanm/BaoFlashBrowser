import { z } from 'zod';
import { DEFAULT_AUTOMATION_VIEWPORT } from './types';
import type {
  AutomationPackageManifest,
  AutomationCondition,
  AutomationStep,
  AutomationWorkflow,
  AutomationRelativeRegion,
  ImageCondition,
  PositionCompareTarget,
  SequenceStep,
} from './types';

const idSchema = z.string().min(1).max(96).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const assetIdSchema = z.string().min(1).max(240).refine((value) => {
  if (value.includes('\\') || value.startsWith('/') || value.includes('\0')) return false;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}, 'asset path must be a safe relative POSIX path');

const regionSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive().max(16384),
  height: z.number().int().positive().max(16384),
}).strict();

const imageFields = {
  asset: assetIdSchema,
  alternatives: z.array(assetIdSchema).min(1).max(15).refine(
    (values) => new Set(values).size === values.length,
    'image alternatives must be unique',
  ).optional(),
  threshold: z.number().min(0.1).max(1).optional(),
  region: regionSchema.optional(),
  scales: z.array(z.number().min(0.25).max(4)).min(1).max(16).refine(
    (values) => new Set(values).size === values.length,
    'image scales must be unique',
  ).optional(),
  mask: z.enum(['auto', 'none', 'alpha']).optional(),
};

export const imageConditionSchema: z.ZodType<ImageCondition> = z.object({
  type: z.literal('image-visible'),
  ...imageFields,
}).strict();

const coordinateSchema = z.object({
  x: z.number().int().min(0).max(10_000),
  y: z.number().int().min(0).max(10_000),
}).strict();

const positionCompareTargetSchema: z.ZodType<PositionCompareTarget> = z.union([
  z.object({ kind: z.literal('coordinate'), coordinate: coordinateSchema }).strict(),
  z.object({
    kind: z.literal('image'),
    ...imageFields,
    offset: z.object({ x: z.number().int(), y: z.number().int() }).strict().optional(),
  }).strict(),
]);

const relativeRegionSchema = z.object({
  left: z.number().int().min(0).max(9_999),
  top: z.number().int().min(0).max(9_999),
  right: z.number().int().min(1).max(10_000),
  bottom: z.number().int().min(1).max(10_000),
}).strict().refine((value) => value.left < value.right && value.top < value.bottom, 'relative search region must have positive width and height');

const automationViewportSchema = z.object({
  mode: z.literal('fixed'),
  width: z.literal(1280),
  height: z.literal(720),
}).strict();

export const automationConditionSchema: z.ZodType<AutomationCondition, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.union([
    imageConditionSchema,
    z.object({
      type: z.literal('all'),
      conditions: z.array(automationConditionSchema).min(2).max(16),
    }).strict(),
    z.object({
      type: z.literal('any'),
      conditions: z.array(automationConditionSchema).min(2).max(16),
    }).strict(),
    z.object({
      type: z.literal('not'),
      condition: automationConditionSchema,
    }).strict(),
    z.object({
      type: z.literal('position-relation'),
      targetA: positionCompareTargetSchema,
      targetB: positionCompareTargetSchema,
      relation: z.enum(['vertical', 'horizontal', 'overlap']),
      tolerancePx: z.number().int().min(1).max(5000),
    }).strict(),
  ]),
);

const stepId = { id: idSchema.optional() };

export const sequenceStepSchema: z.ZodType<SequenceStep, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({
    ...stepId,
    type: z.literal('sequence'),
    steps: z.array(automationStepSchema).max(1000),
  }).strict(),
);

export const automationStepSchema: z.ZodType<AutomationStep, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.union([
    sequenceStepSchema,
    z.object({
      ...stepId,
      type: z.literal('delay'),
      durationMs: z.number().int().nonnegative().max(3_600_000),
    }).strict(),
    z.object({
      ...stepId,
      type: z.literal('wait-image'),
      ...imageFields,
      timeoutMs: z.number().int().positive().max(3_600_000).optional(),
      minCycleMs: z.number().int().min(0).max(60_000).optional(),
    }).strict(),
    z.object({
      ...stepId,
      type: z.literal('wait-image-state'),
      ...imageFields,
      state: z.enum(['visible', 'hidden']),
      timeoutMs: z.number().int().positive().max(3_600_000).optional(),
      minCycleMs: z.number().int().min(0).max(60_000).optional(),
    }).strict(),
    z.object({
      ...stepId,
      type: z.literal('click-image'),
      ...imageFields,
      timeoutMs: z.number().int().positive().max(3_600_000).optional(),
      minCycleMs: z.number().int().min(0).max(60_000).optional(),
      button: z.enum(['left', 'right', 'middle']).optional(),
      clickCount: z.number().int().min(1).max(3).optional(),
      offset: z.object({ x: z.number().int(), y: z.number().int() }).strict().optional(),
      verifyBeforeClick: z.boolean().optional(),
      maxMovementPx: z.number().int().min(0).max(500).optional(),
    }).strict(),
    z.object({
      ...stepId,
      type: z.literal('click-coordinate'),
      coordinate: coordinateSchema,
      button: z.enum(['left', 'right', 'middle']).optional(),
      clickCount: z.number().int().min(1).max(3).optional(),
    }).strict(),
    z.object({
      ...stepId,
      type: z.literal('random-click-region'),
      region: relativeRegionSchema,
      button: z.enum(['left', 'right', 'middle']).optional(),
      clickCount: z.number().int().min(1).max(3).optional(),
      padding: z.number().int().min(0).max(4_999).optional(),
    }).strict().refine((value) => {
      const padding = value.padding ?? 0;
      return value.region.right - value.region.left > padding * 2
        && value.region.bottom - value.region.top > padding * 2;
    }, 'random click padding must leave a non-empty region'),
    z.object({
      ...stepId,
      type: z.literal('vision-region'),
      region: relativeRegionSchema,
      body: sequenceStepSchema,
    }).strict(),
    z.object({
      ...stepId,
      type: z.literal('key-press'),
      key: z.string().min(1).max(64),
      modifiers: z.array(z.enum(['alt', 'control', 'meta', 'shift'])).max(4).refine(
        (values) => new Set(values).size === values.length,
        'key modifiers must be unique',
      ).optional(),
    }).strict(),
    z.object({
      ...stepId,
      type: z.literal('key-hold-until-image'),
      key: z.string().min(1).max(64),
      modifiers: z.array(z.enum(['alt', 'control', 'meta', 'shift'])).max(4).refine(
        (values) => new Set(values).size === values.length,
        'key modifiers must be unique',
      ).optional(),
      ...imageFields,
      state: z.enum(['visible', 'hidden']),
      timeoutMs: z.number().int().positive().max(3_600_000).optional(),
      minCycleMs: z.number().int().min(0).max(60_000).optional(),
    }).strict(),
    z.object({
      ...stepId,
      type: z.literal('move-to-image'),
      ...imageFields,
      timeoutMs: z.number().int().positive().max(3_600_000).optional(),
      minCycleMs: z.number().int().min(0).max(60_000).optional(),
      offset: z.object({ x: z.number().int(), y: z.number().int() }).strict().optional(),
    }).strict(),
    z.object({
      ...stepId,
      type: z.literal('move-to-coordinate'),
      coordinate: coordinateSchema,
    }).strict(),
    z.object({
      ...stepId,
      type: z.literal('drag-image'),
      source: imageConditionSchema,
      target: imageConditionSchema,
      timeoutMs: z.number().int().positive().max(3_600_000).optional(),
      minCycleMs: z.number().int().min(0).max(60_000).optional(),
      button: z.enum(['left', 'right', 'middle']).optional(),
      durationMs: z.number().int().nonnegative().max(10_000).optional(),
    }).strict(),
    z.object({
      ...stepId,
      type: z.literal('drag'),
      source: z.union([
        z.object({ kind: z.literal('coordinate'), coordinate: coordinateSchema }).strict(),
        z.object({ kind: z.literal('image'), condition: imageConditionSchema }).strict(),
      ]),
      target: z.union([
        z.object({ kind: z.literal('coordinate'), coordinate: coordinateSchema }).strict(),
        z.object({ kind: z.literal('image'), condition: imageConditionSchema }).strict(),
      ]),
      timeoutMs: z.number().int().positive().max(3_600_000).optional(),
      minCycleMs: z.number().int().min(0).max(60_000).optional(),
      button: z.enum(['left', 'right', 'middle']).optional(),
      durationMs: z.number().int().nonnegative().max(10_000).optional(),
    }).strict(),
    z.object({
      ...stepId,
      type: z.literal('text-input'),
      text: z.string().max(10_000),
      intervalMs: z.number().int().nonnegative().max(10_000).optional(),
    }).strict(),
    z.object({
      ...stepId,
      type: z.literal('scroll'),
      deltaX: z.number().int().min(-100_000).max(100_000),
      deltaY: z.number().int().min(-100_000).max(100_000),
    }).strict(),
    z.object({
      ...stepId,
      type: z.literal('navigate'),
      url: z.string().url().max(2048).refine((value) => /^https?:\/\//i.test(value), 'only http(s) URLs are supported'),
    }).strict(),
    z.object({ ...stepId, type: z.literal('reload') }).strict(),
    z.object({
      ...stepId,
      type: z.literal('log'),
      message: z.string().max(2000),
    }).strict(),
    z.object({
      ...stepId,
      type: z.literal('notification'),
      title: z.string().min(1).max(200),
      body: z.string().max(2000),
    }).strict(),
    z.object({
      ...stepId,
      type: z.literal('if-image'),
      condition: imageConditionSchema,
      negate: z.boolean().optional(),
      then: sequenceStepSchema,
      else: sequenceStepSchema.optional(),
    }).strict(),
    z.object({
      ...stepId,
      type: z.literal('if-condition'),
      condition: automationConditionSchema,
      then: sequenceStepSchema,
      else: sequenceStepSchema.optional(),
    }).strict(),
    z.object({
      ...stepId,
      type: z.literal('wait-condition'),
      condition: automationConditionSchema,
      timeoutMs: z.number().int().positive().max(3_600_000).optional(),
      minCycleMs: z.number().int().min(0).max(60_000).optional(),
    }).strict(),
    z.object({
      ...stepId,
      type: z.literal('wait-condition-branch'),
      condition: automationConditionSchema,
      timeoutMs: z.number().int().positive().max(3_600_000).optional(),
      minCycleMs: z.number().int().min(0).max(60_000).optional(),
      success: sequenceStepSchema,
      timeout: sequenceStepSchema,
    }).strict(),
    z.object({
      ...stepId,
      type: z.literal('end'),
      result: z.enum(['success', 'failure']),
      message: z.string().max(2000).optional(),
    }).strict(),
    z.object({
      ...stepId,
      type: z.literal('repeat'),
      times: z.number().int().min(1).max(1000),
      body: sequenceStepSchema,
    }).strict(),
    z.object({
      ...stepId,
      type: z.literal('repeat-until-image'),
      condition: imageConditionSchema,
      until: z.enum(['visible', 'hidden']),
      maxIterations: z.number().int().min(1).max(1000),
      delayMs: z.number().int().nonnegative().max(3_600_000).optional(),
      body: sequenceStepSchema,
    }).strict(),
    z.object({
      ...stepId,
      type: z.literal('repeat-until-condition'),
      condition: automationConditionSchema,
      maxIterations: z.number().int().min(1).max(1000),
      delayMs: z.number().int().nonnegative().max(3_600_000).optional(),
      body: sequenceStepSchema,
    }).strict(),
    z.object({
      ...stepId,
      type: z.literal('position-compare'),
      targetA: positionCompareTargetSchema,
      targetB: positionCompareTargetSchema,
      relation: z.enum(['vertical', 'horizontal', 'overlap']),
      tolerancePx: z.number().int().min(1).max(5000),
      then: sequenceStepSchema,
      else: sequenceStepSchema.optional(),
    }).strict(),
  ]),
);

function intersectRelativeRegions(
  outer: AutomationRelativeRegion | undefined,
  inner: AutomationRelativeRegion,
): AutomationRelativeRegion | null {
  if (!outer) return inner;
  const result = {
    left: Math.max(outer.left, inner.left),
    top: Math.max(outer.top, inner.top),
    right: Math.min(outer.right, inner.right),
    bottom: Math.min(outer.bottom, inner.bottom),
  };
  return result.left < result.right && result.top < result.bottom ? result : null;
}

function validateVisionRegions(workflow: AutomationWorkflow, ctx: z.RefinementCtx): void {
  const visit = (step: AutomationStep, outer: AutomationRelativeRegion | undefined, path: Array<string | number>): void => {
    if (step.type === 'vision-region') {
      const effective = intersectRelativeRegions(outer, step.region);
      if (!effective) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, 'region'],
          message: 'vision region does not overlap its parent search region',
        });
        return;
      }
      visit(step.body, effective, [...path, 'body']);
      return;
    }
    if (step.type === 'sequence') step.steps.forEach((child, index) => visit(child, outer, [...path, 'steps', index]));
    else if (step.type === 'if-image' || step.type === 'if-condition') {
      visit(step.then, outer, [...path, 'then']);
      if (step.else) visit(step.else, outer, [...path, 'else']);
    } else if (step.type === 'wait-condition-branch') {
      visit(step.success, outer, [...path, 'success']);
      visit(step.timeout, outer, [...path, 'timeout']);
    } else if (step.type === 'repeat' || step.type === 'repeat-until-image' || step.type === 'repeat-until-condition') {
      visit(step.body, outer, [...path, 'body']);
    } else if (step.type === 'position-compare') {
      visit(step.then, outer, [...path, 'then']);
      if (step.else) visit(step.else, outer, [...path, 'else']);
    }
  };
  visit(workflow.root, workflow.searchRegion, ['root']);
}

export const automationWorkflowSchema: z.ZodType<AutomationWorkflow, z.ZodTypeDef, unknown> = z.object({
  formatVersion: z.literal(2),
  viewport: automationViewportSchema.default(DEFAULT_AUTOMATION_VIEWPORT),
  id: idSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  searchRegion: relativeRegionSchema.optional(),
  readyWhen: automationConditionSchema.optional(),
  root: sequenceStepSchema,
}).strict()
  .refine((value) => !(value.searchRegion && value.readyWhen), 'region entry cannot also define readyWhen; add a wait step after the entry')
  .superRefine(validateVisionRegions);

export const automationPackageManifestSchema: z.ZodType<AutomationPackageManifest> = z.object({
  format: z.literal('baoauto'),
  formatVersion: z.literal(2),
  id: idSchema,
  name: z.string().min(1).max(120),
  workflow: z.literal('workflow.json'),
  assets: z.literal('assets/'),
  createdBy: z.string().min(1).max(120).optional(),
  minimumAppVersion: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
  capabilities: z.array(z.enum(['vision', 'alpha-mask', 'image-groups', 'multi-scale', 'trusted-input', 'navigation', 'combined-conditions'])).max(16).refine(
    (values) => new Set(values).size === values.length,
    'automation capabilities must be unique',
  ).optional(),
}).strict();

export function parseAutomationWorkflow(value: unknown): AutomationWorkflow {
  return automationWorkflowSchema.parse(value);
}

export function parseAutomationPackageManifest(value: unknown): AutomationPackageManifest {
  return automationPackageManifestSchema.parse(value);
}

export function collectWorkflowAssetIds(workflow: AutomationWorkflow): Set<string> {
  const result = new Set<string>();
  const addImageAssets = (value: { asset: string; alternatives?: string[] }): void => {
    result.add(value.asset);
    value.alternatives?.forEach((asset) => result.add(asset));
  };
  const addPositionTargetAssets = (target: import('./types').PositionCompareTarget): void => {
    if (target.kind === 'image') addImageAssets(target);
  };
  const visitCondition = (condition: AutomationCondition): void => {
    if (condition.type === 'image-visible') addImageAssets(condition);
    else if (condition.type === 'position-relation') { addPositionTargetAssets(condition.targetA); addPositionTargetAssets(condition.targetB); }
    else if (condition.type === 'not') visitCondition(condition.condition);
    else condition.conditions.forEach(visitCondition);
  };
  if (workflow.readyWhen) visitCondition(workflow.readyWhen);
  const visit = (step: AutomationStep): void => {
    switch (step.type) {
      case 'sequence': step.steps.forEach(visit); break;
      case 'wait-image':
      case 'wait-image-state':
      case 'click-image': addImageAssets(step); break;
      case 'key-hold-until-image': addImageAssets(step); break;
      case 'move-to-image': addImageAssets(step); break;
      case 'drag-image': addImageAssets(step.source); addImageAssets(step.target); break;
      case 'drag':
        if (step.source.kind === 'image') addImageAssets(step.source.condition);
        if (step.target.kind === 'image') addImageAssets(step.target.condition);
        break;
      case 'if-image':
        addImageAssets(step.condition);
        visit(step.then);
        if (step.else) visit(step.else);
        break;
      case 'if-condition':
        visitCondition(step.condition);
        visit(step.then);
        if (step.else) visit(step.else);
        break;
      case 'wait-condition': visitCondition(step.condition); break;
      case 'wait-condition-branch':
        visitCondition(step.condition);
        visit(step.success);
        visit(step.timeout);
        break;
      case 'repeat': visit(step.body); break;
      case 'vision-region': visit(step.body); break;
      case 'repeat-until-image':
        addImageAssets(step.condition);
        visit(step.body);
        break;
      case 'repeat-until-condition':
        visitCondition(step.condition);
        visit(step.body);
        break;
      case 'position-compare':
        addPositionTargetAssets(step.targetA);
        addPositionTargetAssets(step.targetB);
        visit(step.then);
        if (step.else) visit(step.else);
        break;
      case 'delay':
      case 'click-coordinate':
      case 'move-to-coordinate':
      case 'random-click-region':
      case 'end':
      case 'key-press':
      case 'text-input':
      case 'scroll':
      case 'navigate':
      case 'reload':
      case 'log':
      case 'notification': break;
    }
  };
  visit(workflow.root);
  return result;
}
