import { defineConfig } from 'playwright/test';

/**
 * BaoFlashBrowser e2e — drives the project's own locked Electron 11 via
 * _electron.launch. Assertions target the React shell UI only: Electron 11
 * BrowserView contents are not reachable through Playwright's DOM APIs.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
  },
});
