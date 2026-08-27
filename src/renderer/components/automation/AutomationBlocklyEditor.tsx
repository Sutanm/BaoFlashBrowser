import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as Blockly from 'blockly';
import * as zhHans from 'blockly/msg/zh-hans';
import * as enMessages from 'blockly/msg/en';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import { collectWorkflowAssetIds } from '@shared/automation/schema';
import type { AutomationCondition, AutomationImageMask, AutomationPointerTarget, AutomationStep, AutomationWorkflow, ImageCondition, PositionCompareTarget, SequenceStep } from '@shared/automation/types';
import { blockTypeForStep, compileScalarStep, writeScalarStepFields } from './automation-block-schema';

export interface AutomationBlocklyEditorHandle {
  compile(): AutomationWorkflow;
  load(workflow: AutomationWorkflow): void;
  clearDraft(): void;
}

const IMAGE_GROUP_PREFIX = '__bao_image_group__:';
const COORDINATE_TARGET = '__bao_coordinate__';
const CLICK_TARGET_EXTENSION = 'bao_click_target_mode';
const DRAG_TARGET_EXTENSION = 'bao_drag_target_mode';

if (!Blockly.Extensions.isRegistered(CLICK_TARGET_EXTENSION)) {
  Blockly.Extensions.register(CLICK_TARGET_EXTENSION, function (this: Blockly.Block) {
    const updateFields = (): void => {
      const coordinateMode = this.getFieldValue('ASSET') === COORDINATE_TARGET;
      this.getField('COORDINATE')?.setVisible(coordinateMode);
      ['THRESHOLD', 'MASK', 'VERIFY', 'MOVEMENT'].forEach((name) => this.getField(name)?.setVisible(!coordinateMode));
      if (this instanceof Blockly.BlockSvg && this.rendered) this.render();
    };
    this.setOnChange(updateFields);
    updateFields();
  });
}

if (!Blockly.Extensions.isRegistered(DRAG_TARGET_EXTENSION)) {
  Blockly.Extensions.register(DRAG_TARGET_EXTENSION, function (this: Blockly.Block) {
    const updateFields = (): void => {
      for (const prefix of ['SOURCE', 'TARGET']) {
        const coordinateMode = this.getFieldValue(`${prefix}_ASSET`) === COORDINATE_TARGET;
        this.getField(`${prefix}_COORDINATE`)?.setVisible(coordinateMode);
        [`${prefix}_THRESHOLD`, `${prefix}_MASK`].forEach((name) => this.getField(name)?.setVisible(!coordinateMode));
      }
      if (this instanceof Blockly.BlockSvg && this.rendered) this.render();
    };
    this.setOnChange(updateFields);
    updateFields();
  });
}

const POSITION_COMPARE_EXTENSION = 'bao_position_compare_mode';
if (!Blockly.Extensions.isRegistered(POSITION_COMPARE_EXTENSION)) {
  Blockly.Extensions.register(POSITION_COMPARE_EXTENSION, function (this: Blockly.Block) {
    const updateFields = (): void => {
      for (const prefix of ['A', 'B']) {
        const coordinateMode = this.getFieldValue(`${prefix}_TYPE`) === 'coordinate';
        this.getField(`${prefix}_ASSET`)?.setVisible(!coordinateMode);
        this.getField(`${prefix}_COORDINATE`)?.setVisible(coordinateMode);
        [`${prefix}_THRESHOLD`, `${prefix}_MASK`, `${prefix}_OFFSET_X`, `${prefix}_OFFSET_Y`].forEach((name) => this.getField(name)?.setVisible(!coordinateMode));
      }
      if (this instanceof Blockly.BlockSvg && this.rendered) this.render();
    };
    this.setOnChange(updateFields);
    updateFields();
  });
}

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

function assetField(assets: string[], fallback: string, name = 'ASSET'): { type: string; name: string; options: string[][] } {
  const values = assets.length ? (assets.includes(fallback) ? assets : [fallback, ...assets]) : [fallback];
  const options = values.map((value) => [value, value]);
  for (const group of collectFolderImageGroups(assets)) options.push([`📚 ${group.folder} (${group.assets.length})`, imageGroupValue(group.assets)]);
  return { type: 'field_dropdown', name, options };
}

function clickTargetField(assets: string[], coordinateLabel: string, fallback = 'button.png', name = 'ASSET'): { type: string; name: string; options: string[][] } {
  const field = assetField(assets, fallback, name);
  return { ...field, options: [[coordinateLabel, COORDINATE_TARGET], ...field.options] };
}

function buildBlockDefinitions(LL: ReturnType<typeof useI18nContext>['LL'], assets: string[]): Array<{ type: string; [key: string]: unknown }> {
  const b = LL.automation.blockly;
  const appear = b.visible();
  const disappear = b.hidden();
  const maskField = (name = 'MASK'): { type: string; name: string; options: string[][] } => ({
    type: 'field_dropdown', name, options: [[b.maskAuto(), 'auto'], [b.maskAlpha(), 'alpha'], [b.maskFull(), 'none']],
  });
  return [
    { type: 'bao_start_unconditional', message0: b.startUnconditional(), message1: b.execute(), args1: [{ type: 'input_statement', name: 'DO' }], colour: 265 },
    { type: 'bao_start_region', message0: b.startRegion(), args0: [{ type: 'field_input', name: 'TOP_LEFT', text: '0,0' }, { type: 'field_input', name: 'BOTTOM_RIGHT', text: '10000,10000' }], message1: b.execute(), args1: [{ type: 'input_statement', name: 'DO' }], colour: 265 },
    { type: 'bao_start_condition', message0: b.startCondition(), args0: [{ type: 'input_value', name: 'CONDITION', check: 'Boolean' }], message1: b.execute(), args1: [{ type: 'input_statement', name: 'DO' }], colour: 265 },
    { type: 'bao_start', message0: b.start(), args0: [assetField(assets, 'ready.png'), { type: 'field_number', name: 'THRESHOLD', value: .9, min: .1, max: 1, precision: .01 }, maskField()], message1: b.execute(), args1: [{ type: 'input_statement', name: 'DO' }], colour: 265 },
    { type: 'bao_wait_image', message0: b.waitImage(), args0: [assetField(assets, 'button.png'), { type: 'field_number', name: 'THRESHOLD', value: .9, min: .1, max: 1, precision: .01 }, maskField(), { type: 'field_number', name: 'TIMEOUT', value: 10000, min: 1, max: 3600000 }], previousStatement: null, nextStatement: null, colour: 205 },
    { type: 'bao_wait_image_state', message0: b.waitImageState(), args0: [assetField(assets, 'button.png'), { type: 'field_dropdown', name: 'STATE', options: [[appear, 'visible'], [disappear, 'hidden']] }, maskField(), { type: 'field_number', name: 'TIMEOUT', value: 10000, min: 1, max: 3600000 }], previousStatement: null, nextStatement: null, colour: 205 },
    { type: 'bao_click_image', message0: b.clickImage(), args0: [clickTargetField(assets, b.coordinateTarget()), { type: 'field_input', name: 'COORDINATE', text: '5000,5000' }, { type: 'field_dropdown', name: 'BUTTON', options: [[b.leftButton(), 'left'], [b.rightButton(), 'right'], [b.middleButton(), 'middle']] }, { type: 'field_number', name: 'COUNT', value: 1, min: 1, max: 3 }, { type: 'field_number', name: 'THRESHOLD', value: .9, min: .1, max: 1, precision: .01 }, maskField(), { type: 'field_checkbox', name: 'VERIFY', checked: true }, { type: 'field_number', name: 'MOVEMENT', value: 12, min: 0, max: 500 }], extensions: [CLICK_TARGET_EXTENSION], previousStatement: null, nextStatement: null, colour: 205 },
    { type: 'bao_move_to_image', message0: b.moveToTarget(), args0: [clickTargetField(assets, b.coordinateTarget()), { type: 'field_input', name: 'COORDINATE', text: '5000,5000' }, { type: 'field_number', name: 'THRESHOLD', value: .9, min: .1, max: 1, precision: .01 }, maskField()], extensions: [CLICK_TARGET_EXTENSION], previousStatement: null, nextStatement: null, colour: 120 },
    { type: 'bao_drag_image', message0: b.dragTarget(), args0: [clickTargetField(assets, b.coordinateTarget(), 'A.png', 'SOURCE_ASSET'), { type: 'field_input', name: 'SOURCE_COORDINATE', text: '3000,5000' }, { type: 'field_number', name: 'SOURCE_THRESHOLD', value: .9, min: .1, max: 1, precision: .01 }, maskField('SOURCE_MASK'), clickTargetField(assets, b.coordinateTarget(), 'B.png', 'TARGET_ASSET'), { type: 'field_input', name: 'TARGET_COORDINATE', text: '7000,5000' }, { type: 'field_number', name: 'TARGET_THRESHOLD', value: .9, min: .1, max: 1, precision: .01 }, maskField('TARGET_MASK'), { type: 'field_dropdown', name: 'BUTTON', options: [[b.leftButton(), 'left'], [b.rightButton(), 'right'], [b.middleButton(), 'middle']] }, { type: 'field_number', name: 'DURATION', value: 800, min: 0, max: 10000 }, { type: 'field_number', name: 'TIMEOUT', value: 10000, min: 1, max: 3600000 }], extensions: [DRAG_TARGET_EXTENSION], previousStatement: null, nextStatement: null, colour: 120 },
    { type: 'bao_delay', message0: b.delay(), args0: [{ type: 'field_number', name: 'DURATION', value: 500, min: 0, max: 3600000 }], previousStatement: null, nextStatement: null, colour: 45 },
    { type: 'bao_key_press', message0: b.keyPress(), args0: [{ type: 'field_input', name: 'KEY', text: 'Enter' }], previousStatement: null, nextStatement: null, colour: 120 },
    { type: 'bao_key_combo', message0: b.keyCombo(), args0: [{ type: 'field_checkbox', name: 'CONTROL', checked: true }, { type: 'field_checkbox', name: 'ALT', checked: false }, { type: 'field_checkbox', name: 'SHIFT', checked: false }, { type: 'field_checkbox', name: 'META', checked: false }, { type: 'field_input', name: 'KEY', text: 'A' }], previousStatement: null, nextStatement: null, colour: 120 },
    { type: 'bao_hold_key_until_image', message0: b.holdKeyUntilImage(), args0: [{ type: 'field_input', name: 'KEY', text: 'Space' }, assetField(assets, 'done.png'), { type: 'field_dropdown', name: 'STATE', options: [[appear, 'visible'], [disappear, 'hidden']] }, maskField(), { type: 'field_number', name: 'TIMEOUT', value: 10000, min: 1, max: 3600000 }], previousStatement: null, nextStatement: null, colour: 120 },
    { type: 'bao_text_input', message0: b.textInput(), args0: [{ type: 'field_input', name: 'TEXT', text: b.textSample() }, { type: 'field_number', name: 'INTERVAL', value: 0, min: 0, max: 10000 }], previousStatement: null, nextStatement: null, colour: 120 },
    { type: 'bao_scroll', message0: b.scroll(), args0: [{ type: 'field_number', name: 'X', value: 0, min: -100000, max: 100000 }, { type: 'field_number', name: 'Y', value: 480, min: -100000, max: 100000 }], previousStatement: null, nextStatement: null, colour: 120 },
    { type: 'bao_random_click_region', message0: b.randomClickRegion(), args0: [{ type: 'field_input', name: 'TOP_LEFT', text: '2000,2000' }, { type: 'field_input', name: 'BOTTOM_RIGHT', text: '8000,8000' }, { type: 'field_dropdown', name: 'BUTTON', options: [[b.leftButton(), 'left'], [b.rightButton(), 'right'], [b.middleButton(), 'middle']] }, { type: 'field_number', name: 'COUNT', value: 2, min: 1, max: 3 }, { type: 'field_number', name: 'PADDING', value: 0, min: 0, max: 4999 }], previousStatement: null, nextStatement: null, colour: 120 },
    { type: 'bao_navigate', message0: b.navigate(), args0: [{ type: 'field_input', name: 'URL', text: 'https://example.com/' }], previousStatement: null, nextStatement: null, colour: 170 },
    { type: 'bao_reload', message0: b.reload(), previousStatement: null, nextStatement: null, colour: 170 },
    { type: 'bao_log', message0: b.log(), args0: [{ type: 'field_input', name: 'MESSAGE', text: b.logSample() }], previousStatement: null, nextStatement: null, colour: 65 },
    { type: 'bao_notification', message0: b.notification(), args0: [{ type: 'field_input', name: 'TITLE', text: b.notificationTitle() }, { type: 'field_input', name: 'BODY', text: b.notificationBody() }], previousStatement: null, nextStatement: null, colour: 65 },
    { type: 'bao_if_image', message0: b.ifImage(), args0: [{ type: 'field_dropdown', name: 'MODE', options: [[b.found(), 'found'], [b.notFound(), 'missing']] }, assetField(assets, 'button.png'), { type: 'field_number', name: 'THRESHOLD', value: .9, min: .1, max: 1, precision: .01 }, maskField()], message1: b.then(), args1: [{ type: 'input_statement', name: 'THEN' }], message2: b.otherwise(), args2: [{ type: 'input_statement', name: 'ELSE' }], previousStatement: null, nextStatement: null, colour: 330 },
    { type: 'bao_if_condition', message0: b.ifCondition(), args0: [{ type: 'input_value', name: 'CONDITION', check: 'Boolean' }], message1: b.then(), args1: [{ type: 'input_statement', name: 'THEN' }], message2: b.otherwise(), args2: [{ type: 'input_statement', name: 'ELSE' }], previousStatement: null, nextStatement: null, colour: 330 },
    { type: 'bao_condition_image', message0: b.imageCondition(), args0: [assetField(assets, 'button.png'), { type: 'field_number', name: 'THRESHOLD', value: .9, min: .1, max: 1, precision: .01 }, maskField()], output: 'Boolean', colour: 205 },
    { type: 'bao_condition_and', message0: b.conditionAndMany(), args0: [{ type: 'input_value', name: 'ITEM0', check: 'Boolean' }, { type: 'input_value', name: 'ITEM1', check: 'Boolean' }, { type: 'input_value', name: 'ITEM2', check: 'Boolean' }, { type: 'input_value', name: 'ITEM3', check: 'Boolean' }], output: 'Boolean', colour: 330 },
    { type: 'bao_condition_or', message0: b.conditionOrMany(), args0: [{ type: 'input_value', name: 'ITEM0', check: 'Boolean' }, { type: 'input_value', name: 'ITEM1', check: 'Boolean' }, { type: 'input_value', name: 'ITEM2', check: 'Boolean' }, { type: 'input_value', name: 'ITEM3', check: 'Boolean' }], output: 'Boolean', colour: 330 },
    { type: 'bao_condition_not', message0: b.conditionNot(), args0: [{ type: 'input_value', name: 'VALUE', check: 'Boolean' }], output: 'Boolean', colour: 330 },
    { type: 'bao_condition_position', message0: b.positionCondition(), args0: [
      { type: 'field_dropdown', name: 'A_TYPE', options: [[b.imageTarget(), 'image'], [b.coordinateTarget(), 'coordinate']] },
      assetField(assets, 'A.png', 'A_ASSET'),
      { type: 'field_input', name: 'A_COORDINATE', text: '5000,5000' },
      { type: 'field_number', name: 'A_THRESHOLD', value: .9, min: .1, max: 1, precision: .01 },
      maskField('A_MASK'),
      { type: 'field_number', name: 'A_OFFSET_X', value: 0 },
      { type: 'field_number', name: 'A_OFFSET_Y', value: 0 },
      { type: 'field_dropdown', name: 'B_TYPE', options: [[b.imageTarget(), 'image'], [b.coordinateTarget(), 'coordinate']] },
      assetField(assets, 'B.png', 'B_ASSET'),
      { type: 'field_input', name: 'B_COORDINATE', text: '5000,5000' },
      { type: 'field_number', name: 'B_THRESHOLD', value: .9, min: .1, max: 1, precision: .01 },
      maskField('B_MASK'),
      { type: 'field_number', name: 'B_OFFSET_X', value: 0 },
      { type: 'field_number', name: 'B_OFFSET_Y', value: 0 },
      { type: 'field_dropdown', name: 'RELATION', options: [[b.relationVertical(), 'vertical'], [b.relationHorizontal(), 'horizontal'], [b.relationOverlap(), 'overlap']] },
      { type: 'field_number', name: 'TOLERANCE', value: 10, min: 1, max: 5000 },
    ], output: 'Boolean', extensions: [POSITION_COMPARE_EXTENSION], colour: 205 },
    { type: 'bao_position_compare', message0: b.positionCompare(), args0: [
      { type: 'field_dropdown', name: 'A_TYPE', options: [[b.imageTarget(), 'image'], [b.coordinateTarget(), 'coordinate']] },
      assetField(assets, 'A.png', 'A_ASSET'),
      { type: 'field_input', name: 'A_COORDINATE', text: '5000,5000' },
      { type: 'field_number', name: 'A_THRESHOLD', value: .9, min: .1, max: 1, precision: .01 },
      maskField('A_MASK'),
      { type: 'field_number', name: 'A_OFFSET_X', value: 0 },
      { type: 'field_number', name: 'A_OFFSET_Y', value: 0 },
      { type: 'field_dropdown', name: 'B_TYPE', options: [[b.imageTarget(), 'image'], [b.coordinateTarget(), 'coordinate']] },
      assetField(assets, 'B.png', 'B_ASSET'),
      { type: 'field_input', name: 'B_COORDINATE', text: '5000,5000' },
      { type: 'field_number', name: 'B_THRESHOLD', value: .9, min: .1, max: 1, precision: .01 },
      maskField('B_MASK'),
      { type: 'field_number', name: 'B_OFFSET_X', value: 0 },
      { type: 'field_number', name: 'B_OFFSET_Y', value: 0 },
      { type: 'field_dropdown', name: 'RELATION', options: [[b.relationVertical(), 'vertical'], [b.relationHorizontal(), 'horizontal'], [b.relationOverlap(), 'overlap']] },
      { type: 'field_number', name: 'TOLERANCE', value: 10, min: 1, max: 5000 },
    ], message1: b.then(), args1: [{ type: 'input_statement', name: 'THEN' }], message2: b.otherwise(), args2: [{ type: 'input_statement', name: 'ELSE' }], extensions: [POSITION_COMPARE_EXTENSION], previousStatement: null, nextStatement: null, colour: 330 },
    { type: 'bao_wait_condition', message0: b.waitCondition(), args0: [{ type: 'input_value', name: 'CONDITION', check: 'Boolean' }, { type: 'field_number', name: 'TIMEOUT', value: 10000, min: 1, max: 3600000 }], previousStatement: null, nextStatement: null, colour: 330 },
    { type: 'bao_wait_condition_branch', message0: b.waitConditionBranch(), args0: [{ type: 'input_value', name: 'CONDITION', check: 'Boolean' }, { type: 'field_number', name: 'TIMEOUT', value: 10000, min: 1, max: 3600000 }], message1: b.onSuccess(), args1: [{ type: 'input_statement', name: 'SUCCESS' }], message2: b.onTimeout(), args2: [{ type: 'input_statement', name: 'TIMEOUT_BRANCH' }], previousStatement: null, nextStatement: null, colour: 330 },
    { type: 'bao_repeat', message0: b.repeat(), args0: [{ type: 'field_number', name: 'TIMES', value: 2, min: 1, max: 1000 }], message1: b.execute(), args1: [{ type: 'input_statement', name: 'DO' }], previousStatement: null, nextStatement: null, colour: 20 },
    { type: 'bao_repeat_until_image', message0: b.repeatUntilImage(), args0: [assetField(assets, 'button.png'), { type: 'field_dropdown', name: 'UNTIL', options: [[appear, 'visible'], [disappear, 'hidden']] }, maskField(), { type: 'field_number', name: 'MAX', value: 20, min: 1, max: 1000 }], message1: b.execute(), args1: [{ type: 'input_statement', name: 'DO' }], previousStatement: null, nextStatement: null, colour: 20 },
    { type: 'bao_repeat_until_condition', message0: b.repeatUntilCondition(), args0: [{ type: 'input_value', name: 'CONDITION', check: 'Boolean' }, { type: 'field_number', name: 'MAX', value: 20, min: 1, max: 1000 }], message1: b.execute(), args1: [{ type: 'input_statement', name: 'DO' }], previousStatement: null, nextStatement: null, colour: 20 },
    { type: 'bao_end', message0: b.end(), args0: [{ type: 'field_dropdown', name: 'RESULT', options: [[b.endSuccess(), 'success'], [b.endFailure(), 'failure']] }, { type: 'field_input', name: 'MESSAGE', text: b.endSample() }], previousStatement: null, nextStatement: null, colour: 65 },
  ];
}

function buildToolbox(LL: ReturnType<typeof useI18nContext>['LL']): Blockly.utils.toolbox.ToolboxDefinition {
  const b = LL.automation.blockly;
  return {
    kind: 'categoryToolbox',
    contents: [
      { kind: 'category', name: b.catEntry(), colour: '265', contents: ['bao_start_unconditional', 'bao_start_region', 'bao_start', 'bao_start_condition'].map((type) => ({ kind: 'block', type })) },
      { kind: 'category', name: b.catMouse(), colour: '120', contents: ['bao_click_image', 'bao_random_click_region', 'bao_move_to_image', 'bao_drag_image', 'bao_scroll'].map((type) => ({ kind: 'block', type })) },
      { kind: 'category', name: b.catKeyboard(), colour: '105', contents: ['bao_key_press', 'bao_key_combo', 'bao_hold_key_until_image', 'bao_text_input'].map((type) => ({ kind: 'block', type })) },
      { kind: 'category', name: b.catRecognition(), colour: '205', contents: ['bao_wait_image', 'bao_wait_image_state', 'bao_delay'].map((type) => ({ kind: 'block', type })) },
      { kind: 'category', name: b.catPage(), colour: '170', contents: ['bao_navigate', 'bao_reload'].map((type) => ({ kind: 'block', type })) },
      { kind: 'category', name: b.catFlow(), colour: '330', contents: ['bao_if_condition', 'bao_wait_condition', 'bao_wait_condition_branch', 'bao_repeat_until_condition', 'bao_condition_image', 'bao_condition_position', 'bao_condition_and', 'bao_condition_or', 'bao_condition_not', 'bao_if_image', 'bao_position_compare', 'bao_repeat', 'bao_repeat_until_image'].map((type) => ({ kind: 'block', type })) },
      { kind: 'category', name: b.catDebug(), colour: '65', contents: ['bao_log', 'bao_notification', 'bao_end'].map((type) => ({ kind: 'block', type })) },
    ],
  };
}

function number(block: Blockly.Block, field: string): number { return Number(block.getFieldValue(field)); }
function imageTarget(block: Blockly.Block, field = 'ASSET'): { asset: string; alternatives?: string[] } {
  const value = String(block.getFieldValue(field));
  const group = decodeImageGroup(value);
  return group?.length ? { asset: group[0], alternatives: group.slice(1) } : { asset: value, alternatives: undefined };
}
function imageTargetValue(value: { asset: string; alternatives?: string[] }): string {
  return value.alternatives?.length ? imageGroupValue([value.asset, ...value.alternatives]) : value.asset;
}
function imageMask(block: Blockly.Block, field = 'MASK'): AutomationImageMask {
  const value = String(block.getFieldValue(field) || 'auto');
  return value === 'alpha' || value === 'none' ? value : 'auto';
}
function parseRelativeCoordinate(LL: ReturnType<typeof useI18nContext>['LL'], value: unknown): { x: number; y: number } {
  const match = /^\s*(\d{1,5})\s*[,，]\s*(\d{1,5})\s*$/.exec(String(value || ''));
  const coordinate = match ? { x: Number(match[1]), y: Number(match[2]) } : null;
  if (!coordinate || coordinate.x > 10_000 || coordinate.y > 10_000) throw new Error(LL.automation.blockly.invalidCoordinate());
  return coordinate;
}
function relativeCoordinate(LL: ReturnType<typeof useI18nContext>['LL'], block: Blockly.Block, field = 'COORDINATE'): { x: number; y: number } {
  return parseRelativeCoordinate(LL, block.getFieldValue(field));
}
function relativeSearchRegion(LL: ReturnType<typeof useI18nContext>['LL'], block: Blockly.Block): { left: number; top: number; right: number; bottom: number } {
  const topLeft = parseRelativeCoordinate(LL, block.getFieldValue('TOP_LEFT'));
  const bottomRight = parseRelativeCoordinate(LL, block.getFieldValue('BOTTOM_RIGHT'));
  if (topLeft.x >= bottomRight.x || topLeft.y >= bottomRight.y) throw new Error(LL.automation.blockly.invalidSearchRegion());
  return { left: topLeft.x, top: topLeft.y, right: bottomRight.x, bottom: bottomRight.y };
}
function assetCondition(block: Blockly.Block) { return { type: 'image-visible' as const, ...imageTarget(block), threshold: number(block, 'THRESHOLD') || .9, mask: imageMask(block) }; }
function positionCompareTarget(LL: ReturnType<typeof useI18nContext>['LL'], block: Blockly.Block, prefix: 'A' | 'B'): PositionCompareTarget {
  if (block.getFieldValue(`${prefix}_TYPE`) === 'coordinate') {
    return { kind: 'coordinate', coordinate: relativeCoordinate(LL, block, `${prefix}_COORDINATE`) };
  }
  const offset = { x: number(block, `${prefix}_OFFSET_X`) || 0, y: number(block, `${prefix}_OFFSET_Y`) || 0 };
  return {
    kind: 'image',
    asset: String(block.getFieldValue(`${prefix}_ASSET`)),
    threshold: number(block, `${prefix}_THRESHOLD`) || .9,
    mask: imageMask(block, `${prefix}_MASK`),
    offset: (offset.x !== 0 || offset.y !== 0) ? offset : undefined,
  };
}
function positionCompareCondition(LL: ReturnType<typeof useI18nContext>['LL'], block: Blockly.Block): AutomationCondition {
  return {
    type: 'position-relation',
    targetA: positionCompareTarget(LL, block, 'A'),
    targetB: positionCompareTarget(LL, block, 'B'),
    relation: block.getFieldValue('RELATION') || 'vertical',
    tolerancePx: number(block, 'TOLERANCE') || 10,
  };
}
function pointerTarget(LL: ReturnType<typeof useI18nContext>['LL'], block: Blockly.Block, prefix: 'SOURCE' | 'TARGET'): AutomationPointerTarget {
  if (block.getFieldValue(`${prefix}_ASSET`) === COORDINATE_TARGET) {
    return { kind: 'coordinate', coordinate: relativeCoordinate(LL, block, `${prefix}_COORDINATE`) };
  }
  return {
    kind: 'image',
    condition: { type: 'image-visible', ...imageTarget(block, `${prefix}_ASSET`), threshold: number(block, `${prefix}_THRESHOLD`) || .9, mask: imageMask(block, `${prefix}_MASK`) },
  };
}
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
    case 'bao_condition_position': return { ...preserved<AutomationCondition>(block), ...positionCompareCondition(LL, block) };
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
  const scalarStep = compileScalarStep(block.type, (name) => block.getFieldValue(name), extra as unknown as Record<string, unknown>);
  if (scalarStep) return scalarStep;
  switch (block.type) {
    case 'bao_wait_image': return { ...extra, type: 'wait-image', ...imageTarget(block), threshold: number(block, 'THRESHOLD'), mask: imageMask(block), timeoutMs: number(block, 'TIMEOUT') } as AutomationStep;
    case 'bao_wait_image_state': return { ...extra, type: 'wait-image-state', ...imageTarget(block), state: block.getFieldValue('STATE') === 'hidden' ? 'hidden' : 'visible', mask: imageMask(block), timeoutMs: number(block, 'TIMEOUT') } as AutomationStep;
    case 'bao_click_image':
      if (block.getFieldValue('ASSET') === COORDINATE_TARGET) return { ...(extra.type === 'click-coordinate' ? extra : {}), type: 'click-coordinate', coordinate: relativeCoordinate(LL, block), button: block.getFieldValue('BUTTON'), clickCount: number(block, 'COUNT') as 1 | 2 | 3 } as AutomationStep;
      return { ...(extra.type === 'click-image' ? extra : {}), type: 'click-image', ...imageTarget(block), threshold: number(block, 'THRESHOLD'), mask: imageMask(block), button: block.getFieldValue('BUTTON'), clickCount: number(block, 'COUNT') as 1 | 2 | 3, verifyBeforeClick: block.getFieldValue('VERIFY') === 'TRUE', maxMovementPx: number(block, 'MOVEMENT') } as AutomationStep;
    case 'bao_move_to_image':
      if (block.getFieldValue('ASSET') === COORDINATE_TARGET) return { ...(extra.type === 'move-to-coordinate' ? extra : {}), type: 'move-to-coordinate', coordinate: relativeCoordinate(LL, block) } as AutomationStep;
      return { ...(extra.type === 'move-to-image' ? extra : {}), type: 'move-to-image', ...imageTarget(block), threshold: number(block, 'THRESHOLD'), mask: imageMask(block) } as AutomationStep;
    case 'bao_drag_image': {
      let source = pointerTarget(LL, block, 'SOURCE');
      let target = pointerTarget(LL, block, 'TARGET');
      const savedLegacySource = extra.type === 'drag-image' ? (extra as { source?: ImageCondition }).source : undefined;
      const savedLegacyTarget = extra.type === 'drag-image' ? (extra as { target?: ImageCondition }).target : undefined;
      const savedDragSource = extra.type === 'drag' ? (extra as { source?: AutomationPointerTarget }).source : undefined;
      const savedDragTarget = extra.type === 'drag' ? (extra as { target?: AutomationPointerTarget }).target : undefined;
      const savedSource = savedLegacySource ?? (savedDragSource?.kind === 'image' ? savedDragSource.condition : undefined);
      const savedTarget = savedLegacyTarget ?? (savedDragTarget?.kind === 'image' ? savedDragTarget.condition : undefined);
      if (source.kind === 'image') source = { kind: 'image', condition: { ...savedSource, ...source.condition } };
      if (target.kind === 'image') target = { kind: 'image', condition: { ...savedTarget, ...target.condition } };
      const options = { button: block.getFieldValue('BUTTON'), durationMs: number(block, 'DURATION'), timeoutMs: number(block, 'TIMEOUT') };
      if (source.kind === 'image' && target.kind === 'image') return {
        ...(extra.type === 'drag-image' ? extra : {}), type: 'drag-image', source: source.condition, target: target.condition, ...options,
      } as AutomationStep;
      return { ...(extra.type === 'drag' ? extra : {}), type: 'drag', source, target, ...options } as AutomationStep;
    }
    case 'bao_key_press': return { ...extra, type: 'key-press', key: String(block.getFieldValue('KEY')) } as AutomationStep;
    case 'bao_key_combo': return { ...extra, type: 'key-press', key: String(block.getFieldValue('KEY')), modifiers: modifiers(block) } as AutomationStep;
    case 'bao_hold_key_until_image': return { ...extra, type: 'key-hold-until-image', key: String(block.getFieldValue('KEY')), ...imageTarget(block), state: block.getFieldValue('STATE') === 'hidden' ? 'hidden' : 'visible', mask: imageMask(block), timeoutMs: number(block, 'TIMEOUT') } as AutomationStep;
    case 'bao_random_click_region': return { ...extra, type: 'random-click-region', region: relativeSearchRegion(LL, block), button: block.getFieldValue('BUTTON'), clickCount: number(block, 'COUNT'), padding: number(block, 'PADDING') } as AutomationStep;
    case 'bao_if_image': return { ...extra, type: 'if-image', condition: { ...(extra.type === 'if-image' ? extra.condition : {}), ...assetCondition(block) }, negate: block.getFieldValue('MODE') === 'missing', then: compileSequence(LL, block.getInputTargetBlock('THEN'), extra.type === 'if-image' ? extra.then : undefined), else: compileSequence(LL, block.getInputTargetBlock('ELSE'), extra.type === 'if-image' ? extra.else : undefined) } as AutomationStep;
    case 'bao_if_condition': return { ...extra, type: 'if-condition', condition: compileCondition(LL, block.getInputTargetBlock('CONDITION')), then: compileSequence(LL, block.getInputTargetBlock('THEN'), extra.type === 'if-condition' ? extra.then : undefined), else: compileSequence(LL, block.getInputTargetBlock('ELSE'), extra.type === 'if-condition' ? extra.else : undefined) } as AutomationStep;
    case 'bao_wait_condition': return { ...extra, type: 'wait-condition', condition: compileCondition(LL, block.getInputTargetBlock('CONDITION')), timeoutMs: number(block, 'TIMEOUT') } as AutomationStep;
    case 'bao_wait_condition_branch': return { ...extra, type: 'wait-condition-branch', condition: compileCondition(LL, block.getInputTargetBlock('CONDITION')), timeoutMs: number(block, 'TIMEOUT'), success: compileSequence(LL, block.getInputTargetBlock('SUCCESS'), extra.type === 'wait-condition-branch' ? extra.success : undefined), timeout: compileSequence(LL, block.getInputTargetBlock('TIMEOUT_BRANCH'), extra.type === 'wait-condition-branch' ? extra.timeout : undefined) } as AutomationStep;
    case 'bao_end': return { ...extra, type: 'end', result: block.getFieldValue('RESULT') === 'failure' ? 'failure' : 'success', message: String(block.getFieldValue('MESSAGE') || '') || undefined } as AutomationStep;
    case 'bao_repeat': return { ...extra, type: 'repeat', times: number(block, 'TIMES'), body: compileSequence(LL, block.getInputTargetBlock('DO'), extra.type === 'repeat' ? extra.body : undefined) } as AutomationStep;
    case 'bao_repeat_until_image': return { ...extra, type: 'repeat-until-image', condition: { ...(extra.type === 'repeat-until-image' ? extra.condition : {}), type: 'image-visible', ...imageTarget(block), mask: imageMask(block) }, until: block.getFieldValue('UNTIL') === 'hidden' ? 'hidden' : 'visible', maxIterations: number(block, 'MAX'), body: compileSequence(LL, block.getInputTargetBlock('DO'), extra.type === 'repeat-until-image' ? extra.body : undefined) } as AutomationStep;
    case 'bao_repeat_until_condition': return { ...extra, type: 'repeat-until-condition', condition: compileCondition(LL, block.getInputTargetBlock('CONDITION')), maxIterations: number(block, 'MAX'), body: compileSequence(LL, block.getInputTargetBlock('DO'), extra.type === 'repeat-until-condition' ? extra.body : undefined) } as AutomationStep;
    case 'bao_position_compare': return { ...extra, type: 'position-compare', targetA: positionCompareTarget(LL, block, 'A'), targetB: positionCompareTarget(LL, block, 'B'), relation: block.getFieldValue('RELATION') || 'vertical', tolerancePx: number(block, 'TOLERANCE') || 10, then: compileSequence(LL, block.getInputTargetBlock('THEN'), extra.type === 'position-compare' ? extra.then : undefined), else: compileSequence(LL, block.getInputTargetBlock('ELSE'), extra.type === 'position-compare' ? extra.else : undefined) } as AutomationStep;
    default: throw new Error(LL.automation.blockly.unsupportedBlock({ type: block.type }));
  }
}

function setField(block: Blockly.Block, name: string, value: unknown): void {
  if (value !== undefined && block.getField(name)) block.setFieldValue(String(value), name);
}

function setPointerTarget(block: Blockly.Block, prefix: 'SOURCE' | 'TARGET', target: AutomationPointerTarget): void {
  if (target.kind === 'coordinate') {
    setField(block, `${prefix}_ASSET`, COORDINATE_TARGET);
    setField(block, `${prefix}_COORDINATE`, `${target.coordinate.x},${target.coordinate.y}`);
  } else {
    setField(block, `${prefix}_ASSET`, imageTargetValue(target.condition));
    setField(block, `${prefix}_THRESHOLD`, target.condition.threshold);
    setField(block, `${prefix}_MASK`, target.condition.mask ?? 'auto');
  }
}

function createStep(LL: ReturnType<typeof useI18nContext>['LL'], workspace: Blockly.WorkspaceSvg, step: AutomationStep): Blockly.BlockSvg {
  if (step.type === 'sequence') throw new Error('sequence cannot be rendered as a statement block');
  const blockType = blockTypeForStep(step);
  const block = workspace.newBlock(blockType); block.initSvg(); block.render();
  preserve(block, step);
  if (writeScalarStepFields(step, (name, value) => setField(block, name, value))) return block;
  switch (step.type) {
    case 'wait-image': setField(block, 'ASSET', imageTargetValue(step)); setField(block, 'THRESHOLD', step.threshold); setField(block, 'MASK', step.mask ?? 'auto'); setField(block, 'TIMEOUT', step.timeoutMs); break;
    case 'wait-image-state': setField(block, 'ASSET', imageTargetValue(step)); setField(block, 'STATE', step.state); setField(block, 'MASK', step.mask ?? 'auto'); setField(block, 'TIMEOUT', step.timeoutMs); break;
    case 'click-image': setField(block, 'ASSET', imageTargetValue(step)); setField(block, 'THRESHOLD', step.threshold); setField(block, 'MASK', step.mask ?? 'auto'); setField(block, 'BUTTON', step.button); setField(block, 'COUNT', step.clickCount); setField(block, 'VERIFY', (step.verifyBeforeClick ?? false) ? 'TRUE' : 'FALSE'); setField(block, 'MOVEMENT', step.maxMovementPx ?? 12); break;
    case 'click-coordinate': setField(block, 'ASSET', COORDINATE_TARGET); setField(block, 'COORDINATE', `${step.coordinate.x},${step.coordinate.y}`); setField(block, 'BUTTON', step.button); setField(block, 'COUNT', step.clickCount); break;
    case 'random-click-region': setField(block, 'TOP_LEFT', `${step.region.left},${step.region.top}`); setField(block, 'BOTTOM_RIGHT', `${step.region.right},${step.region.bottom}`); setField(block, 'BUTTON', step.button ?? 'left'); setField(block, 'COUNT', step.clickCount ?? 2); setField(block, 'PADDING', step.padding ?? 0); break;
    case 'move-to-image': setField(block, 'ASSET', imageTargetValue(step)); setField(block, 'THRESHOLD', step.threshold); setField(block, 'MASK', step.mask ?? 'auto'); break;
    case 'move-to-coordinate': setField(block, 'ASSET', COORDINATE_TARGET); setField(block, 'COORDINATE', `${step.coordinate.x},${step.coordinate.y}`); break;
    case 'drag-image': setField(block, 'SOURCE_ASSET', imageTargetValue(step.source)); setField(block, 'SOURCE_THRESHOLD', step.source.threshold); setField(block, 'SOURCE_MASK', step.source.mask ?? 'auto'); setField(block, 'TARGET_ASSET', imageTargetValue(step.target)); setField(block, 'TARGET_THRESHOLD', step.target.threshold); setField(block, 'TARGET_MASK', step.target.mask ?? 'auto'); setField(block, 'BUTTON', step.button); setField(block, 'DURATION', step.durationMs); setField(block, 'TIMEOUT', step.timeoutMs); break;
    case 'drag': setPointerTarget(block, 'SOURCE', step.source); setPointerTarget(block, 'TARGET', step.target); setField(block, 'BUTTON', step.button); setField(block, 'DURATION', step.durationMs); setField(block, 'TIMEOUT', step.timeoutMs); break;
    case 'key-press':
      setField(block, 'KEY', step.key);
      setField(block, 'ALT', step.modifiers?.includes('alt') ? 'TRUE' : 'FALSE');
      setField(block, 'CONTROL', step.modifiers?.includes('control') ? 'TRUE' : 'FALSE');
      setField(block, 'META', step.modifiers?.includes('meta') ? 'TRUE' : 'FALSE');
      setField(block, 'SHIFT', step.modifiers?.includes('shift') ? 'TRUE' : 'FALSE');
      break;
    case 'key-hold-until-image': setField(block, 'KEY', step.key); setField(block, 'ASSET', imageTargetValue(step)); setField(block, 'STATE', step.state); setField(block, 'MASK', step.mask ?? 'auto'); setField(block, 'TIMEOUT', step.timeoutMs); break;
    case 'if-image': setField(block, 'ASSET', imageTargetValue(step.condition)); setField(block, 'THRESHOLD', step.condition.threshold); setField(block, 'MASK', step.condition.mask ?? 'auto'); setField(block, 'MODE', step.negate ? 'missing' : 'found'); connectSequence(LL, workspace, block, 'THEN', step.then); if (step.else) connectSequence(LL, workspace, block, 'ELSE', step.else); break;
    case 'if-condition': connectCondition(LL, workspace, block, 'CONDITION', step.condition); connectSequence(LL, workspace, block, 'THEN', step.then); if (step.else) connectSequence(LL, workspace, block, 'ELSE', step.else); break;
    case 'wait-condition': connectCondition(LL, workspace, block, 'CONDITION', step.condition); setField(block, 'TIMEOUT', step.timeoutMs); break;
    case 'wait-condition-branch': connectCondition(LL, workspace, block, 'CONDITION', step.condition); setField(block, 'TIMEOUT', step.timeoutMs); connectSequence(LL, workspace, block, 'SUCCESS', step.success); connectSequence(LL, workspace, block, 'TIMEOUT_BRANCH', step.timeout); break;
    case 'end': setField(block, 'RESULT', step.result); setField(block, 'MESSAGE', step.message); break;
    case 'repeat': setField(block, 'TIMES', step.times); connectSequence(LL, workspace, block, 'DO', step.body); break;
    case 'repeat-until-image': setField(block, 'ASSET', imageTargetValue(step.condition)); setField(block, 'UNTIL', step.until); setField(block, 'MASK', step.condition.mask ?? 'auto'); setField(block, 'MAX', step.maxIterations); connectSequence(LL, workspace, block, 'DO', step.body); break;
    case 'repeat-until-condition': connectCondition(LL, workspace, block, 'CONDITION', step.condition); setField(block, 'MAX', step.maxIterations); connectSequence(LL, workspace, block, 'DO', step.body); break;
    case 'position-compare':
      setField(block, 'A_TYPE', step.targetA.kind === 'image' ? 'image' : 'coordinate');
      if (step.targetA.kind === 'image') { setField(block, 'A_ASSET', step.targetA.asset); setField(block, 'A_THRESHOLD', step.targetA.threshold); setField(block, 'A_MASK', step.targetA.mask ?? 'auto'); setField(block, 'A_OFFSET_X', step.targetA.offset?.x ?? 0); setField(block, 'A_OFFSET_Y', step.targetA.offset?.y ?? 0); }
      else setField(block, 'A_COORDINATE', `${step.targetA.coordinate.x},${step.targetA.coordinate.y}`);
      setField(block, 'B_TYPE', step.targetB.kind === 'image' ? 'image' : 'coordinate');
      if (step.targetB.kind === 'image') { setField(block, 'B_ASSET', step.targetB.asset); setField(block, 'B_THRESHOLD', step.targetB.threshold); setField(block, 'B_MASK', step.targetB.mask ?? 'auto'); setField(block, 'B_OFFSET_X', step.targetB.offset?.x ?? 0); setField(block, 'B_OFFSET_Y', step.targetB.offset?.y ?? 0); }
      else setField(block, 'B_COORDINATE', `${step.targetB.coordinate.x},${step.targetB.coordinate.y}`);
      setField(block, 'RELATION', step.relation);
      setField(block, 'TOLERANCE', step.tolerancePx);
      connectSequence(LL, workspace, block, 'THEN', step.then);
      if (step.else) connectSequence(LL, workspace, block, 'ELSE', step.else);
      break;
  }
  return block;
}

function createCondition(LL: ReturnType<typeof useI18nContext>['LL'], workspace: Blockly.WorkspaceSvg, condition: AutomationCondition): Blockly.BlockSvg {
  const type = condition.type === 'image-visible' ? 'bao_condition_image' : condition.type === 'position-relation' ? 'bao_condition_position' : condition.type === 'all' ? 'bao_condition_and' : condition.type === 'any' ? 'bao_condition_or' : 'bao_condition_not';
  const block = workspace.newBlock(type); block.initSvg(); block.render();
  preserve(block, condition);
  if (condition.type === 'image-visible') {
    setField(block, 'ASSET', imageTargetValue(condition)); setField(block, 'THRESHOLD', condition.threshold); setField(block, 'MASK', condition.mask ?? 'auto');
  } else if (condition.type === 'position-relation') {
    setField(block, 'A_TYPE', condition.targetA.kind === 'image' ? 'image' : 'coordinate');
    if (condition.targetA.kind === 'image') { setField(block, 'A_ASSET', condition.targetA.asset); setField(block, 'A_THRESHOLD', condition.targetA.threshold); setField(block, 'A_MASK', condition.targetA.mask ?? 'auto'); setField(block, 'A_OFFSET_X', condition.targetA.offset?.x ?? 0); setField(block, 'A_OFFSET_Y', condition.targetA.offset?.y ?? 0); }
    else setField(block, 'A_COORDINATE', `${condition.targetA.coordinate.x},${condition.targetA.coordinate.y}`);
    setField(block, 'B_TYPE', condition.targetB.kind === 'image' ? 'image' : 'coordinate');
    if (condition.targetB.kind === 'image') { setField(block, 'B_ASSET', condition.targetB.asset); setField(block, 'B_THRESHOLD', condition.targetB.threshold); setField(block, 'B_MASK', condition.targetB.mask ?? 'auto'); setField(block, 'B_OFFSET_X', condition.targetB.offset?.x ?? 0); setField(block, 'B_OFFSET_Y', condition.targetB.offset?.y ?? 0); }
    else setField(block, 'B_COORDINATE', `${condition.targetB.coordinate.x},${condition.targetB.coordinate.y}`);
    setField(block, 'RELATION', condition.relation);
    setField(block, 'TOLERANCE', condition.tolerancePx);
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
    const categoryColours = ['#7b59ad', '#58a966', '#67a153', '#5688a8', '#58a99f', '#ad587b', '#9aaa52'];
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
      const starts = workspace.getTopBlocks(true).filter((block) => block.type === 'bao_start' || block.type === 'bao_start_unconditional' || block.type === 'bao_start_condition' || block.type === 'bao_start_region');
      if (starts.length !== 1) throw new Error(LL.automation.blockly.requireOneStart());
      const source = workflowRef.current;
      const conditional = starts[0].type === 'bao_start';
      const combined = starts[0].type === 'bao_start_condition';
      const regional = starts[0].type === 'bao_start_region';
      const readyAsset = conditional ? String(starts[0].getFieldValue('ASSET') || '').trim() : '';
      const readySource = preserved<ImageCondition>(starts[0]);
      return {
        formatVersion: 1,
        id: source?.id ?? 'new-automation',
        name: source?.name ?? LL.automation.blockly.defaultWorkflowName(),
        description: source?.description,
        ...(regional ? { searchRegion: relativeSearchRegion(LL, starts[0]) } : {}),
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
  const startType = workflow.searchRegion ? 'bao_start_region' : !workflow.readyWhen ? 'bao_start_unconditional' : workflow.readyWhen.type === 'image-visible' ? 'bao_start' : 'bao_start_condition';
  const start = workspace.newBlock(startType); start.initSvg(); start.render();
  if (workflow.searchRegion) { setField(start, 'TOP_LEFT', `${workflow.searchRegion.left},${workflow.searchRegion.top}`); setField(start, 'BOTTOM_RIGHT', `${workflow.searchRegion.right},${workflow.searchRegion.bottom}`); }
  else if (workflow.readyWhen?.type === 'image-visible') { preserve(start, workflow.readyWhen); setField(start, 'ASSET', imageTargetValue(workflow.readyWhen)); setField(start, 'THRESHOLD', workflow.readyWhen.threshold ?? .9); setField(start, 'MASK', workflow.readyWhen.mask ?? 'auto'); }
  else if (workflow.readyWhen) connectCondition(LL, workspace, start, 'CONDITION', workflow.readyWhen);
  connectSequence(LL, workspace, start, 'DO', workflow.root);
  start.moveBy(36, 30);
}

export default AutomationBlocklyEditor;
