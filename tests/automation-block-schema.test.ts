import { describe, expect, it } from 'vitest';
import type { AutomationStep } from '../src/shared/automation/types';
import { blockTypeForStep, compileScalarStep, writeScalarStepFields } from '../src/renderer/components/automation/automation-block-schema';

describe('automation block schema', () => {
  const cases: AutomationStep[] = [
    { type: 'delay', durationMs: 250 },
    { type: 'text-input', text: 'Bao', intervalMs: 12 },
    { type: 'scroll', deltaX: -10, deltaY: 480 },
    { type: 'navigate', url: 'https://example.com/' },
    { type: 'reload' },
    { type: 'log', message: 'done' },
    { type: 'notification', title: 'title', body: 'body' },
  ];

  it.each(cases)('round-trips scalar step $type through one field schema', (step) => {
    const fields = new Map<string, unknown>();
    expect(writeScalarStepFields(step, (name, value) => fields.set(name, value))).toBe(true);
    expect(compileScalarStep(blockTypeForStep(step as Exclude<AutomationStep, { type: 'sequence' }>), (name) => fields.get(name))).toEqual(step);
  });

  it('selects the modifier block variant without duplicating the step map', () => {
    expect(blockTypeForStep({ type: 'key-press', key: 'A' })).toBe('bao_key_press');
    expect(blockTypeForStep({ type: 'key-press', key: 'A', modifiers: ['control'] })).toBe('bao_key_combo');
  });

  it('maps forever and break flow steps to their Blockly blocks', () => {
    expect(blockTypeForStep({ type: 'forever', body: { type: 'sequence', steps: [] } })).toBe('bao_forever');
    expect(blockTypeForStep({ type: 'break' })).toBe('bao_break');
  });
});
