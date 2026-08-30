import { describe, expect, it } from 'vitest';
import { AutomationRecorderError, compileRecorderEventsV3, validateWorkflowDocument } from '../src/shared/automation/core';

describe('Automation Recorder v3', () => {
  it('emits Action × CoordinateLocator and Surface context directly as v3 IR', () => {
    const workflow = compileRecorderEventsV3([
      { timestampMs: 100, kind: 'click', point: { unit: 'ratio', x: 0.25, y: 0.5 }, context: { surface: { kind: 'named', name: 'game' } } },
      { timestampMs: 500, kind: 'drag', from: { unit: 'logical', x: 10, y: 20 }, to: { unit: 'logical', x: 30, y: 40 }, context: { surface: { kind: 'named', name: 'game' } } },
    ], { id: 'recorded', name: 'Recorded', waitThresholdMs: 250 });

    expect(workflow.formatVersion).toBe(3);
    expect(workflow.root).toMatchObject({ kind: 'sequence', nodes: [
      { kind: 'with', surface: { kind: 'named', name: 'game' }, body: { kind: 'action', action: { kind: 'click', target: { locator: { kind: 'coordinate' } } } } },
      { kind: 'wait', durationMs: { value: 400 } },
      { kind: 'with', body: { kind: 'action', action: { kind: 'drag', from: { locator: { kind: 'coordinate' } }, to: { locator: { kind: 'coordinate' } } } } },
    ] });
    expect(() => validateWorkflowDocument(workflow)).not.toThrow();
    expect(JSON.stringify(workflow)).not.toMatch(/click-image|click-text|click-coordinate|coordinateSpace/);
  });

  it('drops noisy move events by default and can preserve them explicitly', () => {
    const events = [{ timestampMs: 0, kind: 'move' as const, point: { unit: 'logical' as const, x: 1, y: 2 } }];
    expect((compileRecorderEventsV3(events, { id: 'a', name: 'A' }).root as { nodes: unknown[] }).nodes).toHaveLength(0);
    expect((compileRecorderEventsV3(events, { id: 'b', name: 'B', recordMoves: true }).root as { nodes: unknown[] }).nodes).toHaveLength(1);
  });

  it('rejects stale ordering and invalid ratio coordinates', () => {
    expect(() => compileRecorderEventsV3([
      { timestampMs: 2, kind: 'click', point: { unit: 'logical', x: 1, y: 1 } },
      { timestampMs: 1, kind: 'click', point: { unit: 'logical', x: 1, y: 1 } },
    ], { id: 'bad', name: 'Bad' })).toThrowError(AutomationRecorderError);
    expect(() => compileRecorderEventsV3([
      { timestampMs: 1, kind: 'click', point: { unit: 'ratio', x: 2, y: 0 } },
    ], { id: 'bad-point', name: 'Bad point' })).toThrow('inside [0,1]');
  });
});
