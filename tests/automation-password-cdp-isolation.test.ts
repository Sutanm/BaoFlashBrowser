import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tabsSource = readFileSync(new URL('../src/main/modules/tabs.ts', import.meta.url), 'utf8');

describe('Automation password-CDP isolation', () => {
  it('pauses delayed password fill retries while a tab is reserved by Automation', () => {
    const begin = tabsSource.slice(
      tabsSource.indexOf('beginAutomation('),
      tabsSource.indexOf('private _applyAutomationViewport'),
    );
    expect(begin.indexOf('this._clearPasswordFillTimers(wc.id)')).toBeGreaterThan(-1);
    expect(begin.indexOf('this._clearPasswordFillTimers(wc.id)')).toBeLessThan(begin.indexOf('teardownCapture(wc)'));
    expect(begin).toContain('this._schedulePasswordFill(wc, tabId)');
  });

  it('does not start automatic or manual password fill during an Automation run', () => {
    expect(tabsSource).toMatch(/_attemptPasswordFill[\s\S]*?this\.automationTargets\.has\(tabId\)/u);
    expect(tabsSource).toMatch(/_schedulePasswordFill[\s\S]*?this\.automationTargets\.has\(tabId\)/u);
    expect(tabsSource).toMatch(/notifyPasswordFormDetected[\s\S]*?this\.automationTargets\.has\(tabId\)/u);
    expect(tabsSource).toMatch(/fillPassword\(tabId[\s\S]*?this\.automationTargets\.has\(tabId\)/u);
  });
});
