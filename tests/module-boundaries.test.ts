import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const source = (relativePath: string): string => readFileSync(path.join(root, relativePath), 'utf8');

describe('optional module boundaries', () => {
  it('keeps session-manager independent from optional implementations', () => {
    const code = source('src/main/modules/session-manager.ts');
    expect(code).not.toMatch(/from ['"]\.\/(?:download|js-patch-service|userscripts)['"]/u);
  });

  it('keeps tabs independent from passwords, userscripts and automation implementations', () => {
    const code = source('src/main/modules/tabs.ts');
    expect(code).not.toMatch(/^import (?!type).*from ['"]\.\/(?:password|userscripts|automation)/mu);
  });

  it('keeps generic config IPC independent from userscripts', () => {
    const code = source('src/main/ipc/config.ipc.ts');
    expect(code).not.toMatch(/from ['"]\.\.\/modules\/userscripts/u);
  });

  it('keeps automation assistant channels in the explicit bridge', () => {
    const genericIpc = source('src/main/ipc/userscripts.ipc.ts');
    const bridgeIpc = source('src/main/ipc/automation-userscript-bridge.ipc.ts');
    expect(genericIpc).not.toContain('userscript:automation-v3-');
    expect(bridgeIpc).toContain('userscript:automation-v3-start');
    expect(bridgeIpc).toContain('userscript:automation-v3-surfaces');
  });

  it('allows the automation script deletion channel through the main-window preload', () => {
    const preload = source('src/preload/index.ts');
    const allowlist = preload.slice(
      preload.indexOf('const ALLOWED_INVOKE_CHANNELS'),
      preload.indexOf('const ALLOWED_SEND_CHANNELS'),
    );
    expect(allowlist).toContain("'automation-v3:delete-script'");
  });

  it('guards optional settings UI and save fields with build capabilities', () => {
    const panel = source('src/renderer/components/panels/SettingsPanel.tsx');
    expect(panel).toContain('if (!MODULE_PASSWORDS) return;');
    expect(panel).toContain("activeSection === 'privacy' && MODULE_PASSWORDS");
    expect(panel).toContain("activeSection === 'automation' && MODULE_AUTOMATION");
    expect(panel).toContain("activeSection === 'downloads' && MODULE_DOWNLOAD");
    expect(panel).toContain("activeSection === 'advanced' && MODULE_USERSCRIPTS");
    expect(panel).toContain('{MODULE_DIAGNOSTICS && (');
  });

  it('limits config defaults and validation to enabled modules', () => {
    const config = source('src/main/modules/config.ts');
    const configIpc = source('src/main/ipc/config.ipc.ts');
    for (const flag of ['MODULE_DOWNLOAD', 'MODULE_USERSCRIPTS', 'MODULE_AUTOMATION']) {
      expect(config).toContain(`...(${flag} ? {`);
      expect(configIpc).toContain(`...(${flag} ? {`);
    }
  });

  it('anchors electron-builder file globs before optional dependency exclusions', () => {
    const builder = source('build/electron-builder.config.cjs');
    const positiveGlob = builder.indexOf("'dist/**/*'");
    const opencvExclusion = builder.indexOf("'!node_modules/@techstark/opencv-js{,/**/*}'");
    expect(positiveGlob).toBeGreaterThan(-1);
    expect(opencvExclusion).toBeGreaterThan(positiveGlob);
  });
});
