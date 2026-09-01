import path from 'path';
import { _electron as electron, type ElectronApplication } from 'playwright';

const DIST_MAIN = path.join(__dirname, '..', '..', '..', 'dist', 'main.js');

/**
 * Launch the project's own Electron 11 with the built main bundle.
 * Linux CI requires --no-sandbox; Windows does not. The app holds a
 * single-instance lock, so e2e runs must be serial (workers: 1).
 */
export async function launchApp(): Promise<ElectronApplication> {
  const args = [DIST_MAIN];
  if (process.platform === 'linux') args.unshift('--no-sandbox');
  // The build toolchain may export ELECTRON_RUN_AS_NODE=1 so the Electron
  // binary is reused for plain Node scripts. Playwright launches Electron as
  // an application; Electron treats the variable's PRESENCE as "run as Node"
  // (any value, including '0'), so it must be deleted, not zeroed.
  const env: Record<string, string> = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.BAO_E2E = '1';
  const app = await electron.launch({ args, env });
  return app;
}

export async function closeApp(app: ElectronApplication): Promise<void> {
  await app.close().catch(() => undefined);
}
