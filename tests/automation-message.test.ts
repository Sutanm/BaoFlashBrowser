import { describe, expect, it, vi } from 'vitest';
import type { AutomationMessage } from '../src/shared/automation/types';
import type { TranslationFunctions } from '../src/renderer/i18n/i18n-types';
import { loadAllLocales } from '../src/renderer/i18n/i18n-util.sync';
import { i18nObject } from '../src/renderer/i18n/i18n-util';
import { resolveAutomationMessage } from '../src/renderer/components/automation/automation-message';

const ll = {
  automation: {
    service: {
      state: { visible: () => 'appears', hidden: () => 'disappears' },
      status: {
        checkingAsset: vi.fn((p: { asset: string }) => `Testing ${p.asset}`),
        assetMatch: vi.fn((p: { score: string }) => `score ${p.score}%`),
        assetNoMatch: vi.fn((p: { asset: string }) => `no ${p.asset}`),
        readyCheckFailed: vi.fn((p: { detail: string }) => `check failed ${p.detail}`),
        runFailed: vi.fn((p: { detail: string }) => `run failed ${p.detail}`),
        assetTestStopped: vi.fn((p: { detail: string }) => `stopped ${p.detail}`),
        assetTestFailed: vi.fn((p: { detail: string }) => `failed ${p.detail}`),
        stepNext: vi.fn(() => 'next'),
        scriptCompleted: vi.fn(() => 'done'),
        scriptStopped: vi.fn(() => 'stopped'),
        imageMatch: vi.fn((p: { asset: string; score: string; totalMs: string; captureMs: string; matchMs: string }) => `img ${p.asset} ${p.score}% ${p.totalMs}ms`),
        pausedNext: vi.fn((p: { step: string }) => `paused next ${p.step}`),
      },
      step: {
        sequence: vi.fn(() => 'sequence'),
        waitImage: vi.fn((p: { asset: string }) => `wait ${p.asset}`),
        waitImageState: vi.fn((p: { asset: string; state: string }) => `wait ${p.state} ${p.asset}`),
        clickImage: vi.fn((p: { asset: string }) => `click ${p.asset}`),
        clickCoordinate: vi.fn((p: { x: number; y: number }) => `click ${p.x},${p.y}`),
        moveToImage: vi.fn((p: { asset: string }) => `move ${p.asset}`),
        dragImage: vi.fn((p: { source: string; target: string }) => `drag ${p.source} to ${p.target}`),
        delay: vi.fn((p: { ms: number }) => `delay ${p.ms}`),
        keyPress: vi.fn((p: { key: string }) => `key ${p.key}`),
        keyHoldUntilImage: vi.fn((p: { key: string; state: string; asset: string }) => `hold ${p.key} ${p.state} ${p.asset}`),
        textInput: vi.fn(() => 'type'),
        scroll: vi.fn(() => 'scroll'),
        navigate: vi.fn(() => 'navigate'),
        reload: vi.fn(() => 'reload'),
        log: vi.fn((p: { message: string }) => `log ${p.message}`),
        ifImage: vi.fn((p: { asset: string }) => `if ${p.asset}`),
        repeat: vi.fn((p: { times: number }) => `repeat ${p.times}`),
        repeatUntilImage: vi.fn((p: { asset: string }) => `until ${p.asset}`),
      },
    },
  },
} as unknown as TranslationFunctions;

describe('resolveAutomationMessage', () => {
  it('resolves raw text', () => {
    expect(resolveAutomationMessage({ key: 'raw', params: { text: 'hello' } }, ll)).toBe('hello');
  });
  it('translates status messages with params', () => {
    expect(resolveAutomationMessage({ key: 'status.checkingAsset', params: { asset: 'a.png' } }, ll)).toBe('Testing a.png');
  });
  it('translates step messages and localizes the visible/hidden state', () => {
    expect(resolveAutomationMessage({ key: 'step.waitImageState', params: { asset: 'a.png', state: 'visible' } }, ll)).toBe('wait appears a.png');
    expect(resolveAutomationMessage({ key: 'step.waitImageState', params: { asset: 'a.png', state: 'hidden' } }, ll)).toBe('wait disappears a.png');
  });
  it('resolves nested pausedNext step recursively', () => {
    expect(resolveAutomationMessage({ key: 'status.pausedNext', params: { step: { key: 'step.clickImage', params: { asset: 'b.png' } } } }, ll)).toBe('paused next click b.png');
  });
});

describe('resolveAutomationMessage against real dictionaries', () => {
  it('resolves every message key to non-empty text in both locales', () => {
    loadAllLocales();
    const cases: AutomationMessage[] = [
      { key: 'status.checkingAsset', params: { asset: 'a.png' } },
      { key: 'status.assetMatch', params: { score: '85.0' } },
      { key: 'status.assetNoMatch', params: { asset: 'a.png' } },
      { key: 'status.readyCheckFailed', params: { detail: 'x' } },
      { key: 'status.runFailed', params: { detail: 'x' } },
      { key: 'status.assetTestStopped', params: { detail: 'x' } },
      { key: 'status.assetTestFailed', params: { detail: 'x' } },
      { key: 'status.stepNext' },
      { key: 'status.scriptCompleted' },
      { key: 'status.scriptStopped' },
      { key: 'status.imageMatch', params: { asset: 'a.png', score: '85.0', totalMs: '18', captureMs: '5', matchMs: '10' } },
      { key: 'status.randomClickCoordinate', params: { x: 5000, y: 4000 } },
      { key: 'status.pausedNext', params: { step: { key: 'step.clickImage', params: { asset: 'b.png' } } } },
      { key: 'step.sequence' },
      { key: 'step.waitImage', params: { asset: 'a.png' } },
      { key: 'step.waitImageState', params: { asset: 'a.png', state: 'visible' } },
      { key: 'step.clickImage', params: { asset: 'a.png' } },
      { key: 'step.clickCoordinate', params: { x: 5000, y: 2500 } },
      { key: 'step.randomClickRegion' },
      { key: 'step.moveToImage', params: { asset: 'a.png' } },
      { key: 'step.moveToCoordinate', params: { x: 6000, y: 3500 } },
      { key: 'step.dragImage', params: { source: 'a.png', target: 'b.png' } },
      { key: 'step.drag' },
      { key: 'step.delay', params: { ms: 500 } },
      { key: 'step.keyPress', params: { key: 'Enter' } },
      { key: 'step.keyHoldUntilImage', params: { key: 'Space', state: 'hidden', asset: 'a.png' } },
      { key: 'step.textInput' },
      { key: 'step.scroll' },
      { key: 'step.navigate' },
      { key: 'step.reload' },
      { key: 'step.log', params: { message: 'hi' } },
      { key: 'step.ifImage', params: { asset: 'a.png' } },
      { key: 'step.repeat', params: { times: 2 } },
      { key: 'step.repeatUntilImage', params: { asset: 'a.png' } },
      { key: 'step.waitConditionBranch' },
      { key: 'step.end', params: { result: 'failure', message: 'x' } },
      { key: 'raw', params: { text: 'raw' } },
    ];
    for (const locale of ['en', 'zh-CN'] as const) {
      const LL = i18nObject(locale) as unknown as TranslationFunctions;
      for (const msg of cases) {
        const out = resolveAutomationMessage(msg, LL);
        expect(out).toBeTruthy();
        expect(out).not.toMatch(/^\{/); // no un-interpolated {param}
      }
    }
  });
});
