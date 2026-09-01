import { test, expect } from 'playwright/test';
import { launchApp, closeApp } from './helpers/launch';

test.describe('browser shell', () => {
  test('starts and renders the shell UI', async () => {
    const app = await launchApp();
    try {
      const window = await app.firstWindow();
      await window.waitForLoadState('domcontentloaded');
      await expect(window.locator('.topbar-tabbar')).toBeVisible();
      await expect(window.locator('.sidebar-toggle-button')).toBeVisible();
      await expect(window.locator('.address-bookmark-button')).toBeVisible();
      await expect(window.locator('.address-input')).toBeVisible();
    } finally {
      await closeApp(app);
    }
  });

  test('new tab button adds a tab and close restores the count', async () => {
    const app = await launchApp();
    try {
      const window = await app.firstWindow();
      await window.waitForLoadState('domcontentloaded');
      // The initial tab is created asynchronously after hydration; wait for
      // it instead of assuming it exists at domcontentloaded.
      await expect(window.locator('.tab-item').first()).toBeVisible({ timeout: 15_000 });
      const countBefore = await window.locator('.tab-item').count();
      await window.locator('.btn-tab.no-drag').first().click();
      await expect(window.locator('.tab-item')).toHaveCount(countBefore + 1);
      await window.locator('.tab-close').last().click();
      await expect(window.locator('.tab-item')).toHaveCount(countBefore);
    } finally {
      await closeApp(app);
    }
  });

  test('bookmarking an internal page shows the favorite in the sidebar', async () => {
    const app = await launchApp();
    try {
      const window = await app.firstWindow();
      await window.waitForLoadState('domcontentloaded');
      // The initial tab is created asynchronously after hydration; wait until
      // it settles to exactly one tab before navigating, otherwise the async
      // creation can steal the active tab mid-flight (the workbench renders
      // only when the active tab's URL is about:automation).
      await expect(window.locator('.tab-item')).toHaveCount(1, { timeout: 15_000 });
      // about:newtab cannot be bookmarked by design; navigate to an
      // internal renderer page first, then bookmark it.
      const address = window.locator('.address-input');
      await address.fill('about:automation');
      await address.press('Enter');
      await expect(window.locator('.automation-workbench-v3')).toBeVisible({ timeout: 15_000 });
      // Wait for the address bar to reflect the navigation so the bookmark
      // toggle targets about:automation instead of the still-active newtab.
      await expect(address).toHaveValue('about:automation', { timeout: 10_000 });
      await window.locator('.address-bookmark-button').click();
      // The success toast is the reliable signal that the bookmark landed.
      await expect(window.locator('.toast-overlay')).toBeVisible({ timeout: 10_000 });
      await expect(window.locator('.toast-message')).toContainText('已收藏', { timeout: 10_000 });
      await window.locator('.sidebar-toggle-button').click();
      await expect(window.locator('.fav-item').first()).toBeVisible({ timeout: 10_000 });
    } finally {
      await closeApp(app);
    }
  });

  test('automation workbench is reachable via the address bar', async () => {
    const app = await launchApp();
    try {
      const window = await app.firstWindow();
      await window.waitForLoadState('domcontentloaded');
      // Same race guard as the bookmarking test above.
      await expect(window.locator('.tab-item')).toHaveCount(1, { timeout: 15_000 });
      const address = window.locator('.address-input');
      await address.fill('about:automation');
      await address.press('Enter');
      await expect(window.locator('.automation-workbench-v3')).toBeVisible({ timeout: 15_000 });
    } finally {
      await closeApp(app);
    }
  });
});
