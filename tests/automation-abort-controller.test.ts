import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createAutomationAbortController } from '../src/shared/automation/abort-controller';

afterEach(() => vi.unstubAllGlobals());

describe('automation AbortController compatibility', () => {
  it('provides cancellation on Electron 11 / Node 12 without a native AbortController', () => {
    vi.stubGlobal('AbortController', undefined);
    const controller = createAutomationAbortController();
    const listener = vi.fn();
    controller.signal.addEventListener('abort', listener);
    controller.abort();
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('uses the native implementation when available', () => {
    const controller = createAutomationAbortController();
    expect(controller).toBeInstanceOf(AbortController);
  });

  it('does not bypass the Electron 11 compatibility factory in Automation runtime code', () => {
    const root = path.resolve(__dirname, '..', 'src');
    const files = [
      'main/modules/automation/browserview-core-session.ts',
      'main/modules/automation/javascript-capability-broker.ts',
      'main/modules/automation/ocr-benchmark.ts',
      'shared/automation/core/workflow-runtime.ts',
    ];
    for (const file of files) expect(fs.readFileSync(path.join(root, file), 'utf8')).not.toMatch(/new\s+AbortController\s*\(/u);
  });
});
