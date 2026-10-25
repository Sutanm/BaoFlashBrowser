import { test, expect } from 'playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, closeApp } from './helpers/launch';

test('proxy settings save, test in isolation and apply to both sessions after restart', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-proxy-e2e-'));
  let app = await launchApp(profile);
  try {
    let page = await app.firstWindow();
    await expect(page.locator('.tab-item').first()).toBeVisible();
    await page.locator('.sidebar-toggle-button').click();
    await page.getByRole('button', { name: /^(设置|Settings)$/ }).click();
    await page.locator('.settings-category-row').filter({ hasText: '网络代理' }).click();
    await expect(page.locator('#proxy-mode')).toHaveValue('system');
    await page.locator('#proxy-mode').selectOption('manual');
    await page.locator('#proxy-host').fill('127.0.0.1');
    await page.locator('#proxy-port').fill('1');
    await page.locator('#proxy-bypass').fill('*.example.com');
    await page.locator('#proxy-test-url').fill('http://bao-proxy-e2e.invalid/');
    await page.getByRole('button', { name: '检测当前填写的配置' }).click();
    await expect(page.getByRole('status')).toContainText('连接未成功');
    expect((await page.evaluate(() => window.electronAPI.config.get()))?.proxy.mode).toBe('system');
    await page.screenshot({ path: test.info().outputPath('proxy-settings.png') });
    await page.locator('.settings-save-button').click();
    await expect.poll(async () => (await page.evaluate(() => window.electronAPI.config.get()))?.proxy.mode).toBe('manual');
    // Saving must not change active sessions until restart.
    expect(await app.evaluate(async ({ session }) => session.defaultSession.resolveProxy('http://bao-proxy-e2e.invalid/'))).not.toBe('PROXY 127.0.0.1:1');
    await closeApp(app);
    app = await launchApp(profile);
    page = await app.firstWindow();
    await expect(page.locator('.tab-item').first()).toBeVisible();
    const routes = await app.evaluate(async ({ session }) => Promise.all(
      [session.defaultSession, session.fromPartition('persist:')].map((sess) => sess.resolveProxy('http://bao-proxy-e2e.invalid/')),
    ));
    expect(routes).toEqual(['PROXY 127.0.0.1:1', 'PROXY 127.0.0.1:1']);
    await page.locator('.sidebar-toggle-button').click();
    await page.getByRole('button', { name: /^(设置|Settings)$/ }).click();
    await page.locator('.settings-category-row').filter({ hasText: '网络代理' }).click();
    await expect(page.locator('#proxy-host')).toHaveValue('127.0.0.1');
    await expect(page.locator('#proxy-bypass')).toHaveValue('*.example.com');
  } finally { await closeApp(app); }
});
