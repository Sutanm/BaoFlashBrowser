import { test, expect } from 'playwright/test';
import { launchApp, closeApp } from './helpers/launch';
import fs from 'fs';
import os from 'os';
import path from 'path';

test('save folders are centralized in settings and show full paths', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-folders-e2e-'));
  const app = await launchApp(profile);
  try {
    const page = await app.firstWindow();
    await page.locator('.sidebar-toggle-button').click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.locator('.settings-category-row').filter({ hasText: '下载与截图' }).click();
    const downloads = await page.evaluate(() => window.electronAPI.dl.getDir());
    const screenshots = await page.evaluate(() => window.electronAPI.screenshot.getDir());
    await expect(page.getByText(downloads, { exact: true })).toBeVisible();
    await expect(page.getByText(screenshots, { exact: true })).toBeVisible();
    const chosen = path.join(os.tmpdir(), 'bao-folders-selected');
    fs.mkdirSync(chosen, { recursive: true });
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
    }, chosen);
    await page.getByRole('region', { name: '下载保存目录' }).getByRole('button', { name: '选择目录', exact: true }).click();
    await expect(page.getByText(chosen, { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('save-folders.png') });
    await page.locator('.sidebar-toggle-button').click();
    await expect(page.locator('.library-sidebar')).toHaveCount(0);
    await page.locator('.sidebar-toggle-button').click();
    await page.getByRole('tab', { name: '下载', exact: true }).click();
    await expect(page.getByRole('button', { name: '打开下载文件夹', exact: true })).toHaveAttribute('title', chosen);
    const engineStatus = page.getByRole('status', { name: '引擎', exact: true });
    await expect(engineStatus).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('aria2:status', { ready: false });
    });
    await expect(engineStatus).toContainText('Chromium');
    await expect(engineStatus).toContainText('aria2 不可用');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('aria2:status', { ready: true });
    });
    await expect(engineStatus).toContainText('aria2');
    await expect(engineStatus).toContainText('就绪');
    await expect(page.getByRole('button', { name: '选择下载目录', exact: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('downloads.png') });
  } finally { await closeApp(app); }
});
