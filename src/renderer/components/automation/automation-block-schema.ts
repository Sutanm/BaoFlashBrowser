import type { AutomationStep } from '@shared/automation/types';

type RenderableStep = Exclude<AutomationStep, { type: 'sequence' }>;
type RenderableStepType = RenderableStep['type'];

export const STEP_BLOCK_TYPES: Record<RenderableStepType, string> = {
  'wait-image': 'bao_wait_image',
  'wait-image-state': 'bao_wait_image_state',
  'click-image': 'bao_click_image',
  'click-coordinate': 'bao_click_image',
  'wait-text-state': 'bao_wait_text_state',
  'click-text': 'bao_click_text',
  'random-click-region': 'bao_random_click_region',
  'vision-region': 'bao_vision_region',
  'coordinate-space': 'bao_coordinate_space_page',
  'move-to-image': 'bao_move_to_image',
  'move-to-coordinate': 'bao_move_to_image',
  'drag-image': 'bao_drag_image',
  drag: 'bao_drag_image',
  delay: 'bao_delay',
  'key-press': 'bao_key_press',
  'key-hold-until-image': 'bao_hold_key_until_image',
  'text-input': 'bao_text_input',
  scroll: 'bao_scroll',
  navigate: 'bao_navigate',
  reload: 'bao_reload',
  log: 'bao_log',
  notification: 'bao_notification',
  end: 'bao_end',
  'if-image': 'bao_if_image',
  'if-condition': 'bao_if_condition',
  'wait-condition': 'bao_wait_condition',
  'wait-condition-branch': 'bao_wait_condition_branch',
  repeat: 'bao_repeat',
  forever: 'bao_forever',
  break: 'bao_break',
  'repeat-until-image': 'bao_repeat_until_image',
  'repeat-until-condition': 'bao_repeat_until_condition',
  'position-compare': 'bao_position_compare',
};

type ScalarStepType = 'delay' | 'text-input' | 'scroll' | 'navigate' | 'reload' | 'log' | 'notification';
type ScalarKind = 'number' | 'string';
type ScalarField = Readonly<{ field: string; property: string; kind: ScalarKind }>;
type ScalarStepSchema = Readonly<{ type: ScalarStepType; fields: readonly ScalarField[] }>;

export const SCALAR_STEP_SCHEMAS: Readonly<Record<string, ScalarStepSchema>> = {
  bao_delay: { type: 'delay', fields: [{ field: 'DURATION', property: 'durationMs', kind: 'number' }] },
  bao_text_input: { type: 'text-input', fields: [{ field: 'TEXT', property: 'text', kind: 'string' }, { field: 'INTERVAL', property: 'intervalMs', kind: 'number' }] },
  bao_scroll: { type: 'scroll', fields: [{ field: 'X', property: 'deltaX', kind: 'number' }, { field: 'Y', property: 'deltaY', kind: 'number' }] },
  bao_navigate: { type: 'navigate', fields: [{ field: 'URL', property: 'url', kind: 'string' }] },
  bao_reload: { type: 'reload', fields: [] },
  bao_log: { type: 'log', fields: [{ field: 'MESSAGE', property: 'message', kind: 'string' }] },
  bao_notification: { type: 'notification', fields: [{ field: 'TITLE', property: 'title', kind: 'string' }, { field: 'BODY', property: 'body', kind: 'string' }] },
};

export function compileScalarStep(
  blockType: string,
  getField: (name: string) => unknown,
  preserved: Record<string, unknown> = {},
): AutomationStep | null {
  const schema = SCALAR_STEP_SCHEMAS[blockType];
  if (!schema) return null;
  const values: Record<string, unknown> = { ...preserved, type: schema.type };
  for (const field of schema.fields) {
    const value = getField(field.field);
    values[field.property] = field.kind === 'number' ? Number(value) : String(value);
  }
  return values as AutomationStep;
}

export function writeScalarStepFields(
  step: AutomationStep,
  setField: (name: string, value: unknown) => void,
): boolean {
  if (step.type === 'sequence') return false;
  const blockType = STEP_BLOCK_TYPES[step.type];
  const schema = SCALAR_STEP_SCHEMAS[blockType];
  if (!schema || schema.type !== step.type) return false;
  const values = step as unknown as Record<string, unknown>;
  for (const field of schema.fields) setField(field.field, values[field.property]);
  return true;
}

export function blockTypeForStep(step: RenderableStep): string {
  if (step.type === 'key-press' && step.modifiers?.length) return 'bao_key_combo';
  return STEP_BLOCK_TYPES[step.type];
}
