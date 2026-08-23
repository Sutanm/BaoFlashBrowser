import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as Blockly from 'blockly';
import * as zhHans from 'blockly/msg/zh-hans';
import * as enMessages from 'blockly/msg/en';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import { collectWorkflowAssetIds } from '@shared/automation/schema';
import type { AutomationCondition, AutomationImageMask, AutomationStep, AutomationWorkflow, ImageCondition, SequenceStep } from '@shared/automation/types';

export interface AutomationBlocklyEditorHandle {
  compile(): AutomationWorkflow;
  load(workflow: AutomationWorkflow): void;
  clearDraft(): void;
}

const IMAGE_GROUP_PREFIX = '__bao_image_group__:';

function imageGroupValue(assets: string[]): string {
  return `${IMAGE_GROUP_PREFIX}${encodeURIComponent(JSON.stringify([...new Set(assets)].sort()))}`;
}

function decodeImageGroup(value: string): string[] | undefined {
  if (!value.startsWith(IMAGE_GROUP_PREFIX)) return undefined;
  try {
    const parsed = JSON.parse(decodeURIComponent(value.slice(IMAGE_GROUP_PREFIX.length))) as unknown;
    return Array.isArray(parsed) && parsed.every((asset) => typeof asset === 'string') ? parsed : undefined;
  } catch { return undefined; }
}

export function collectFolderImageGroups(assets: string[]): Array<{ folder: string; assets: string[] }> {
  const folders = new Map<string, string[]>();
  for (const asset of [...new Set(assets)].sort()) {
    const separator = asset.lastIndexOf('/');
    if (separator <= 0) continue;
    const folder = asset.slice(0, separator);
    folders.set(folder, [...(folders.get(folder) ?? []), asset]);
  }
  return [...folders].map(([folder, members]) => ({ folder, assets: members })).filter((group) => group.assets.length >= 2);
}

function assetField(assets: string[], fallback: string): { type: string; name: string; options: string[][] } {
  const values = assets.length ? (assets.includes(fallback) ? assets : [fallback, ...assets]) : [fallback];
  const options = values.map((value) => [value, value]);
  for (const group of collectFolderImageGroups(assets)) options.push([`📚 ${group.folder} (${group.assets.length})`, imageGroupValue(group.assets)]);
  return { type: 'field_dropdown', name: 'ASSET', options };
}

function buildBlockDefinitions(LL: ReturnType<typeof useI18nContext>['LL'], assets: string[]): Array<{ type: string; [key: string]: unknown }> {
  const b = LL.automation.blockly;
  const appear = b.visible();
  const disappear = b.hidden();
  const maskField = (): { type: string; name: string; options: string[][] } => ({
    type: 'field_dropdown', name: 'MASK', options: [[b.maskAuto(), 'auto'], [b.maskAlpha(), 'alpha'], [b.maskFull(), 'none']],
  });
  return [
    { type: 'bao_start_unconditional', message0: b.startUnconditional(), message1: b.execute(), args1: [{ type: 'input_statement', name: 'DO' }], colour: 265 },
    { type: 'bao_start_condition', message0: b.startCondition(), args0: [{ type: 'input_value', name: 'CONDITION', check: 'Boolean' }], message1: b.execute(), args1: [{ type: 'input_statement', name: 'DO' }], colour: 265 },
    { type: 'bao_start', message0: b.start(), args0: [assetField(assets, 'ready.png'), { type: 'field_number', name: 'THRESHOLD', value: .9, min: .1, max: 1, precision: .01 }, maskField()], message1: b.execute(), args1: [{ type: 'input_statement', name: 'DO' }], colour: 265 },
    { type: 'bao_wait_image', message0: b.waitImage(), args0: [assetField(assets, 'button.png'), { type: 'field_number', name: 'THRESHOLD', value: .9, min: .1, max: 1, precision: .01 }, maskField(), { type: 'field_number', name: 'TIMEOUT', value: 10000, min: 1, max: 3600000 }], previousStatement: null, nextStatement: null, colour: 205 },
    { type: 'bao_wait_image_state', message0: b.waitImageState(), args0: [assetField(assets, 'button.png'), { type: 'field_dropdown', name: 'STATE', options: [[appear, 'visible'], [disappear, 'hidden']] }, maskField(), { type: 'field_number', name: 'TIMEOUT', value: 10000, min: 1, max: 3600000 }], previousStatement: null, nextStatement: null, colour: 205 },
    { type: 'bao_click_image', message0: b.clickImage(), args0: [assetField(assets, 'button.png'), { type: 'field_dropdown', name: 'BUTTON', options: [[b.leftButton(), 'left'], [b.rightButton(), 'right'], [b.middleButton(), 'middle']] }, { type: 'field_number', name: 'COUNT', value: 1, min: 1, max: 3 }, { type: 'field_number', name: 'THRESHOLD', value: .9, min: .1, max: 1, precision: .01 }, maskField(), { type: 'field_checkbox', name: 'VERIFY', checked: true }, { type: 'field_number', name: 'MOVEMENT', value: 12, min: 0, max: 500 }], previousStatement: null, nextStatement: null, colour: 205 },
    { type: 'bao_move_to_image', message0: b.moveToImage(), args0: [assetField(assets, 'button.png'), { type: 'field_number', name: 'THRESHOLD', value: .9, min: .1, max: 1, precision: .01 }, maskField()], previousStatement: null, nextStatement: null, colour: 205 },
    { type: 'bao_delay', message0: b.delay(), args0: [{ type: 'field_number', name: 'DURATION', value: 500, min: 0, max: 3600000 }], previousStatement: null, nextStatement: null, colour: 45 },
    { type: 'bao_key_press', message0: b.keyPress(), args0: [{ type: 'field_input', name: 'KEY', text: 'Enter' }], previousStatement: null, nextStatement: null, colour: 120 },
    { type: 'bao_key_combo', message0: b.keyCombo(), args0: [{ type: 'field_checkbox', name: 'CONTROL', checked: true }, { type: 'field_checkbox', name: 'ALT', checked: false }, { type: 'field_checkbox', name: 'SHIFT', checked: false }, { type: 'field_checkbox', name: 'META', checked: false }, { type: 'field_input', name: 'KEY', text: 'A' }], previousStatement: null, nextStatement: null, colour: 120 },
    { type: 'bao_hold_key_until_image', message0: b.holdKeyUntilImage(), args0: [{ type: 'field_input', name: 'KEY', text: 'Space' }, assetField(assets, 'done.png'), { type: 'field_dropdown', name: 'STATE', options: [[appear, 'visible'], [disappear, 'hidden']] }, maskField(), { type: 'field_number', name: 'TIMEOUT', value: 10000, min: 1, max: 3600000 }], previousStatement: null, nextStatement: null, colour: 120 },
    { type: 'bao_text_input', message0: b.textInput(), args0: [{ type: 'field_input', name: 'TEXT', text: b.textSample() }, { type: 'field_number', name: 'INTERVAL', value: 0, min: 0, max: 10000 }], previousStatement: null, nextStatement: null, colour: 120 },
    { type: 'bao_scroll', message0: b.scroll(), args0: [{ type: 'field_number', name: 'X', value: 0, min: -100000, max: 100000 }, { type: 'field_number', name: 'Y', value: 480, min: -100000, max: 100000 }], previousStatement: null, nextStatement: null, colour: 120 },
    { type: 'bao_navigate', message0: b.navigate(), args0: [{ type: 'field_input', name: 'URL', text: 'https://example.com/' }], previousStatement: null, nextStatement: null, colour: 170 },
    { type: 'bao_reload', message0: b.reload(), previousStatement: null, nextStatement: null, colour: 170 },
    { type: 'bao_log', message0: b.log(), args0: [{ type: 'field_input', name: 'MESSAGE', text: b.logSample() }], previousStatement: null, nextStatement: null, colour: 65 },
    { type: 'bao_if_image', message0: b.ifImage(), args0: [{ type: 'field_dropdown', name: 'MODE', options: [[b.found(), 'found'], [b.notFound(), 'missing']] }, assetField(assets, 'button.png'), { type: 'field_number', name: 'THRESHOLD', value: .9, min: .1, max: 1, precision: .01 }, maskField()], message1: b.then(), args1: [{ type: 'input_statement', name: 'THEN' }], message2: b.otherwise(), args2: [{ type: 'input_statement', name: 'ELSE' }], previousStatement: null, nextStatement: null, colour: 330 },
    { type: 'bao_if_condition', message0: b.ifCondition(), args0: [{ type: 'input_value', name: 'CONDITION', check: 'Boolean' }], message1: b.then(), args1: [{ type: 'input_statement', name: 'THEN' }], message2: b.otherwise(), args2: [{ type: 'input_statement', name: 'ELSE' }], previousStatement: null, nextStatement: null, colour: 330 },
    { type: 'bao_condition_image', message0: b.imageCondition(), args0: [assetField(assets, 'button.png'), { type: 'field_number', name: 'THRESHOLD', value: .9, min: .1, max: 1, precision: .01 }, maskField()], output: 'Boolean', colour: 205 },
    { type: 'bao_condition_and', message0: b.conditionAndMany(), args0: [{ type: 'input_value', name: 'ITEM0', check: 'Boolean' }, { type: 'input_value', name: 'ITEM1', check: 'Boolean' }, { type: 'input_value', name: 'ITEM2', check: 'Boolean' }, { type: 'input_value', name: 'ITEM3', check: 'Boolean' }], output: 'Boolean', colour: 330 },
    { type: 'bao_condition_or', message0: b.conditionOrMany(), args0: [{ type: 'input_value', name: 'ITEM0', check: 'Boolean' }, { type: 'input_value', name: 'ITEM1', check: 'Boolean' }, { type: 'input_value', name: 'ITEM2', check: 'Boolean' }, { type: 'input_value', name: 'ITEM3', check: 'Boolean' }], output: 'Boolean', colour: 330 },
    { type: 'bao_condition_not', message0: b.conditionNot(), args0: [{ type: 'input_value', name: 'VALUE', check: 'Boolean' }], output: 'Boolean', colour: 330 },
    { type: 'bao_wait_condition', message0: b.waitCondition(), args0: [{ type: 'input_value', name: 'CONDITION', check: 'Boolean' }, { type: 'field_number', name: 'TIMEOUT', value: 10000, min: 1, max: 3600000 }], previousStatement: null, nextStatement: null, colour: 330 },
    { type: 'bao_repeat', message0: b.repeat(), args0: [{ type: 'field_number', name: 'TIMES', value: 2, min: 1, max: 1000 }], message1: b.execute(), args1: [{ type: 'input_statement', name: 'DO' }], previousStatement: null, nextStatement: null, colour: 20 },
    { type: 'bao_repeat_until_image', message0: b.repeatUntilImage(), args0: [assetField(assets, 'button.png'), { type: 'field_dropdown', name: 'UNTIL', options: [[appear, 'visible'], [disappear, 'hidden']] }, maskField(), { type: 'field_number', name: 'MAX', value: 20, min: 1, max: 1000 }], message1: b.execute(), args1: [{ type: 'input_statement', name: 'DO' }], previousStatement: null, nextStatement: null, colour: 20 },
    { type: 'bao_repeat_until_condition', message0: b.repeatUntilCondition(), args0: [{ type: 'input_value', name: 'CONDITION', check: 'Boolean' }, { type: 'field_number', name: 'MAX', value: 20, min: 1, max: 1000 }], message1: b.execute(), args1: [{ type: 'input_statement', name: 'DO' }], previousStatement: null, nextStatement: null, colour: 20 },
  ];
}

function buildToolbox(LL: ReturnType<typeof useI18nContext>['LL']): Blockly.utils.toolbox.ToolboxDefinition {
  const b = LL.automation.blockly;
  return {
    kind: 'categoryToolbox',
    contents: [
      { kind: 'category', name: b.catEntry(), colour: '265', contents: ['bao_start_unconditional', 'bao_start', 'bao_start_condition'].map((type) => ({ kind: 'block', type })) },
      { kind: 'category', name: b.catImage(), colour: '205', contents: ['bao_wait_image', 'bao_wait_image_state', 'bao_click_image', 'bao_move_to_image'].map((type) => ({ kind: 'block', type })) },
      { kind: 'category', name: b.catInput(), colour: '120', contents: ['bao_key_press', 'bao_key_combo', 'bao_hold_key_until_image', 'bao_text_input', 'bao_scroll'].map((type) => ({ kind: 'block', type })) },
      { kind: 'category', name: b.catPage(), colour: '170', contents: ['bao_navigate', 'bao_reload'].map((type) => ({ kind: 'block', type })) },
      { kind: 'category', name: b.catFlow(), colour: '330', contents: ['bao_if_condition', 'bao_wait_condition', 'bao_repeat_until_condition', 'bao_condition_image', 'bao_condition_and', 'bao_condition_or', 'bao_condition_not', 'bao_if_image', 'bao_repeat', 'bao_repeat_until_image', 'bao_delay'].map((type) => ({ kind: 'block', type })) },
      { kind: 'category', name: b.catDebug(), colour: '65', contents: [{ kind: 'block', type: 'bao_log' }] },
    ],
  };
}

function number(block: Blockly.Block, field: string): number { return Number(block.getFieldValue(field)); }
function imageTarget(block: Blockly.Block): { asset: string; alternatives?: string[] } {
  const value = String(block.getFieldValue('ASSET'));
  const group = decodeImageGroup(value);
  return group?.length ? { asset: group[0], alternatives: group.slice(1) } : { asset: value, alternatives: undefined };
}
function imageTargetValue(value: { asset: string; alternatives?: string[] }): string {
  return value.alternatives?.length ? imageGroupValue([value.asset, ...value.alternatives]) : value.asset;
}
function imageMask(block: Blockly.Block): AutomationImageMask {
  const value = String(block.getFieldValue('MASK') || 'auto');
  return value === 'alpha' || value === 'none' ? value : 'auto';
}
function assetCondition(block: Blockly.Block) { return { type: 'image-visible' as const, ...imageTarget(block), threshold: number(block, 'THRESHOLD') || .9, mask: imageMask(block) }; }
function preserved<T extends object>(block: Blockly.Block): Partial<T> {
  if (!block.data) return {};
  try { return JSON.parse(block.data) as Partial<T>; } catch { return {}; }
}
function preserve(block: Blockly.Block, value: object): void { block.data = JSON.stringify(value); }
function modifiers(block: Blockly.Block): Array<'alt' | 'control' | 'meta' | 'shift'> {
  return ([['ALT', 'alt'], ['CONTROL', 'control'], ['META', 'meta'], ['SHIFT', 'shift']] as const)
    .filter(([field]) => block.getFieldValue(field) === 'TRUE')
    .map(([, modifier]) => modifier);
}

function compileCondition(LL: ReturnType<typeof useI18nContext>['LL'], block: Blockly.Block | null): AutomationCondition {
  if (!block) throw new Error(LL.automation.blockly.conditionRequired());
  switch (block.type) {
    case 'bao_condition_image': return { ...preserved<ImageCondition>(block), ...assetCondition(block) };
    case 'bao_condition_and':
    case 'bao_condition_or': {
      const conditions = [0, 1, 2, 3].map((index) => block.getInputTargetBlock(`ITEM${index}`)).filter((value): value is Blockly.Block => Boolean(value)).map((value) => compileCondition(LL, value));
      if (conditions.length < 2) throw new Error(LL.automation.blockly.twoConditionsRequired());
      return { type: block.type === 'bao_condition_and' ? 'all' : 'any', conditions };
    }
    case 'bao_condition_not': return { type: 'not', condition: compileCondition(LL, block.getInputTargetBlock('VALUE')) };
    default: throw new Error(LL.automation.blockly.unsupportedBlock({ type: block.type }));
  }
}

function compileSequence(LL: ReturnType<typeof useI18nContext>['LL'], first: Blockly.Block | null, source?: SequenceStep): SequenceStep {
  const steps: AutomationStep[] = [];
  for (let block = first; block; block = block.getNextBlock()) steps.push(compileBlock(LL, block));
  return { ...(source?.id ? { id: source.id } : {}), type: 'sequence', steps };
}

function compileBlock(LL: ReturnType<typeof useI18nContext>['LL'], block: Blockly.Block): AutomationStep {
  const extra = preserved<AutomationStep>(block);
  switch (block.type) {
    case 'bao_wait_image': return { ...extra, type: 'wait-image', ...imageTarget(block), threshold: number(block, 'THRESHOLD'), mask: imageMask(block), timeoutMs: number(block, 'TIMEOUT') } as AutomationStep;
    case 'bao_wait_image_state': return { ...extra, type: 'wait-image-state', ...imageTarget(block), state: block.getFieldValue('STATE') === 'hidden' ? 'hidden' : 'visible', mask: imageMask(block), timeoutMs: number(block, 'TIMEOUT') } as AutomationStep;
    case 'bao_click_image': return { ...extra, type: 'click-image', ...imageTarget(block), threshold: number(block, 'THRESHOLD'), mask: imageMask(block), button: block.getFieldValue('BUTTON'), clickCount: number(block, 'COUNT') as 1 | 2 | 3, verifyBeforeClick: block.getFieldValue('VERIFY') === 'TRUE', maxMovementPx: number(block, 'MOVEMENT') } as AutomationStep;
    case 'bao_move_to_image': return { ...extra, type: 'move-to-image', ...imageTarget(block), threshold: number(block, 'THRESHOLD'), mask: imageMask(block) } as AutomationStep;
    case 'bao_delay': return { ...extra, type: 'delay', durationMs: number(block, 'DURATION') } as AutomationStep;
    case 'bao_key_press': return { ...extra, type: 'key-press', key: String(block.getFieldValue('KEY')) } as AutomationStep;
    case 'bao_key_combo': return { ...extra, type: 'key-press', key: String(block.getFieldValue('KEY')), modifiers: modifiers(block) } as AutomationStep;
    case 'bao_hold_key_until_image': return { ...extra, type: 'key-hold-until-image', key: String(block.getFieldValue('KEY')), ...imageTarget(block), state: block.getFieldValue('STATE') === 'hidden' ? 'hidden' : 'visible', mask: imageMask(block), timeoutMs: number(block, 'TIMEOUT') } as AutomationStep;
    case 'bao_text_input': return { ...extra, type: 'text-input', text: String(block.getFieldValue('TEXT')), intervalMs: number(block, 'INTERVAL') } as AutomationStep;
    case 'bao_scroll': return { ...extra, type: 'scroll', deltaX: number(block, 'X'), deltaY: number(block, 'Y') } as AutomationStep;
    case 'bao_navigate': return { ...extra, type: 'navigate', url: String(block.getFieldValue('URL')) } as AutomationStep;
    case 'bao_reload': return { ...extra, type: 'reload' } as AutomationStep;
    case 'bao_log': return { ...extra, type: 'log', message: String(block.getFieldValue('MESSAGE')) } as AutomationStep;
    case 'bao_if_image': return { ...extra, type: 'if-image', condition: { ...(extra.type === 'if-image' ? extra.condition : {}), ...assetCondition(block) }, negate: block.getFieldValue('MODE') === 'missing', then: compileSequence(LL, block.getInputTargetBlock('THEN'), extra.type === 'if-image' ? extra.then : undefined), else: compileSequence(LL, block.getInputTargetBlock('ELSE'), extra.type === 'if-image' ? extra.else : undefined) } as AutomationStep;
    case 'bao_if_condition': return { ...extra, type: 'if-condition', condition: compileCondition(LL, block.getInputTargetBlock('CONDITION')), then: compileSequence(LL, block.getInputTargetBlock('THEN'), extra.type === 'if-condition' ? extra.then : undefined), else: compileSequence(LL, block.getInputTargetBlock('ELSE'), extra.type === 'if-condition' ? extra.else : undefined) } as AutomationStep;
    case 'bao_wait_condition': return { ...extra, type: 'wait-condition', condition: compileCondition(LL, block.getInputTargetBlock('CONDITION')), timeoutMs: number(block, 'TIMEOUT') } as AutomationStep;
    case 'bao_repeat': return { ...extra, type: 'repeat', times: number(block, 'TIMES'), body: compileSequence(LL, block.getInputTargetBlock('DO'), extra.type === 'repeat' ? extra.body : undefined) } as AutomationStep;
    case 'bao_repeat_until_image': return { ...extra, type: 'repeat-until-image', condition: { ...(extra.type === 'repeat-until-image' ? extra.condition : {}), type: 'image-visible', ...imageTarget(block), mask: imageMask(block) }, until: block.getFieldValue('UNTIL') === 'hidden' ? 'hidden' : 'visible', maxIterations: number(block, 'MAX'), body: compileSequence(LL, block.getInputTargetBlock('DO'), extra.type === 'repeat-until-image' ? extra.body : undefined) } as AutomationStep;
    case 'bao_repeat_until_condition': return { ...extra, type: 'repeat-until-condition', condition: compileCondition(LL, block.getInputTargetBlock('CONDITION')), maxIterations: number(block, 'MAX'), body: compileSequence(LL, block.getInputTargetBlock('DO'), extra.type === 'repeat-until-condition' ? extra.body : undefined) } as AutomationStep;
    default: throw new Error(LL.automation.blockly.unsupportedBlock({ type: block.type }));
  }
}

function setField(block: Blockly.Block, name: string, value: unknown): void {
  if (value !== undefined && block.getField(name)) block.setFieldValue(String(value), name);
}

function createStep(LL: ReturnType<typeof useI18nContext>['LL'], workspace: Blockly.WorkspaceSvg, step: AutomationStep): Blockly.BlockSvg {
  const map: Record<AutomationStep['type'], string> = {
    sequence: 'bao_delay', 'wait-image': 'bao_wait_image', 'wait-image-state': 'bao_wait_image_state',
    'click-image': 'bao_click_image', 'move-to-image': 'bao_move_to_image', delay: 'bao_delay',
    'key-press': 'bao_key_press', 'key-hold-until-image': 'bao_hold_key_until_image', 'text-input': 'bao_text_input', scroll: 'bao_scroll', navigate: 'bao_navigate',
    reload: 'bao_reload', log: 'bao_log', 'if-image': 'bao_if_image', 'if-condition': 'bao_if_condition', 'wait-condition': 'bao_wait_condition', repeat: 'bao_repeat', 'repeat-until-image': 'bao_repeat_until_image', 'repeat-until-condition': 'bao_repeat_until_condition',
  };
  if (step.type === 'sequence') throw new Error('sequence cannot be rendered as a statement block');
  const blockType = step.type === 'key-press' && step.modifiers?.length ? 'bao_key_combo' : map[step.type];
  const block = workspace.newBlock(blockType); block.initSvg(); block.render();
  preserve(block, step);
  switch (step.type) {
    case 'wait-image': setField(block, 'ASSET', imageTargetValue(step)); setField(block, 'THRESHOLD', step.threshold); setField(block, 'MASK', step.mask ?? 'auto'); setField(block, 'TIMEOUT', step.timeoutMs); break;
    case 'wait-image-state': setField(block, 'ASSET', imageTargetValue(step)); setField(block, 'STATE', step.state); setField(block, 'MASK', step.mask ?? 'auto'); setField(block, 'TIMEOUT', step.timeoutMs); break;
    case 'click-image': setField(block, 'ASSET', imageTargetValue(step)); setField(block, 'THRESHOLD', step.threshold); setField(block, 'MASK', step.mask ?? 'auto'); setField(block, 'BUTTON', step.button); setField(block, 'COUNT', step.clickCount); setField(block, 'VERIFY', (step.verifyBeforeClick ?? false) ? 'TRUE' : 'FALSE'); setField(block, 'MOVEMENT', step.maxMovementPx ?? 12); break;
    case 'move-to-image': setField(block, 'ASSET', imageTargetValue(step)); setField(block, 'THRESHOLD', step.threshold); setField(block, 'MASK', step.mask ?? 'auto'); break;
    case 'delay': setField(block, 'DURATION', step.durationMs); break;
    case 'key-press':
      setField(block, 'KEY', step.key);
      setField(block, 'ALT', step.modifiers?.includes('alt') ? 'TRUE' : 'FALSE');
      setField(block, 'CONTROL', step.modifiers?.includes('control') ? 'TRUE' : 'FALSE');
      setField(block, 'META', step.modifiers?.includes('meta') ? 'TRUE' : 'FALSE');
      setField(block, 'SHIFT', step.modifiers?.includes('shift') ? 'TRUE' : 'FALSE');
      break;
    case 'key-hold-until-image': setField(block, 'KEY', step.key); setField(block, 'ASSET', imageTargetValue(step)); setField(block, 'STATE', step.state); setField(block, 'MASK', step.mask ?? 'auto'); setField(block, 'TIMEOUT', step.timeoutMs); break;
    case 'text-input': setField(block, 'TEXT', step.text); setField(block, 'INTERVAL', step.intervalMs); break;
    case 'scroll': setField(block, 'X', step.deltaX); setField(block, 'Y', step.deltaY); break;
    case 'navigate': setField(block, 'URL', step.url); break;
    case 'log': setField(block, 'MESSAGE', step.message); break;
    case 'if-image': setField(block, 'ASSET', imageTargetValue(step.condition)); setField(block, 'THRESHOLD', step.condition.threshold); setField(block, 'MASK', step.condition.mask ?? 'auto'); setField(block, 'MODE', step.negate ? 'missing' : 'found'); connectSequence(LL, workspace, block, 'THEN', step.then); if (step.else) connectSequence(LL, workspace, block, 'ELSE', step.else); break;
    case 'if-condition': connectCondition(LL, workspace, block, 'CONDITION', step.condition); connectSequence(LL, workspace, block, 'THEN', step.then); if (step.else) connectSequence(LL, workspace, block, 'ELSE', step.else); break;
    case 'wait-condition': connectCondition(LL, workspace, block, 'CONDITION', step.condition); setField(block, 'TIMEOUT', step.timeoutMs); break;
    case 'repeat': setField(block, 'TIMES', step.times); connectSequence(LL, workspace, block, 'DO', step.body); break;
    case 'repeat-until-image': setField(block, 'ASSET', imageTargetValue(step.condition)); setField(block, 'UNTIL', step.until); setField(block, 'MASK', step.condition.mask ?? 'auto'); setField(block, 'MAX', step.maxIterations); connectSequence(LL, workspace, block, 'DO', step.body); break;
    case 'repeat-until-condition': connectCondition(LL, workspace, block, 'CONDITION', step.condition); setField(block, 'MAX', step.maxIterations); connectSequence(LL, workspace, block, 'DO', step.body); break;
    case 'reload': break;
  }
  return block;
}

function createCondition(LL: ReturnType<typeof useI18nContext>['LL'], workspace: Blockly.WorkspaceSvg, condition: AutomationCondition): Blockly.BlockSvg {
  const type = condition.type === 'image-visible' ? 'bao_condition_image' : condition.type === 'all' ? 'bao_condition_and' : condition.type === 'any' ? 'bao_condition_or' : 'bao_condition_not';
  const block = workspace.newBlock(type); block.initSvg(); block.render();
  preserve(block, condition);
  if (condition.type === 'image-visible') {
    setField(block, 'ASSET', imageTargetValue(condition)); setField(block, 'THRESHOLD', condition.threshold); setField(block, 'MASK', condition.mask ?? 'auto');
  } else if (condition.type === 'not') {
    connectCondition(LL, workspace, block, 'VALUE', condition.condition);
  } else {
    const visible = condition.conditions.slice(0, 4);
    visible.forEach((child, index) => connectCondition(LL, workspace, block, `ITEM${index}`, child));
    if (condition.conditions.length > 4) {
      connectCondition(LL, workspace, block, 'ITEM3', { type: condition.type, conditions: condition.conditions.slice(3) } as AutomationCondition);
    }
  }
  return block;
}

function connectCondition(LL: ReturnType<typeof useI18nContext>['LL'], workspace: Blockly.WorkspaceSvg, parent: Blockly.Block, inputName: string, condition: AutomationCondition): void {
  parent.getInput(inputName)?.connection?.connect(createCondition(LL, workspace, condition).outputConnection);
}

function connectSequence(LL: ReturnType<typeof useI18nContext>['LL'], workspace: Blockly.WorkspaceSvg, parent: Blockly.Block, inputName: string, sequence: SequenceStep): void {
  let previous: Blockly.BlockSvg | null = null;
  for (const step of sequence.steps) {
    const block = createStep(LL, workspace, step);
    if (!previous) parent.getInput(inputName)?.connection?.connect(block.previousConnection);
    else previous.nextConnection?.connect(block.previousConnection);
    previous = block;
  }
}

const AutomationBlocklyEditor = forwardRef<AutomationBlocklyEditorHandle, { packageId: string; initialWorkflow?: AutomationWorkflow; assets?: string[]; onDirtyChange?(dirty: boolean): void }>(function AutomationBlocklyEditor({ packageId, initialWorkflow, assets = [], onDirtyChange }, ref) {
  const { LL, locale } = useI18nContext();
  const hostRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<Blockly.WorkspaceSvg | null>(null);
  const workflowRef = useRef(initialWorkflow);
  const xmlRef = useRef<Element | null>(null);
  workflowRef.current = initialWorkflow;
  const selectableAssets = [...new Set([...assets, ...(initialWorkflow ? collectWorkflowAssetIds(initialWorkflow) : [])])].sort();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    Blockly.setLocale(locale === 'en' ? enMessages : zhHans);
    Blockly.defineBlocksWithJsonArray(buildBlockDefinitions(LL, selectableAssets));
    const workspace = Blockly.inject(host, { toolbox: buildToolbox(LL), trashcan: true, renderer: 'geras', zoom: { controls: true, wheel: true, startScale: .82, minScale: .45, maxScale: 1.4 }, grid: { spacing: 20, length: 3, colour: '#d9e2ef', snap: true } });
    const categoryColours = ['#7b59ad', '#5688a8', '#58a966', '#58a99f', '#ad587b', '#9aaa52'];
    host.querySelectorAll('.blocklyToolboxCategory').forEach((category, index) => {
      category.querySelector<HTMLElement>('.blocklyTreeRow')?.style.setProperty('--bao-category-colour', categoryColours[index] || '#5677a8');
    });
    const syncFlyoutState = (): void => {
      host.classList.toggle('bao-flyout-collapsed', !host.querySelector('.blocklyTreeSelected'));
    };
    const toolboxElement = host.querySelector('.blocklyToolboxDiv');
    const toolboxObserver = new MutationObserver(syncFlyoutState);
    if (toolboxElement) toolboxObserver.observe(toolboxElement, { attributes: true, attributeFilter: ['class'], subtree: true });
    syncFlyoutState();
    workspaceRef.current = workspace;
    if (xmlRef.current) {
      Blockly.Xml.domToWorkspace(xmlRef.current, workspace);
      xmlRef.current = null;
    } else {
      loadIntoWorkspace(LL, workspace, workflowRef.current ?? { formatVersion: 1, id: 'new-automation', name: LL.automation.blockly.defaultWorkflowName(), root: { type: 'sequence', steps: [] } });
    }
    const observer = new ResizeObserver(() => Blockly.svgResize(workspace)); observer.observe(host);
    const draftKey = `baoauto:draft:${packageId || 'new-automation'}`;
    const storedDraft = localStorage.getItem(draftKey);
    if (storedDraft) {
      try { workspace.clear(); Blockly.Xml.domToWorkspace(Blockly.utils.xml.textToDom(storedDraft), workspace); onDirtyChange?.(true); } catch { localStorage.removeItem(draftKey); }
    }
    const onWorkspaceChange = (event: Blockly.Events.Abstract): void => {
      if (event.isUiEvent || event.type === Blockly.Events.FINISHED_LOADING) return;
      localStorage.setItem(draftKey, Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(workspace)));
      onDirtyChange?.(true);
    };
    workspace.addChangeListener(onWorkspaceChange);
    return () => {
      observer.disconnect();
      toolboxObserver.disconnect();
      if (workspaceRef.current) xmlRef.current = Blockly.Xml.workspaceToDom(workspaceRef.current);
      workspace.removeChangeListener(onWorkspaceChange);
      workspace.dispose();
      workspaceRef.current = null;
    };
  }, [locale, LL, packageId, selectableAssets.join('\n')]);

  useImperativeHandle(ref, () => ({
    compile: () => {
      const workspace = workspaceRef.current; if (!workspace) throw new Error(LL.automation.blockly.workspaceNotReady());
      const starts = workspace.getTopBlocks(true).filter((block) => block.type === 'bao_start' || block.type === 'bao_start_unconditional' || block.type === 'bao_start_condition');
      if (starts.length !== 1) throw new Error(LL.automation.blockly.requireOneStart());
      const source = workflowRef.current;
      const conditional = starts[0].type === 'bao_start';
      const combined = starts[0].type === 'bao_start_condition';
      const readyAsset = conditional ? String(starts[0].getFieldValue('ASSET') || '').trim() : '';
      const readySource = preserved<ImageCondition>(starts[0]);
      return {
        formatVersion: 1,
        id: source?.id ?? 'new-automation',
        name: source?.name ?? LL.automation.blockly.defaultWorkflowName(),
        description: source?.description,
        ...(combined ? { readyWhen: compileCondition(LL, starts[0].getInputTargetBlock('CONDITION')) } : readyAsset ? { readyWhen: { ...readySource, type: 'image-visible' as const, ...imageTarget(starts[0]), threshold: number(starts[0], 'THRESHOLD'), mask: imageMask(starts[0]) } } : {}),
        root: compileSequence(LL, starts[0].getInputTargetBlock('DO'), source?.root),
      };
    },
    load: (workflow) => { workflowRef.current = workflow; if (workspaceRef.current) loadIntoWorkspace(LL, workspaceRef.current, workflow); },
    clearDraft: () => { localStorage.removeItem(`baoauto:draft:${packageId || 'new-automation'}`); onDirtyChange?.(false); },
  }), [LL, onDirtyChange, packageId]);

  return <div ref={hostRef} className="automation-blockly-host" data-block-types={buildBlockDefinitions(LL, selectableAssets).map((definition: { type: string }) => definition.type).join(' ')} />;
});

function loadIntoWorkspace(LL: ReturnType<typeof useI18nContext>['LL'], workspace: Blockly.WorkspaceSvg, workflow: AutomationWorkflow): void {
  workspace.clear();
  const startType = !workflow.readyWhen ? 'bao_start_unconditional' : workflow.readyWhen.type === 'image-visible' ? 'bao_start' : 'bao_start_condition';
  const start = workspace.newBlock(startType); start.initSvg(); start.render();
  if (workflow.readyWhen?.type === 'image-visible') { preserve(start, workflow.readyWhen); setField(start, 'ASSET', imageTargetValue(workflow.readyWhen)); setField(start, 'THRESHOLD', workflow.readyWhen.threshold ?? .9); setField(start, 'MASK', workflow.readyWhen.mask ?? 'auto'); }
  else if (workflow.readyWhen) connectCondition(LL, workspace, start, 'CONDITION', workflow.readyWhen);
  connectSequence(LL, workspace, start, 'DO', workflow.root);
  start.moveBy(36, 30);
}

export default AutomationBlocklyEditor;
