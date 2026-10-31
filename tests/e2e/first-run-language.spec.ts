import { test, expect } from 'playwright/test';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { launchApp, closeApp } from './helpers/launch';

test('first launch chooses a language and restart skips onboarding', async () => {
  const profile = path.join(os.tmpdir(), `bao-language-${crypto.randomBytes(6).toString('hex')}`);
  let app = await launchApp(profile, true);
  try {
    let page = await app.firstWindow();
    await expect(page.locator('#first-run-language')).toBeVisible();
    await expect(page.locator('.topbar-tabbar')).toHaveCount(0);
    await page.locator('#first-run-language').selectOption('en');
    await expect(page.getByRole('heading', { name: 'Choose your language' })).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.locator('.topbar-tabbar')).toBeVisible();
    await closeApp(app);

    app = await launchApp(profile, true);
    page = await app.firstWindow();
    await expect(page.locator('.topbar-tabbar')).toBeVisible();
    await expect(page.locator('#first-run-language')).toHaveCount(0);
    const language = await page.evaluate(() => new Promise<string>((resolve, reject) => {
      const request = indexedDB.open('BaoFlashDB');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const get = database.transaction('settingsSingleton').objectStore('settingsSingleton').get('default');
        get.onsuccess = () => { resolve(get.result.language); database.close(); };
        get.onerror = () => { reject(get.error); database.close(); };
      };
    }));
    expect(language).toBe('en');
  } finally {
    await closeApp(app);
  }
});
