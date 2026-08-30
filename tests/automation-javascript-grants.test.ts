import { describe, expect, it } from 'vitest';
import { createJavaScriptInstallGrant, createJavaScriptRunGrant, validateJavaScriptAutomationManifest } from '../src/shared/automation/javascript-grants';

describe('JavaScript automation grants', () => {
  const manifest = { entry: 'scripts/trade.js', permissions: ['vision', 'ocr', 'input'] as const };

  it('creates a run grant only inside manifest and install grants', () => {
    const install = createJavaScriptInstallGrant('trade', manifest, ['vision', 'ocr']);
    const run = createJavaScriptRunGrant(install, 'run-1', ['vision']);
    expect([...run.capabilities]).toEqual(['vision']);
    expect(() => (run.capabilities as Set<string>).add('input')).toThrow('immutable');
    expect(() => createJavaScriptRunGrant(install, 'run-2', ['input'])).toThrow('exceeds install grant');
  });

  it('does not let install approval add an unrequested capability', () => {
    expect(() => createJavaScriptInstallGrant('trade', manifest, ['notify'])).toThrow('exceeds manifest');
  });

  it('rejects unknown permissions and unsafe entry paths', () => {
    expect(() => validateJavaScriptAutomationManifest({ entry: '../escape.js', permissions: [] })).toThrow('package-relative');
    expect(() => validateJavaScriptAutomationManifest({ entry: 'main.js', permissions: ['node' as never] })).toThrow('unknown');
  });
});
