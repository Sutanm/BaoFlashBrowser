import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Blockly from 'blockly';
import { registerAutomationV2Blocks } from '../src/renderer/components/automation/automation-blockly-v2-schema';

const OVERWRITE_WARNING = 'overwrites previous definition';
const ASSETS = ['buy.png'];

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

/** Registering for a locale intentionally replaces the definitions, so build the
 *  block after registering and read the options off the refreshed definition. */
function resultTypeOptionsFor(locale: 'en' | 'zh-CN'): string[][] {
  registerAutomationV2Blocks(locale, ASSETS, []);
  const call = new Blockly.Workspace().newBlock('bao2_call_script');
  return (call.getField('RESULT_TYPE') as Blockly.FieldDropdown).getOptions(false) as unknown as string[][];
}

function labelsOf(options: string[][]): string[] {
  return options.map(([label]) => label);
}
function valuesOf(options: string[][]): string[] {
  return options.map(([, value]) => value);
}

const EXPECTED_VALUES = ['number', 'string', 'boolean', 'null'];

describe('Automation 2.0 callScript RESULT_TYPE localization', () => {
  it('localizes the result type labels for English', () => {
    const options = resultTypeOptionsFor('en');
    expect(labelsOf(options)).toEqual(['number', 'text', 'boolean', 'nothing']);
    expect(valuesOf(options)).toEqual(EXPECTED_VALUES);
  });

  it('localizes the result type labels for Chinese', () => {
    const options = resultTypeOptionsFor('zh-CN');
    expect(labelsOf(options)).toEqual(['数字', '文字', '布尔', '空值']);
    expect(valuesOf(options)).toEqual(EXPECTED_VALUES);
  });

  it('keeps the language-neutral values stable so saved workflows keep their meaning', () => {
    // The stored value is what the codec reads/writes; only the visible label may
    // change with the locale.
    expect(valuesOf(resultTypeOptionsFor('en'))).toEqual(valuesOf(resultTypeOptionsFor('zh-CN')));
  });

  it('does not redefine blocks when the locale repeats', () => {
    registerAutomationV2Blocks('zh-CN', ASSETS, []);
    const warnings = overwriteWarningsDuring(() => registerAutomationV2Blocks('zh-CN', ASSETS, []));
    expect(warnings).toEqual([]);
  });
});