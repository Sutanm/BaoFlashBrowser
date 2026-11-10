import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tabsSource = readFileSync(new URL('../src/main/modules/tabs.ts', import.meta.url), 'utf8');

describe('Automation password-CDP isolation', () => {
  it('pauses delayed password fill retries while a tab is reserved by Automation', () => {
    const begin = tabsSource.slice(
      tabsSource.indexOf('beginAutomation('),
      tabsSource.indexOf('private _applyAutomationViewport'),
    );
    // teardown 现在带原因参数（自动化占位），因此只匹配到左括号为止。
    const teardownAt = begin.indexOf('passwordCapture.teardown(wc');
    expect(teardownAt).toBeGreaterThan(-1);
    expect(begin.indexOf('this._clearPasswordFillTimers(wc.id)')).toBeLessThan(teardownAt);
    expect(begin).toContain('this._schedulePasswordFill(wc, tabId)');
  });

  it('does not start automatic or manual password fill during an Automation run', () => {
    expect(tabsSource).toMatch(/_attemptPasswordFill[\s\S]*?this\.automationTargets\.has\(tabId\)/u);
    expect(tabsSource).toMatch(/_schedulePasswordFill[\s\S]*?this\.automationTargets\.has\(tabId\)/u);
    expect(tabsSource).toMatch(/notifyPasswordFormDetected[\s\S]*?this\.automationTargets\.has\(tabId\)/u);
    expect(tabsSource).toMatch(/fillPassword\(tabId[\s\S]*?this\.automationTargets\.has\(tabId\)/u);
  });
});
