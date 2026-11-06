import { z } from 'zod';
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { createHandler, createValidatedHandler } from '../utils/ipc-wrapper';
import {
  clearDevToolEntries,
  getDevToolSnapshot,
  getDevToolsTargetUrl,
  openNativeDevTools,
  probeActivePage,
  resolveActivePageTargetId,
  resolveDebugPort,
} from '../modules/devtoolbox';
import { devToolsBridge } from '../modules/devtoolbox-bridge';
import { getMainWindow } from '../modules/window';

const target = z.enum(['page', 'shell']);

/** 桥的 IPC 只接受外壳 renderer（iframe 在外壳 renderer 内，sender 仍是它）。 */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const win = getMainWindow();
  return Boolean(win && !win.isDestroyed() && event.sender === win.webContents);
}

const bridgeSendSchema = z.object({
  method: z.string().min(1).max(120),
  params: z.record(z.unknown()).optional(),
  // 前端带 sessionId 时忽略（桥为单 target 世界）；保留字段以对齐协议形状。
  sessionId: z.string().min(1).max(120).optional(),
  // 前端请求 id：给了就代表「响应走有序流」，桥不再用 IPC 返回值回传。
  id: z.number().int().positive().optional(),
}).strict();

export function registerDevToolboxIPC(): void {
  createHandler<void, ReturnType<typeof getDevToolSnapshot>>('devtoolbox:snapshot', () =>
    getDevToolSnapshot());

  createHandler<void, void>('devtoolbox:clear', () => {
    clearDevToolEntries();
  });

  // DevTools 前端只认 WebSocket，这里给出可直接喂给 iframe 的 ws 地址。
  createValidatedHandler(
    'devtoolbox:devtools-url',
    z.object({ target }).strict(),
    (args: { target: 'page' | 'shell' }) => getDevToolsTargetUrl(args.target),
  );

  createValidatedHandler(
    'devtoolbox:open-native',
    z.object({ target }).strict(),
    (args: { target: 'page' | 'shell' }) => openNativeDevTools(args.target),
  );

  createHandler<void, Awaited<ReturnType<typeof probeActivePage>>>('devtoolbox:probe-page', () =>
    probeActivePage());

  // ---- CDP 桥（桥 v2） ----
  // 这几个通道不走 createHandler：需要 sender 校验（规格 §2 铁律 B5），
  // 而公共 wrapper 不接收 event。
  devToolsBridge.setEventSink((events) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('devtoolbox:bridge-event', { events });
  });

  ipcMain.handle('devtoolbox:bridge-attach', async (event) => {
    if (!isTrustedSender(event)) return { ok: false, error: { message: 'untrusted-sender' } };
    const port = resolveDebugPort();
    if (!port) return { ok: false, error: { message: 'no-port' } };
    const targetId = await resolveActivePageTargetId();
    if (!targetId) return { ok: false, error: { message: 'no-target' } };
    try {
      const { sessionId } = await devToolsBridge.attach(targetId, port);
      return { ok: true, targetId, sessionId };
    } catch (error) {
      return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } };
    }
  });

  ipcMain.handle('devtoolbox:bridge-detach', async (event) => {
    if (!isTrustedSender(event)) return { ok: false, error: { message: 'untrusted-sender' } };
    await devToolsBridge.detach();
    return { ok: true };
  });

  ipcMain.handle('devtoolbox:bridge-send', async (event, args: unknown) => {
    if (!isTrustedSender(event)) return { ok: false, error: { message: 'untrusted-sender' } };
    const parsed = bridgeSendSchema.safeParse(args);
    if (!parsed.success) return { ok: false, error: { message: 'invalid-arguments' } };
    return devToolsBridge.send(parsed.data.method, parsed.data.params, parsed.data.sessionId, parsed.data.id);
  });

  ipcMain.handle('devtoolbox:bridge-stats', (event) => {
    if (!isTrustedSender(event)) return null;
    return devToolsBridge.getStats();
  });
}
