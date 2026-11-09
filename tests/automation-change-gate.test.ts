import { describe, expect, it } from 'vitest';
import { ChangeGate } from '../src/main/modules/automation/change-gate';

describe('change gate', () => {
  it('第一次观察总是 changed', () => {
    const gate = new ChangeGate();
    expect(gate.observe('q', 7)).toEqual({ changed: true, streak: 0, skipped: 0 });
  });

  it('连续相同的指纹记为 unchanged，streak 递增', () => {
    const gate = new ChangeGate();
    gate.observe('q', 7);
    expect(gate.observe('q', 7)).toEqual({ changed: false, streak: 1, skipped: 1 });
    expect(gate.observe('q', 7)).toEqual({ changed: false, streak: 2, skipped: 2 });
  });

  it('指纹一变就重置 streak', () => {
    const gate = new ChangeGate();
    gate.observe('q', 7);
    gate.observe('q', 7); // 记一次 skipped
    // skipped 是"该 key 累计因画面未变而跳过的次数"，变化本身不算跳过
    expect(gate.observe('q', 8)).toEqual({ changed: true, streak: 0, skipped: 1 });
    expect(gate.observe('q', 8)).toEqual({ changed: false, streak: 1, skipped: 2 });
  });

  it('不同 key 互不影响', () => {
    const gate = new ChangeGate();
    gate.observe('a', 1);
    gate.observe('a', 1);
    expect(gate.observe('b', 1)).toEqual({ changed: true, streak: 0, skipped: 0 });
    expect(gate.observe('a', 1)).toEqual({ changed: false, streak: 2, skipped: 2 });
  });

  it('未变化不足阈值时保持基础轮询间隔', () => {
    const gate = new ChangeGate({ after: 3, factor: 2, maxMs: 1000 });
    gate.observe('q', 1);
    expect(gate.nextPollDelayMs('q', 100)).toBe(100); // streak 0
    gate.observe('q', 1);
    expect(gate.nextPollDelayMs('q', 100)).toBe(100); // streak 1
    gate.observe('q', 1);
    expect(gate.nextPollDelayMs('q', 100)).toBe(100); // streak 2
  });

  it('超过阈值后按 factor 指数退避，并受 maxMs 封顶', () => {
    const gate = new ChangeGate({ after: 3, factor: 2, maxMs: 800 });
    gate.observe('q', 1);
    for (let i = 0; i < 3; i += 1) gate.observe('q', 1); // streak = 3
    expect(gate.nextPollDelayMs('q', 100)).toBe(200);
    gate.observe('q', 1); // streak 4
    expect(gate.nextPollDelayMs('q', 100)).toBe(400);
    gate.observe('q', 1); // streak 5
    expect(gate.nextPollDelayMs('q', 100)).toBe(800);
    gate.observe('q', 1); // streak 6 → 理论 1600，封顶 800
    expect(gate.nextPollDelayMs('q', 100)).toBe(800);
  });

  it('画面一变，退避立即回到基础间隔', () => {
    const gate = new ChangeGate({ after: 1, factor: 4, maxMs: 1000 });
    gate.observe('q', 1);
    gate.observe('q', 1);
    gate.observe('q', 1);
    expect(gate.nextPollDelayMs('q', 50)).toBeGreaterThan(50);
    gate.observe('q', 2);
    expect(gate.nextPollDelayMs('q', 50)).toBe(50);
  });

  it('未知 key 返回基础间隔', () => {
    const gate = new ChangeGate({ after: 1, factor: 4, maxMs: 1000 });
    expect(gate.nextPollDelayMs('unknown', 80)).toBe(80);
  });

  it('reset 与 stats 可用', () => {
    const gate = new ChangeGate();
    gate.observe('a', 1);
    gate.observe('a', 1);
    gate.observe('b', 2);
    expect(gate.stats()).toEqual({ keys: 2, skipped: 1 });
    gate.reset('a');
    expect(gate.stats().keys).toBe(1);
    gate.reset();
    expect(gate.stats()).toEqual({ keys: 0, skipped: 0 });
  });

  it('非法退避参数直接抛错', () => {
    expect(() => new ChangeGate({ after: 0 })).toThrow();
    expect(() => new ChangeGate({ factor: 0.5 })).toThrow();
    expect(() => new ChangeGate({ maxMs: 0 })).toThrow();
  });
});
