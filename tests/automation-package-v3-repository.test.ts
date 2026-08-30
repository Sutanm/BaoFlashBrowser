import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { AutomationPackageV3Repository } from '../src/main/modules/automation/package-v3-repository';
import { serializeAutomationPackageV3 } from '../src/main/modules/automation/package-v3';
import type { AutomationPackageV3 } from '../src/shared/automation/package-v3';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => fs.promises.rm(directory, { recursive: true, force: true }))); });

function packageSource(id = 'demo'): AutomationPackageV3 {
  return {
    manifest: { format: 'baoauto', formatVersion: 3, id, name: 'Demo', frontends: { workflow: 'workflow.json', scripts: [] }, features: [], integrity: {} },
    workflow: { formatVersion: 3, id: `${id}-workflow`, name: 'Workflow', root: { id: 'root', kind: 'sequence', nodes: [] } },
    scripts: new Map(), assets: new Map(), profiles: new Map(),
  };
}

describe('Automation v3 repository', () => {
  it('persists, reloads, replaces and deletes only .baoauto v3 packages', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'baoauto-v3-repo-')); directories.push(directory);
    const repository = new AutomationPackageV3Repository(directory);
    await repository.initialize();
    await repository.install(serializeAutomationPackageV3(packageSource()));
    expect(repository.list()[0]).toMatchObject({ packageId: 'demo', frontends: [{ id: 'workflow', kind: 'blockly' }] });
    await expect(repository.install(serializeAutomationPackageV3(packageSource()))).rejects.toThrow('already exists');

    const reloaded = new AutomationPackageV3Repository(directory);
    await reloaded.initialize();
    expect(reloaded.get('demo').workflow?.name).toBe('Workflow');
    const changed = packageSource();
    await reloaded.save({ ...changed, workflow: { ...changed.workflow!, name: 'Changed' } });
    const savedAgain = new AutomationPackageV3Repository(directory); await savedAgain.initialize();
    expect(savedAgain.get('demo').workflow?.name).toBe('Changed');
    await reloaded.remove('demo');
    expect(reloaded.list()).toEqual([]);
  });

  it('reports but never migrates an old or invalid stored package', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'baoauto-v3-rejected-')); directories.push(directory);
    await fs.promises.writeFile(path.join(directory, 'old.baoauto'), 'old format');
    const rejected: string[] = [];
    const repository = new AutomationPackageV3Repository(directory, (filePath) => rejected.push(path.basename(filePath)));
    await repository.initialize();
    expect(repository.list()).toEqual([]);
    expect(rejected).toEqual(['old.baoauto']);
    expect(await fs.promises.readFile(path.join(directory, 'old.baoauto'), 'utf8')).toBe('old format');
  });
});
