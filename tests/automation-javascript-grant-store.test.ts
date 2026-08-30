import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { JavaScriptAutomationGrantStore } from '../src/main/modules/automation/javascript-grant-store';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true }))); });

describe('JavaScript automation install grants', () => {
  it('persists outside the package and never exceeds manifest permissions', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bao-js-grants-')); roots.push(root); const file = path.join(root, 'grants.json');
    const first = new JavaScriptAutomationGrantStore(file); await first.initialize(); await first.approve('demo', 'main', ['input', 'log'], ['log']);
    const second = new JavaScriptAutomationGrantStore(file); await second.initialize(); expect(second.get('demo', 'main')).toEqual(['log']);
    await expect(second.approve('demo', 'main', ['log'], ['notify'])).rejects.toThrow('exceeds requested');
    await second.remove('demo'); expect(second.get('demo', 'main')).toEqual([]);
  });
});
