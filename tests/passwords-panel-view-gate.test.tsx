// @vitest-environment jsdom
/**
 * 查看门禁的渲染层行为（补齐 09-21 计划里欠的三态渲染测试）。
 *
 * 覆盖：门禁不可用不弹框 / 首次设置查看密码 / 口令错→剩余次数 / 口令对→显示明文 /
 * 取消静默 / 锁定时不弹框（带倒计时）。
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TypesafeI18n from '../src/renderer/i18n/i18n-react';
import { loadAllLocales } from '../src/renderer/i18n/i18n-util.sync';
import PasswordsPanel from '../src/renderer/components/panels/PasswordsPanel';
import { useDataStore } from '../src/renderer/store/useDataStore';
import type { ViewGuardStatus } from '../src/shared/types/passwords';

const pushToast = vi.fn();

function baseStatus(viewGuard: ViewGuardStatus) {
  return {
    enabled: true, initialized: true, tier: 'C' as const,
    autoCapture: true, autoFill: true, autoFillReady: true,
    keyStatus: 'ok' as const, viewGuard, excludedSites: [],
  };
}

const ENTRY = { id: 'e1', host: 'a.com', origin: '', title: 't', username: 'u', updatedAt: 1 };

interface ApiStub {
  status: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  reveal: ReturnType<typeof vi.fn>;
  setViewPassword: ReturnType<typeof vi.fn>;
  resetOsAuth: ReturnType<typeof vi.fn>;
  [key: string]: ReturnType<typeof vi.fn>;
}

function installApi(viewGuard: ViewGuardStatus): ApiStub {
  const api: ApiStub = {
    status: vi.fn().mockResolvedValue(baseStatus(viewGuard)),
    list: vi.fn().mockResolvedValue([ENTRY]),
    reveal: vi.fn(),
    setViewPassword: vi.fn(),
    resetOsAuth: vi.fn(),
    toggleEnabled: vi.fn(), init: vi.fn(), setAutoCapture: vi.fn(), setAutoFill: vi.fn(),
    setExcludedSites: vi.fn(), saveConfirm: vi.fn(), ignore: vi.fn(), delete: vi.fn(),
    setDefault: vi.fn(), fill: vi.fn(), resetAll: vi.fn(), retryKey: vi.fn(), rebuildVault: vi.fn(),
  };
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { pwd: api, on: vi.fn(() => vi.fn()) },
  });
  return api;
}

async function renderPanelWithEntry(): Promise<void> {
  render(
    <TypesafeI18n locale="zh-CN">
      <PasswordsPanel />
    </TypesafeI18n>,
  );
  fireEvent.click(await screen.findByText('▸ a.com'));
  await screen.findByText('查看');
}

describe('查看门禁渲染', () => {
  beforeEach(() => {
    loadAllLocales();
    pushToast.mockClear();
    useDataStore.setState({ pushToast } as never);
  });

  afterEach(() => cleanup());

  it('门禁不可用（密钥不可用）→ 只提示原因，不弹输入框', async () => {
    installApi({ mode: 'none', passwordSet: false, reason: 'key-unavailable' });
    await renderPanelWithEntry();

    fireEvent.click(screen.getByText('查看'));
    await waitFor(() => expect(pushToast).toHaveBeenCalledTimes(1));
    expect(pushToast.mock.calls[0][0].message).toContain('密钥');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('C 档未设置 → 打开"设置查看密码"（二次确认 + 后果警告），保存后直接显示明文', async () => {
    const api = installApi({ mode: 'password', passwordSet: false });
    api.setViewPassword.mockResolvedValue({ success: true });
    api.reveal.mockResolvedValue({ password: 'pw-A', mode: 'password' });
    await renderPanelWithEntry();

    fireEvent.click(screen.getByText('查看'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('设置查看密码');
    expect(dialog).toHaveTextContent('忘记后只能重建密码本');

    const inputs = dialog.querySelectorAll('input');
    expect(inputs).toHaveLength(2);

    // 过短
    fireEvent.change(inputs[0], { target: { value: 'abc' } });
    fireEvent.click(screen.getByText('保存并查看'));
    expect(dialog).toHaveTextContent('至少 6 位');
    expect(api.setViewPassword).not.toHaveBeenCalled();

    // 两次不一致
    fireEvent.change(inputs[0], { target: { value: 'long-enough' } });
    fireEvent.change(inputs[1], { target: { value: 'different' } });
    fireEvent.click(screen.getByText('保存并查看'));
    expect(dialog).toHaveTextContent('两次输入的密码不一致');
    expect(api.setViewPassword).not.toHaveBeenCalled();

    // 通过：设置成功后主进程立刻授权本次查看（规格 §5）
    fireEvent.change(inputs[1], { target: { value: 'long-enough' } });
    fireEvent.click(screen.getByText('保存并查看'));
    await waitFor(() => expect(api.setViewPassword).toHaveBeenCalledWith('long-enough'));
    await waitFor(() => expect(api.reveal).toHaveBeenCalledWith('e1', 'long-enough'));
    expect(await screen.findByText('pw-A')).toBeInTheDocument();
    expect(pushToast).toHaveBeenCalledWith({ message: '查看密码已设置', type: 'success' });
  });

  it('口令错误 → 内联错误 + 剩余次数；再输对 → 显示明文', async () => {
    const api = installApi({ mode: 'password', passwordSet: true });
    api.reveal
      .mockResolvedValueOnce({ error: 'wrong-credential', remainingAttempts: 4, mode: 'password' })
      .mockResolvedValueOnce({ password: 'pw-B', mode: 'password' });
    await renderPanelWithEntry();

    fireEvent.click(screen.getByText('查看'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('验证后查看密码');

    const input = dialog.querySelector('input')!;
    fireEvent.change(input, { target: { value: 'nope' } });
    fireEvent.click(screen.getByText('验证'));

    await waitFor(() => expect(dialog).toHaveTextContent('查看密码不正确'));
    expect(dialog).toHaveTextContent('还可尝试 4 次');

    fireEvent.change(input, { target: { value: 'correct horse' } });
    fireEvent.click(screen.getByText('验证'));
    expect(await screen.findByText('pw-B')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('用户取消系统验证 → 静默关闭，不报错', async () => {
    const api = installApi({ mode: 'os-win', passwordSet: false });
    api.reveal.mockResolvedValue({ error: 'cancelled' });
    await renderPanelWithEntry();

    fireEvent.click(screen.getByText('查看'));
    await waitFor(() => expect(api.reveal).toHaveBeenCalledWith('e1', undefined));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(pushToast).not.toHaveBeenCalled();
  });

  it('处于锁定中 → 点"查看"直接提示倒计时，不弹验证框', async () => {
    installApi({ mode: 'password', passwordSet: true, lockedForMs: 90_000 });
    await renderPanelWithEntry();

    fireEvent.click(screen.getByText('查看'));
    await waitFor(() => expect(pushToast).toHaveBeenCalled());
    expect(pushToast.mock.calls[0][0].message).toContain('已锁定');
    expect(pushToast.mock.calls[0][0].message).toContain('01:30');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('本次失败即触发锁定 → 模态显示锁定文案且不可提交', async () => {
    const api = installApi({ mode: 'password', passwordSet: true });
    api.reveal.mockResolvedValue({ error: 'wrong-credential', remainingAttempts: 0, lockedForMs: 60_000, mode: 'password' });
    await renderPanelWithEntry();

    fireEvent.click(screen.getByText('查看'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(dialog.querySelector('input')!, { target: { value: 'nope' } });
    fireEvent.click(screen.getByText('验证'));

    await waitFor(() => expect(dialog).toHaveTextContent('已锁定'));
    expect(dialog).toHaveTextContent('01:00');
    expect(screen.getByText('验证').closest('button')).toBeDisabled();
  });

  it('A 档（os-win）→ 模态只提示等待系统验证，不出现密码输入框', async () => {
    const api = installApi({ mode: 'os-win', passwordSet: false });
    api.reveal.mockResolvedValue({ password: 'pw-C', mode: 'os-win' });
    await renderPanelWithEntry();

    fireEvent.click(screen.getByText('查看'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('请在系统对话框中完成验证');
    expect(dialog.querySelectorAll('input')).toHaveLength(0);
    expect(await screen.findByText('pw-C')).toBeInTheDocument();
  });
});
