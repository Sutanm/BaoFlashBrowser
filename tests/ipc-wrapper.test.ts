// 多窗口 P2（SDD: docs/specs/multi-window-plan.md §6.3 / §7 P2）
//
// 先于实现写：ipc-wrapper 目前只有 createHandler（丢弃 event），没有带
// 事件上下文/窗口归属的工厂。目标语义：
//   - createEventHandler 把 { event, window, args } 交给业务回调
//   - createValidatedEventHandler 先 zod 校验，再带上同一上下文
//   - 旧 createHandler / createValidatedHandler 签名保持不变
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>(),
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) => {
      state.handlers.set(channel, handler);
    },
  },
}));
vi.mock('electron-log', () => ({ default: { error: state.error, warn: state.warn, info: vi.fn() } }));

const { createEventHandler, createHandler, createValidatedEventHandler, setIpcWindowResolver } = await import('../src/main/utils/ipc-wrapper');

beforeEach(() => {
  state.handlers.clear();
  state.error.mockClear();
  state.warn.mockClear();
  setIpcWindowResolver(() => null);
});

describe('ipc-wrapper event context (P2)', () => {
  it('passes the resolved window and raw args to the handler', async () => {
    const window = { id: 7, webContents: { id: 70 } };
    setIpcWindowResolver((wc: { id: number }) => (wc.id === 70 ? window as never : null));
    const handler = vi.fn().mockResolvedValue('ok');
    createEventHandler('test:event', handler);
    const event = { sender: { id: 70 } };

    await expect(state.handlers.get('test:event')!(event, { a: 1 })).resolves.toBe('ok');
    expect(handler).toHaveBeenCalledWith({ event, window, args: { a: 1 } });
  });

  it('resolves a null window for unregistered senders instead of throwing', async () => {
    const handler = vi.fn().mockReturnValue('done');
    createEventHandler('test:null-window', handler);

    await expect(state.handlers.get('test:null-window')!({ sender: { id: 999 } }, undefined)).resolves.toBe('done');
    expect(handler.mock.calls[0][0]).toMatchObject({ window: null });
  });

  it('validates args before the handler and rejects invalid payloads', async () => {
    const window = { id: 1 };
    setIpcWindowResolver(() => window as never);
    const handler = vi.fn().mockReturnValue('accepted');
    createValidatedEventHandler('test:validated', z.object({ name: z.string().min(1) }).strict(), handler);

    await expect(state.handlers.get('test:validated')!({ sender: { id: 1 } }, { name: 'x' })).resolves.toBe('accepted');
    expect(handler).toHaveBeenCalledWith({ event: expect.anything(), window, args: { name: 'x' } });

    handler.mockClear();
    await expect(state.handlers.get('test:validated')!({ sender: { id: 1 } }, { name: '' })).rejects.toThrow('Invalid arguments for test:validated');
    expect(handler).not.toHaveBeenCalled();
    expect(state.warn).toHaveBeenCalled();
  });

  it('keeps the legacy createHandler signature (event discarded)', async () => {
    const handler = vi.fn().mockReturnValue('legacy');
    createHandler('test:legacy', handler);

    await expect(state.handlers.get('test:legacy')!({ sender: { id: 1 } }, { value: 2 })).resolves.toBe('legacy');
    expect(handler).toHaveBeenCalledWith({ value: 2 });
  });
});
