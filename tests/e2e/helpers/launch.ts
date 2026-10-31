import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { _electron as electron, type ElectronApplication } from 'playwright';

const DIST_MAIN = path.join(__dirname, '..', '..', '..', 'dist', 'main.js');

/**
 * Launch the project's own Electron 11 with the built main bundle.
 *
 * Key details:
 * - Linux CI requires --no-sandbox; Windows does not.
 * - The build toolchain may export ELECTRON_RUN_AS_NODE=1 so the Electron
 *   binary is reused for plain Node scripts. Playwright launches Electron as
 *   an application; Electron treats the variable's PRESENCE as "run as Node"
 *   (any value, including '0'), so it must be deleted, not zeroed.
 * - Each launch defaults to a fresh temporary --user-data-dir. Restart tests
 *   may reuse their own temporary profile with profilePath: the app persists
 *   bookmarks/history/etc. in IndexedDB under its userData profile, so
 *   sharing the real profile across tests would leak state between runs.
 */
export async function launchApp(profilePath?: string, showLanguageSelection = false): Promise<ElectronApplication> {
  const args = [DIST_MAIN];
  if (process.platform === 'linux') args.unshift('--no-sandbox');
  const profile = profilePath ?? path.join(os.tmpdir(), `bao-e2e-${crypto.randomBytes(6).toString('hex')}`);
  args.push(`--user-data-dir=${profile}`);
  const env: Record<string, string> = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.BAO_E2E = '1';
  const app = await electron.launch({ args, env });
  if (!showLanguageSelection) {
    try {
      const page = await app.firstWindow();
      await page.locator('#first-run-language, .topbar-tabbar').first().waitFor({ timeout: 15000 });
      if (await page.locator('#first-run-language').isVisible()) {
        await page.locator('.first-run-dialog button[type="submit"]').click();
      }
    } catch (error) {
      await closeApp(app);
      throw error;
    }
  }
  return app;
}

export async function closeApp(app: ElectronApplication): Promise<void> {
  await app.close().catch(() => undefined);
}
