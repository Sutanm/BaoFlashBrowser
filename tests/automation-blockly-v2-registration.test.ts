import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Blockly from 'blockly';
import { registerAutomationV2Blocks } from '../src/renderer/components/automation/automation-blockly-v2-schema';
import { workflowV3ToWorkspace, workspaceToWorkflowV3 } from '../src/renderer/components/automation/automation-blockly-v2-codec';
import type { WorkflowDocumentV3 } from '../src/shared/automation/core';

const OVERWRITE_WARNING = 'overwrites previous definition';
const ASSETS = ['buy.png', 'states/idle.png', 'states/active.png'];

/**
 * Every test that changes the locale/option signature intentionally replaces the
 * block definitions, and Blockly reports each replacement on console.warn. That
 * is the designed behaviour, so keep those messages out of the reporter while
 * still failing loudly on anything unexpected.
 */
const consoleWarn = { captured: [] as string[] };

beforeAll(() => {
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    consoleWarn.captured.push(args.map(String).join(' '));
  });
});

afterAll(() => vi.restoreAllMocks());

/** Overwrite warnings produced while `run` executes. */
function overwriteWarningsDuring(run: () => void): string[] {
  const from = consoleWarn.captured.length;
  run();
  return consoleWarn.captured.slice(from).filter((message) => message.includes(OVERWRITE_WARNING));
}

function scriptOptionValues(): string[] {
  const call = new Blockly.Workspace().newBlock('bao2_call_script');
  return (call.getField('SCRIPT') as Blockly.FieldDropdown).getOptions(false).map(([, value]) => value);
}

function assetOptionValues(workspace = new Blockly.Workspace()): string[] {
  const image = workspace.newBlock('bao2_locator_image');
  return (image.getField('ASSET') as Blockly.FieldDropdown).getOptions(false).map(([, value]) => value);
}

describe('Automation 2.0 block registration', () => {
  it('does not redefine blocks when locale and options are unchanged', () => {
    registerAutomationV2Blocks('en', ASSETS, []);
    const warnings = overwriteWarningsDuring(() => {
      registerAutomationV2Blocks('en', ASSETS, []);
      registerAutomationV2Blocks('en', ASSETS, []);
    });
    expect(warnings).toEqual([]);
  });

  it('re-registers when the script list changes so the new script is selectable', () => {
    registerAutomationV2Blocks('en', ASSETS, []);
    expect(scriptOptionValues()).not.toContain('main');

    registerAutomationV2Blocks('en', ASSETS, ['main']);
    expect(scriptOptionValues()).toContain('main');
  });

  it('re-registers when the asset list changes so the new asset is selectable', () => {
    registerAutomationV2Blocks('en', ASSETS, []);
    expect(assetOptionValues()).not.toContain('extra.png');

    registerAutomationV2Blocks('en', [...ASSETS, 'extra.png'], []);
    expect(assetOptionValues()).toContain('extra.png');
  });
});

describe('Automation 2.0 codec keeps references the package no longer provides', () => {
  it('preserves a script id whose script was deleted instead of silently dropping it', () => {
    registerAutomationV2Blocks('en', ASSETS, []);
    const document: WorkflowDocumentV3 = {
      formatVersion: 3,
      id: 'calls-deleted-script',
      name: 'Calls a deleted script',
      root: {
        kind: 'sequence',
        id: 'root',
        nodes: [
          {
            kind: 'callScript',
            id: 'call',
            scriptId: 'deleted-script',
            arguments: [],
            assignTo: 'result',
            valueType: 'number',
          },
        ],
      },
    };

    const workspace = new Blockly.Workspace();
    const warnings = overwriteWarningsDuring(() => workflowV3ToWorkspace(workspace, document));
    const call = workspace.getBlocksByType('bao2_call_script', false)[0];

    // Before the fix Blockly rejected this value and the reference was lost.
    expect(call.getFieldValue('SCRIPT')).toBe('deleted-script');
    expect(call.getFieldValue('RESULT_TYPE')).toBe('number');
    expect(warnings.filter((message) => message.includes('unavailable option'))).toEqual([]);

    const compiled = workspaceToWorkflowV3(workspace, { id: document.id, name: document.name });
    const node = (compiled.root as { nodes: Array<{ kind: string; scriptId?: string }> }).nodes[0];
    expect(node).toMatchObject({ kind: 'callScript', scriptId: 'deleted-script' });
  });
});