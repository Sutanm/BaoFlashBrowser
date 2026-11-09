import { test, expect } from 'playwright/test';
import os from 'os';
import fs from 'fs';
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
    // 第二步：是否开启密码本。系统验证可用时是"启用/暂不启用"，否则是密码框 + 跳过；
    // 两种形态下"不启用"这条路都挂在 #first-run-vault-skip 上。
    await expect(page.getByRole('heading', { name: 'Enable the password vault' })).toBeVisible();
    await page.locator('#first-run-vault-skip').click();
    await expect(page.locator('.topbar-tabbar')).toBeVisible();
    await closeApp(app);
    // 跳过 = 密码本默认关闭。
    const store = JSON.parse(fs.readFileSync(path.join(profile, 'password-store.json'), 'utf8'));
    expect(store._enabled).toBe(false);

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

test('enabling the vault in the wizard creates an initialized, enabled vault', async () => {
  const profile = path.join(os.tmpdir(), `bao-vault-${crypto.randomBytes(6).toString('hex')}`);
  const app = await launchApp(profile, true);
  try {
    const page = await app.firstWindow();
    await page.locator('#first-run-language').selectOption('en');
    await page.getByRole('button', { name: 'Continue' }).click();
    // 等第二步形态确定：探测未完成时会先显示 loading，密码框/按钮都还不在。
    await page.locator('#first-run-vault-skip').waitFor({ timeout: 20000 });
    const passwordField = page.locator('#first-run-vault-password');
    if (await passwordField.isVisible()) {
      // C 档（无系统钥匙串）：要设查看密码，按钮由 Skip 变确认。
      await passwordField.fill('secret12');
      const confirm = page.getByRole('button', { name: 'Confirm and enable' });
      await expect(confirm).toBeVisible();
      await confirm.click();
    } else {
      // A 档（win-dpapi 可用）：不问查看密码，只问"要不要"。
      await expect(page.getByRole('button', { name: 'Not now' })).toBeVisible();
      await page.getByRole('button', { name: 'Enable vault' }).click();
    }
    await expect(page.locator('.topbar-tabbar')).toBeVisible();
  } finally {
    await closeApp(app);
  }
  // 主进程侧落盘证据：vault 已建立（DEK 密文存在）且未被禁用。
  const store = JSON.parse(fs.readFileSync(path.join(profile, 'password-store.json'), 'utf8'));
  expect(store.dekAutoFillEnc).toBeTruthy();
  expect(store._enabled).not.toBe(false);
});
