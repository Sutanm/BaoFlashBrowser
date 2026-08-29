import { describe, expect, it } from 'vitest';
import * as Blockly from 'blockly';
import { GameSurfaceFeatureField } from '../src/renderer/components/automation/AutomationBlocklyEditor';

describe('automation game surface Blockly field', () => {
  it('is clickable so Blockly opens the clipboard importer', () => {
    const field = new GameSurfaceFeatureField();
    Blockly.Blocks.bao_test_game_surface_field = { init() {} };
    const workspace = new Blockly.Workspace();
    const block = new Blockly.Block(workspace, 'bao_test_game_surface_field');
    block.appendDummyInput().appendField(field, 'GAME_SURFACE');

    expect(field.EDITABLE).toBe(true);
    expect(field.SERIALIZABLE).toBe(true);
    expect(field.CURSOR).toBe('pointer');
    expect(field.isClickable()).toBe(true);
    expect(field.isClickableInFlyout(true)).toBe(true);

    workspace.dispose();
    delete Blockly.Blocks.bao_test_game_surface_field;
  });
});
