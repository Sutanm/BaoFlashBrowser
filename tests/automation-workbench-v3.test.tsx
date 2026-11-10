// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/renderer/components/automation/AutomationBlocklyV2Editor', () => ({
  default: React.forwardRef(() => <div data-testid="blockly-editor" />),
}));

import TypesafeI18n from '../src/renderer/i18n/i18n-react';
import { loadAllLocales } from '../src/renderer/i18n/i18n-util.sync';
import AutomationPage from '../src/renderer/components/automation/AutomationPage';
import { useTabsStore } from '../src/renderer/store/useTabsStore';

describe('Automation 2.0 workbench creation', () => {
  const createPackage = vi.fn();
  const listPackages = vi.fn();
  const getPackage = vi.fn();

  beforeEach(() => {
    loadAllLocales();
    createPackage.mockReset().mockResolvedValue({});
    listPackages.mockReset().mockResolvedValue([]);
    getPackage.mockReset();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        automationV3: {
          listPackages,
          getPackage,
          createPackage,
          status: vi.fn().mockResolvedValue({ state: 'idle', executedSteps: 0, logs: [] }),
          onChanged: vi.fn(() => () => {}),
        },
        tab: { activate: vi.fn() },
      },
    });
    useTabsStore.setState({ tabs: [], activeTabId: null });
  });

  afterEach(() => cleanup());

  it('shows the workbench and creation dialog in English', async () => {
    render(<TypesafeI18n locale="en"><AutomationPage /></TypesafeI18n>);
    fireEvent.click(screen.getByRole('button', { name: 'New automation package' }));
    expect(screen.getByRole('heading', { name: 'New automation package' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
    await waitFor(() => expect(listPackages).toHaveBeenCalled());
  });

  it('uses an in-app dialog and dispatches package creation', async () => {
    render(<TypesafeI18n locale="zh-CN"><AutomationPage /></TypesafeI18n>);
    fireEvent.click(screen.getByRole('button', { name: /新建/u }));
    expect(screen.getByRole('heading', { name: '新建自动化包' })).toBeInTheDocument();
    const inputs = screen.getAllByRole('textbox');
    fireEvent.change(inputs[0], { target: { value: 'smoke-package' } });
    fireEvent.change(inputs[1], { target: { value: 'Smoke Package' } });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(createPackage).toHaveBeenCalledWith('smoke-package', 'Smoke Package'));
  });

  it('runs the package main entry on a real page tab instead of the workbench tab', async () => {
    const start = vi.fn().mockResolvedValue({ runId: 'run-1' });
    const activate = vi.fn().mockResolvedValue(undefined);
    const workflow = {
      formatVersion: 3 as const,
      id: 'workflow-1',
      name: '主流程',
      root: { id: 'root', kind: 'sequence' as const, nodes: [] },
    };
    listPackages.mockResolvedValue([{ packageId: 'pkg-1', name: '测试包', mainEntryId: 'workflow', assets: [], profiles: [], frontends: [{ id: 'workflow', kind: 'blockly', name: '主流程' }] }]);
    getPackage.mockResolvedValue({ packageId: 'pkg-1', name: '测试包', mainEntryId: 'workflow', workflow, scripts: [], assets: [], profiles: [] });
    Object.assign(window.electronAPI.automationV3, { start });
    Object.assign(window.electronAPI.tab, { activate });
    useTabsStore.setState({
      activeTabId: 'workbench',
      tabs: [
        { id: 'game', url: 'https://example.test/game', title: '游戏', zoomFactor: 1, isLoading: false, isAudible: false, isMuted: false, canGoBack: false, canGoForward: false, createdAt: 1, ruffleMode: 'ppapi' },
        { id: 'workbench', url: 'about:automation', title: '自动化工作台', zoomFactor: 1, isLoading: false, isAudible: false, isMuted: false, canGoBack: false, canGoForward: false, createdAt: 2, ruffleMode: 'ppapi' },
      ],
    });

    render(<TypesafeI18n locale="zh-CN"><AutomationPage /></TypesafeI18n>);
    await waitFor(() => expect(screen.getByRole('button', { name: '运行主入口' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '运行主入口' }));

    await waitFor(() => expect(start).toHaveBeenCalledWith('pkg-1', 'workflow', 'game'));
    expect(activate).toHaveBeenCalledWith('game');
    expect(useTabsStore.getState().activeTabId).toBe('game');
  });

  it('returns from a single persisted run log back to the run list', async () => {
    const listPersistedRunLogs = vi.fn().mockResolvedValue([
      { name: '261110-12-47-脚本A-记录1.json', sizeLabel: '12 KB', scriptName: '脚本A', startedAt: 1762300000000 },
    ]);
    const readPersistedRunLog = vi.fn().mockResolvedValue([
      { timestamp: 1762300000000, level: 'info', message: '开始运行脚本' },
    ]);
    Object.assign(window.electronAPI.automationV3, { listPersistedRunLogs, readPersistedRunLog });

    render(<TypesafeI18n locale="zh-CN"><AutomationPage /></TypesafeI18n>);
    fireEvent.click(screen.getAllByRole('button', { name: '运行历史' })[0]);

    fireEvent.click(await screen.findByRole('button', { name: /脚本A/u }));
    expect(await screen.findByText('开始运行脚本')).toBeInTheDocument();
    expect(listPersistedRunLogs).toHaveBeenCalledTimes(1);

    // 明细页的「← 运行历史」曾经什么也不做：它调用的 openHistory 只重拉列表，
    // 不清 persistedLogEntries，抽屉就一直停在明细页。这里锁住回归。
    fireEvent.click(screen.getByRole('button', { name: /←/u }));
    await waitFor(() => expect(screen.queryByText('开始运行脚本')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /脚本A/u })).toBeInTheDocument();
    expect(listPersistedRunLogs).toHaveBeenCalledTimes(1);
  });
});
