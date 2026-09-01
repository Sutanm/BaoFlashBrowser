import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/modules/tabs', () => ({ tabManager: {} }));
vi.mock('../src/main/modules/automation/browserview-core-session', () => ({
  BrowserViewAutomationCoreSession: class {},
}));

import { AutomationV3Service } from '../src/main/modules/automation/service-v3';

function source(options: { mainEntryId?: string; referencedScript?: string } = {}) {
  return {
    manifest: {
      format: 'baoauto' as const,
      formatVersion: 3 as const,
      id: 'package',
      name: '测试自动化',
      frontends: {
        workflow: 'workflow.json' as const,
        scripts: [
          { id: 'first', name: '脚本一', path: 'scripts/first.ts' as const, language: 'typescript' as const, permissions: ['log' as const] },
          { id: 'second', name: '脚本二', path: 'scripts/second.js' as const, language: 'javascript' as const, permissions: [] },
        ],
        mainEntryId: options.mainEntryId ?? 'workflow',
      },
      features: [] as const,
      integrity: {},
    },
    workflow: {
      formatVersion: 3 as const,
      id: 'workflow',
      name: '主流程',
      root: options.referencedScript
        ? { id: 'call', kind: 'callScript' as const, scriptId: options.referencedScript, arguments: [] }
        : { id: 'root', kind: 'sequence' as const, nodes: [] },
    },
    scripts: new Map([['scripts/first.ts', 'first'], ['scripts/second.js', 'second']]),
    assets: new Map(),
    profiles: new Map([
      ['profiles/first.json', { id: 'first-profile', name: '脚本一配置', entryId: 'first' }],
      ['profiles/workflow.json', { id: 'workflow-profile', name: '主流程配置', entryId: 'workflow' }],
    ]),
  };
}

function createService(initial: ReturnType<typeof source>) {
  let current = initial;
  const repository = {
    initialize: async () => undefined,
    get: () => current,
    save: vi.fn(async (next: typeof current) => { current = next; }),
  };
  const grants = {
    initialize: async () => undefined,
    get: () => [],
    removeEntry: vi.fn(async () => undefined),
  };
  return {
    service: new AutomationV3Service(repository as never, grants as never),
    repository,
    grants,
    current: () => current,
  };
}

describe('Automation 2.0 deletion', () => {
  it('deletes a reusable script, its profiles and its permission grant', async () => {
    const harness = createService(source());
    const detail = await harness.service.removeScript('package', 'first');

    expect(detail.scripts.map((entry) => entry.id)).toEqual(['second']);
    expect(harness.current().scripts.has('scripts/first.ts')).toBe(false);
    expect([...harness.current().profiles.keys()]).toEqual(['profiles/workflow.json']);
    expect(harness.grants.removeEntry).toHaveBeenCalledWith('package', 'first');
  });

  it('falls back to the Blockly workflow when deleting the current main script', async () => {
    const harness = createService(source({ mainEntryId: 'first' }));
    const detail = await harness.service.removeScript('package', 'first');

    expect(detail.mainEntryId).toBe('workflow');
    expect(harness.current().manifest.frontends.mainEntryId).toBe('workflow');
  });

  it('refuses to delete a script that is still referenced by Blockly', async () => {
    const harness = createService(source({ referencedScript: 'first' }));

    await expect(harness.service.removeScript('package', 'first')).rejects.toThrow('仍被 Blockly');
    expect(harness.repository.save).not.toHaveBeenCalled();
    expect(harness.grants.removeEntry).not.toHaveBeenCalled();
  });
});
