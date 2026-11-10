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

  // 2026-11-10 真机：广告密集页的 did-stop-loading 能晚几十秒，捕获若只在那里挂载，
  // 用户在加载期间完成登录就完全不会被捕获（日志里 23 秒内没有任何 setupCapture）。
  // 现在 did-finish-load（主文档 load 后）先武装，did-stop-loading 兜底，一次导航只一次。
  it('arms capture as early as did-finish-load, once per navigation', () => {
    const section = tabsSource.slice(
      tabsSource.indexOf("wc.on('did-finish-load'"),
      tabsSource.indexOf('const updateUrl = '),
    );
    // dom-ready 先武装（文档可交互即可），load 事件可能被广告拖住几十秒
    expect(tabsSource).toContain("armCaptureForLoadedPage('dom-ready')");
    expect(section).toContain("wc.on('did-finish-load'");
    expect(section).toContain('armCaptureForLoadedPage(\'did-finish-load\')');
    expect(section).toContain("wc.on('did-stop-loading'");
    expect(section).toContain('armCaptureForLoadedPage(\'did-stop-loading\')');
    // 两个入口共用同一个"只武装一次"的守卫
    expect(tabsSource).toMatch(/armCaptureForLoadedPage[\s\S]*?if \(captureArmed\) return;/u);
    // 新一次主框架导航重置守卫
    expect(tabsSource).toMatch(/did-start-navigation[\s\S]*?captureArmed = false;/u);
  });

  it('does not start automatic or manual password fill during an Automation run', () => {    expect(tabsSource).toMatch(/_attemptPasswordFill[\s\S]*?this\.automationTargets\.has\(tabId\)/u);
    expect(tabsSource).toMatch(/_schedulePasswordFill[\s\S]*?this\.automationTargets\.has\(tabId\)/u);
    expect(tabsSource).toMatch(/notifyPasswordFormDetected[\s\S]*?this\.automationTargets\.has\(tabId\)/u);
    expect(tabsSource).toMatch(/fillPassword\(tabId[\s\S]*?this\.automationTargets\.has\(tabId\)/u);
  });
});

