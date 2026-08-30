import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  ready: Promise.resolve() as Promise<void>,
  released: false,
  log: undefined as undefined | ((message: string, level?: 'debug' | 'info' | 'warn' | 'error') => void),
  resolve: undefined as undefined | ((value: unknown) => void),
}));

vi.mock('../src/main/modules/tabs', () => ({
  tabManager: {
    beginAutomation: () => ({
      ready: harness.ready,
      release: () => { harness.released = true; },
    }),
  },
}));

vi.mock('../src/main/modules/automation/browserview-core-session', () => ({
  BrowserViewAutomationCoreSession: class {
    constructor(_tab: unknown, _source: unknown, _profile: unknown, log: typeof harness.log) { harness.log = log; }
    startWorkflow() {
      const completion = new Promise((resolve) => { harness.resolve = resolve; });
      return {
        runId: 'run-test', completion, state: 'running',
        history: [
          { kind: 'node-start', at: 1, nodeId: 'strange-internal-id', nodeKind: 'action' },
          { kind: 'node-end', at: 2, nodeId: 'strange-internal-id', nodeKind: 'action' },
        ],
        subscribe: () => () => undefined,
        cancel: async () => ({ status: 'cancelled', runId: 'run-test', executedNodes: 1, durationMs: 1, reason: 'cancelled by user' }),
      };
    }
    startJavaScript() { throw new Error('not used'); }
    async close() { harness.released = true; }
  },
}));

import { AutomationV3Service } from '../src/main/modules/automation/service-v3';

const source = {
  manifest: { id: 'package', name: '测试流程', frontends: { workflow: 'workflow.json', scripts: [], mainEntryId: 'workflow' } },
  workflow: {
    formatVersion: 3,
    id: 'workflow',
    name: '测试流程',
    root: {
      id: 'root', kind: 'sequence', nodes: [
        { id: 'strange-internal-id', kind: 'action', action: { kind: 'log', message: '开始运行' } },
      ],
    },
  },
  scripts: new Map(), assets: new Map(), profiles: new Map(),
};

function service(): AutomationV3Service {
  const repository = { initialize: async () => undefined, get: () => source };
  const grants = { initialize: async () => undefined, get: () => [] };
  return new AutomationV3Service(repository as never, grants as never);
}

describe('Automation 2.0 run status', () => {
  beforeEach(() => {
    harness.ready = Promise.resolve(); harness.released = false; harness.log = undefined; harness.resolve = undefined;
  });

  it('retains workflow logs and exposes an asynchronous runtime failure', async () => {
    const current = service();
    await current.start('package', 'workflow', 'tab');
    expect(current.status().currentStep).toBe('正在记录日志「开始运行」');
    harness.log?.('开始');
    harness.resolve?.({ status: 'failed', runId: 'run-test', executedNodes: 1, durationMs: 5, error: new Error('没有找到特征码指定的游戏区域') });
    await vi.waitFor(() => expect(current.status().state).toBe('failed'));
    expect(current.status()).toMatchObject({ message: '没有找到特征码指定的游戏区域', executedSteps: 1 });
    expect(current.status().logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: 'info', message: '开始：记录日志「开始运行」' }),
      expect.objectContaining({ level: 'success', message: '完成：记录日志「开始运行」' }),
    ]));
    expect(current.status().logs.map((entry) => entry.message)).toEqual(expect.arrayContaining(['开始', '没有找到特征码指定的游戏区域']));
  });

  it('records preparation failures and releases the target lease', async () => {
    harness.ready = Promise.reject(new Error('automation viewport unavailable'));
    const current = service();
    await expect(current.start('package', 'workflow', 'tab')).rejects.toThrow('automation viewport unavailable');
    expect(current.status()).toMatchObject({ state: 'failed', message: 'automation viewport unavailable' });
    expect(harness.released).toBe(true);
  });
});
