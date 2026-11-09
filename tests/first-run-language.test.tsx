// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TypesafeI18n from '../src/renderer/i18n/i18n-react';
import { loadAllLocales } from '../src/renderer/i18n/i18n-util.sync';
import { defaultSettings } from '../src/renderer/store/useDataStore';
import FirstRunLanguageGate from '../src/renderer/components/overlays/FirstRunLanguageGate';

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), migrate: vi.fn() }));
vi.mock('../src/renderer/services/db', () => ({
  db: { settingsSingleton: { get: mocks.get, put: mocks.put } },
  migrateFromLocalStorage: mocks.migrate,
}));

function open() {
  return render(<TypesafeI18n locale="zh-CN"><FirstRunLanguageGate><div>Browser ready</div></FirstRunLanguageGate></TypesafeI18n>);
}

/**
 * 向导第二步会走 preload 的 `window.electronAPI.pwd`（jsdom 里默认不存在）。
 * `guardMode` 决定这一步的形态：'password'=要查看密码；'os-win'=系统验证可用，只问要不要。
 */
function mockPasswordApi(guardMode: 'password' | 'os-win' = 'password') {
  const pwd = {
    guardPreview: vi.fn().mockResolvedValue({ mode: guardMode }),
    status: vi.fn()
      .mockResolvedValueOnce({ enabled: true, viewGuard: { mode: guardMode, passwordSet: false } })
      .mockResolvedValue({ enabled: true, viewGuard: { mode: guardMode, passwordSet: true } }),
    toggleEnabled: vi.fn().mockResolvedValue({ enabled: false }),
    init: vi.fn().mockResolvedValue({ success: true, tier: 'C' }),
    setViewPassword: vi.fn().mockResolvedValue({ success: true }),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { pwd };
  return pwd;
}

describe('first launch language selection', () => {
  beforeEach(() => {
    loadAllLocales();
    mocks.get.mockReset().mockResolvedValue(undefined);
    mocks.put.mockReset().mockResolvedValue(undefined);
    mocks.migrate.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('previews English and saves before mounting the browser', async () => {
    open();
    const select = await screen.findByRole('combobox');
    expect(screen.queryByText('Browser ready')).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'en' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    // 第二步：密码本。留空即"跳过"（不开启）。
    fireEvent.click(await screen.findByRole('button', { name: 'Skip' }));
    await screen.findByText('Browser ready');
    expect(mocks.put).toHaveBeenCalledWith(expect.objectContaining({ language: 'en' }), 'default');
  });

  it('skips with an empty field and disables the password vault', async () => {
    const pwd = mockPasswordApi();
    open();
    fireEvent.click(await screen.findByRole('button', { name: '确认并开始使用' }));
    await screen.findByRole('heading', { name: '开启密码本' });
    fireEvent.click(screen.getByRole('button', { name: '跳过' }));
    await screen.findByText('Browser ready');
    expect(pwd.init).not.toHaveBeenCalled();
    expect(pwd.toggleEnabled).toHaveBeenCalledOnce();
  });

  it('enables the vault and sets the view password when a password is entered', async () => {
    const pwd = mockPasswordApi();
    open();
    fireEvent.click(await screen.findByRole('button', { name: '确认并开始使用' }));
    fireEvent.change(await screen.findByLabelText('查看密码（至少 6 位）'), { target: { value: 'secret12' } });
    fireEvent.click(screen.getByRole('button', { name: '确认并开启' }));
    await screen.findByText('Browser ready');
    expect(pwd.init).toHaveBeenCalledOnce();
    expect(pwd.setViewPassword).toHaveBeenCalledWith('secret12');
  });

  it('rejects a view password shorter than the minimum length', async () => {
    const pwd = mockPasswordApi();
    open();
    fireEvent.click(await screen.findByRole('button', { name: '确认并开始使用' }));
    fireEvent.change(await screen.findByLabelText('查看密码（至少 6 位）'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: '确认并开启' }));
    await screen.findByRole('alert');
    expect(screen.queryByText('Browser ready')).not.toBeInTheDocument();
    expect(pwd.init).not.toHaveBeenCalled();
  });

  // 用户反馈 2026-11-08：win-dpapi 可用时不该再让用户敲查看密码，只问"要不要"。
  it('系统验证可用时不问查看密码，只给"启用 / 暂不启用"', async () => {
    const pwd = mockPasswordApi('os-win');
    open();
    fireEvent.click(await screen.findByRole('button', { name: '确认并开始使用' }));
    await screen.findByRole('button', { name: '启用密码本' });
    expect(screen.queryByLabelText('查看密码（至少 6 位）')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '启用密码本' }));
    await screen.findByText('Browser ready');
    expect(pwd.init).toHaveBeenCalledOnce();
    expect(pwd.setViewPassword).not.toHaveBeenCalled();
  });

  it('系统验证可用时选"暂不启用" → 密码本关掉', async () => {
    const pwd = mockPasswordApi('os-win');
    open();
    fireEvent.click(await screen.findByRole('button', { name: '确认并开始使用' }));
    await screen.findByRole('button', { name: '暂不启用' });
    fireEvent.click(screen.getByRole('button', { name: '暂不启用' }));
    await screen.findByText('Browser ready');
    expect(pwd.init).not.toHaveBeenCalled();
    expect(pwd.toggleEnabled).toHaveBeenCalledOnce();
  });

  it('skips the dialog for existing users after legacy migration', async () => {
    mocks.get.mockResolvedValue({ ...defaultSettings, language: 'en' });
    open();
    await screen.findByText('Browser ready');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(mocks.migrate).toHaveBeenCalledOnce();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  // 用户反馈 2026-11-08：启动时向导"一闪而过"。原因是读取设置期间就已经把"选择语言"
  // 对话框渲染出来了，已配置过的机器随后读到 settings 立刻撤掉 → 用户只看到闪一下。
  // 读取期间必须什么都不画（连 role="dialog" 都不能存在）。
  it('renders no dialog while settings are still loading', async () => {
    let release: () => void = () => {};
    mocks.get.mockImplementation(() => new Promise((resolve) => { release = () => resolve(undefined); }));
    open();
    await waitFor(() => expect(mocks.get).toHaveBeenCalledOnce());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByText('正在读取设置…')).not.toBeInTheDocument();
    release();
    await screen.findByRole('combobox');
  });

  it('keeps the dialog open when persistence fails and allows retry', async () => {
    mocks.put.mockRejectedValueOnce(new Error('disk full'));
    open();
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'en' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Skip' }));
    await screen.findByRole('alert');
    expect(screen.queryByText('Browser ready')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await screen.findByText('Browser ready');
  });

  it('waits for migration and retries a failed settings load', async () => {
    mocks.migrate.mockRejectedValueOnce(new Error('database unavailable'));
    open();
    await screen.findByRole('alert');
    expect(mocks.get).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByRole('combobox')).toBeInTheDocument());
  });
});
