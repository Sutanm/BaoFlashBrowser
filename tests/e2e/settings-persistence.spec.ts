import { test, expect } from 'playwright/test';
import type { Page } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, closeApp } from './helpers/launch';

async function openSettings(page: Page) {
  await expect(page.locator('.tab-item').first()).toBeVisible();
  await page.locator('.sidebar-toggle-button').click();
  await page.getByRole('button', { name: /^(设置|Settings)$/ }).click();
  await page.locator('.settings-category-row').first().click();
}

// Wait for durable storage, not merely the optimistic saved notification.
async function persistedSettings(page: Page) {
  return page.evaluate(() => new Promise<{ searchEngine?: string; language?: string; themeMode?: string }>((resolve, reject) => {
    const request = indexedDB.open('BaoFlashDB');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('settingsSingleton', 'readonly');
      const read = transaction.objectStore('settingsSingleton').get('default');
      transaction.oncomplete = () => { db.close(); resolve(read.result || {}); };
      transaction.onerror = () => { db.close(); reject(transaction.error); };
    };
  }));
}

test('search engine, language and theme survive an application restart', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-settings-e2e-'));
  let app = await launchApp(profile);
  try {
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(profile);
    let page = await app.firstWindow();
    await openSettings(page);
    // Establish the old key first so switching engines exercises the regression.
    await page.locator('.settings-save-button').click();
    await expect.poll(async () => (await persistedSettings(page)).searchEngine).toBe('bing');
    await page.locator('select').filter({ has: page.locator('option[value="google"]') }).selectOption('google');
    await page.locator('select').filter({ has: page.locator('option[value="en"]') }).selectOption('en');
    await page.locator('.settings-save-button').click();
    await expect.poll(async () => (await persistedSettings(page)).searchEngine).toBe('google');
    await expect.poll(async () => (await persistedSettings(page)).language).toBe('en');
    // The compact theme switch is present in the shell regardless of settings section.
    const theme = page.locator('.theme-toggle').first();
    const desiredTheme = await theme.getAttribute('aria-checked') === 'true' ? 'light' : 'dark';
    await theme.click();
    await expect.poll(async () => (await persistedSettings(page)).themeMode).toBe(desiredTheme);
    await closeApp(app);
    app = await launchApp(profile);
    page = await app.firstWindow();
    await openSettings(page);
    await expect(page.locator('select').filter({ has: page.locator('option[value="google"]') })).toHaveValue('google');
    await expect(page.locator('select').filter({ has: page.locator('option[value="en"]') })).toHaveValue('en');
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.locator('.theme-toggle').first()).toHaveAttribute('aria-checked', String(desiredTheme === 'dark'));
  } finally { await closeApp(app); }
});
