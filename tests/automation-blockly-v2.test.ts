import { beforeAll, describe, expect, it } from 'vitest';
import * as Blockly from 'blockly';
import { AUTOMATION_V2_BLOCK_COUNT, AUTOMATION_V2_BLOCK_TYPES, automationV2Toolbox, registerAutomationV2Blocks } from '../src/renderer/components/automation/automation-blockly-v2-schema';
import { AutomationBlocklyV2CodecError, workflowV3ToWorkspace, workspaceToWorkflowV3 } from '../src/renderer/components/automation/automation-blockly-v2-codec';
import { decodeGameSurfaceFeature, encodeGameSurfaceFeature, validateWorkflowDocument } from '../src/shared/automation/core';

beforeAll(() => registerAutomationV2Blocks('en', ['buy.png', 'states/idle.png', 'states/active.png']));

function connectValue(parent: Blockly.Block, name: string, child: Blockly.Block): void {
  parent.getInput(name)!.connection!.connect(child.outputConnection!);
}

const FEATURE = encodeGameSurfaceFeature({ version: 1, kind: 'flash', label: 'Game', source: 'https://example.com/game.swf', frameUrl: 'https://example.com/play', width: 960, height: 540 });

function connectEntry(workspace: Blockly.Workspace, first: Blockly.Block, type: 'bao2_entry_unconditional' | 'bao2_entry_region' | 'bao2_entry_game' = 'bao2_entry_unconditional'): Blockly.Block {
  const entry = workspace.newBlock(type);
  if (type === 'bao2_entry_game') entry.setFieldValue(FEATURE, 'GAME_SURFACE');
  entry.getInput('BODY')!.connection!.connect(first.previousConnection!);
  return entry;
}

describe('Blockly 2.0 frontend contract', () => {
  it('keeps Action and Locator orthogonal while exposing ordinary-user capabilities', () => {
    expect(AUTOMATION_V2_BLOCK_COUNT).toBe(38);
    expect(AUTOMATION_V2_BLOCK_COUNT).toBeLessThanOrEqual(40);
    expect(AUTOMATION_V2_BLOCK_TYPES.filter((type) => ['bao2_action_click', 'bao2_action_move', 'bao2_action_drag'].includes(type))).toEqual([
      'bao2_action_click', 'bao2_action_move', 'bao2_action_drag',
    ]);
    expect(AUTOMATION_V2_BLOCK_TYPES).not.toContain('bao2_click_image');
    expect(AUTOMATION_V2_BLOCK_TYPES).not.toContain('bao2_click_text');
    expect(AUTOMATION_V2_BLOCK_TYPES).not.toContain('bao2_click_coordinate');
    expect(AUTOMATION_V2_BLOCK_TYPES).toEqual(expect.arrayContaining([
      'bao2_wait_target', 'bao2_query_read_text', 'bao2_query_read_number',
      'bao2_action_key_press', 'bao2_action_type_text', 'bao2_action_scroll',
      'bao2_action_navigate', 'bao2_action_reload', 'bao2_action_log', 'bao2_action_notify',
      'bao2_entry_unconditional', 'bao2_entry_region', 'bao2_entry_game',
      'bao2_call_script', 'bao2_forever',
    ]));
  });

  it('compiles Click + Image Locator directly to Workflow IR v3', () => {
    const workspace = new Blockly.Workspace();
    const click = workspace.newBlock('bao2_action_click');
    const image = workspace.newBlock('bao2_locator_image');
    image.setFieldValue('buy.png', 'ASSET');
    connectValue(click, 'TARGET', image);
    connectEntry(workspace, click);
    const workflow = workspaceToWorkflowV3(workspace, { id: 'buy', name: 'Buy' });
    expect(workflow).toMatchObject({ formatVersion: 3, root: { kind: 'sequence', nodes: [
      { kind: 'action', action: { kind: 'click', target: { locator: { kind: 'image', asset: 'buy.png' } } } },
    ] } });
    expect(() => validateWorkflowDocument(workflow)).not.toThrow();
  });

  it('compiles a directory image group into one locator with alternatives', () => {
    const workspace = new Blockly.Workspace();
    const click = workspace.newBlock('bao2_action_click');
    const image = workspace.newBlock('bao2_locator_image');
    const options = (image.getField('ASSET') as Blockly.FieldDropdown).getOptions(false);
    const group = options.find(([label]) => String(label).includes('states'));
    expect(group).toBeTruthy();
    image.setFieldValue(String(group![1]), 'ASSET');
    connectValue(click, 'TARGET', image);
    connectEntry(workspace, click);

    expect(workspaceToWorkflowV3(workspace, { id: 'group', name: 'Group' }).root).toMatchObject({
      nodes: [{ action: { target: { locator: { kind: 'image', asset: 'states/active.png', alternatives: ['states/idle.png'] } } } }],
    });
  });

  it('keeps action targets empty by default and exposes separate Locator choices', () => {
    const definition = automationV2Toolbox('zh-CN');
    const toolbox = JSON.stringify(definition);
    expect(toolbox).toContain('鼠标');
    expect(toolbox).toContain('图片与文字识别');
    expect((toolbox.match(/bao2_action_click/g) ?? []).length).toBe(1);
    expect(toolbox).not.toContain('"inputs":{"TARGET"');
    expect(toolbox).toContain('bao2_locator_image');
    expect(toolbox).toContain('bao2_locator_text');
    expect(toolbox).toContain('bao2_locator_coordinate');
  });

  it('accepts a captured relative coordinate as one pasteable x,y field', () => {
    const workspace = new Blockly.Workspace();
    const click = workspace.newBlock('bao2_action_click');
    const coordinate = workspace.newBlock('bao2_locator_coordinate');
    coordinate.setFieldValue('400，7061', 'COORDINATE');
    connectValue(click, 'TARGET', coordinate); connectEntry(workspace, click);
    const workflow = workspaceToWorkflowV3(workspace, { id: 'paste-coordinate', name: 'Paste coordinate' });
    expect(workflow.root).toMatchObject({ kind: 'sequence', nodes: [{ action: { target: { locator: { point: { x: .04, y: .7061 } } } } }] });

    const restored = new Blockly.Workspace(); workflowV3ToWorkspace(restored, workflow);
    expect(restored.getBlocksByType('bao2_locator_coordinate', false)[0].getFieldValue('COORDINATE')).toBe('400,7061');
  });

  it('round-trips Context, control flow, variables and Coordinate Locator', () => {
    const workspace = new Blockly.Workspace();
    const letBlock = workspace.newBlock('bao2_let'); letBlock.setFieldValue('times', 'NAME');
    const two = workspace.newBlock('bao2_literal_number'); two.setFieldValue('2', 'VALUE'); connectValue(letBlock, 'VALUE', two);
    const repeat = workspace.newBlock('bao2_repeat');
    const variable = workspace.newBlock('bao2_variable'); variable.setFieldValue('times', 'NAME'); connectValue(repeat, 'COUNT', variable);
    const move = workspace.newBlock('bao2_action_move'); const coordinate = workspace.newBlock('bao2_locator_coordinate');
    coordinate.setFieldValue('2500,7500', 'COORDINATE'); connectValue(move, 'TARGET', coordinate);
    connectEntry(workspace, letBlock, 'bao2_entry_game');
    letBlock.nextConnection!.connect(repeat.previousConnection!);
    repeat.getInput('BODY')!.connection!.connect(move.previousConnection!);
    const first = workspaceToWorkflowV3(workspace, { id: 'roundtrip', name: 'Roundtrip' });
    expect(first.root).toMatchObject({ kind: 'with', surface: { kind: 'visual', visualHint: 'flash', fingerprint: FEATURE } });
    expect(() => validateWorkflowDocument(first)).not.toThrow();

    const restored = new Blockly.Workspace();
    workflowV3ToWorkspace(restored, first);
    const second = workspaceToWorkflowV3(restored, { id: 'roundtrip', name: 'Roundtrip' });
    expect(JSON.stringify(second)).toContain('"kind":"coordinate"');
    expect(JSON.stringify(second)).toContain('"kind":"with"');
    expect(() => validateWorkflowDocument(second)).not.toThrow();
  });

  it('round-trips an ordinary-user forever loop without exposing a condition input', () => {
    const workspace = new Blockly.Workspace();
    const forever = workspace.newBlock('bao2_forever');
    const wait = workspace.newBlock('bao2_wait');
    const duration = workspace.newBlock('bao2_literal_number'); duration.setFieldValue('100', 'VALUE'); connectValue(wait, 'DURATION', duration);
    forever.getInput('BODY')!.connection!.connect(wait.previousConnection!);
    connectEntry(workspace, forever);

    const first = workspaceToWorkflowV3(workspace, { id: 'forever', name: 'Forever' });
    expect(first.root).toMatchObject({ kind: 'sequence', nodes: [{ kind: 'loop', mode: 'forever' }] });
    expect(() => validateWorkflowDocument(first)).not.toThrow();
    const restored = new Blockly.Workspace(); workflowV3ToWorkspace(restored, first);
    expect(restored.getBlocksByType('bao2_forever', false)).toHaveLength(1);
  });

  it('compiles the three ordinary-user entry modes without exposing a viewport dropdown', () => {
    const regionWorkspace = new Blockly.Workspace();
    const wait = regionWorkspace.newBlock('bao2_action_reload');
    const regionEntry = connectEntry(regionWorkspace, wait, 'bao2_entry_region');
    regionEntry.setFieldValue('100,200', 'TOP_LEFT'); regionEntry.setFieldValue('5100,6200', 'BOTTOM_RIGHT');
    expect(workspaceToWorkflowV3(regionWorkspace, { id: 'region', name: 'Region' }).root).toMatchObject({
      kind: 'with', region: { unit: 'ratio', x: .01, y: .02, width: .5, height: .6 },
    });

    const gameWorkspace = new Blockly.Workspace();
    connectEntry(gameWorkspace, gameWorkspace.newBlock('bao2_action_reload'), 'bao2_entry_game');
    const game = workspaceToWorkflowV3(gameWorkspace, { id: 'game', name: 'Game' });
    expect(decodeGameSurfaceFeature((game.root as { surface: { fingerprint: string } }).surface.fingerprint)).toMatchObject({ source: 'https://example.com/game.swf' });
    const toolbox = JSON.stringify(automationV2Toolbox('zh-CN'));
    expect(toolbox).not.toContain('bao2_entry"');
    expect(toolbox).not.toContain('页面视口');
  });

  it('rejects disconnected required Locator inputs', () => {
    const workspace = new Blockly.Workspace();
    const click = workspace.newBlock('bao2_action_click');
    connectEntry(workspace, click);
    expect(() => workspaceToWorkflowV3(workspace, { id: 'bad', name: 'Bad' })).toThrowError(AutomationBlocklyV2CodecError);
  });
});
