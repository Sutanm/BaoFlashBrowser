import { z } from 'zod';
import { createHandler, createValidatedHandler } from '../utils/ipc-wrapper';
import {
  clearDevToolEntries,
  getDevToolSnapshot,
  getDevToolsTargetUrl,
  openNativeDevTools,
  probeActivePage,
} from '../modules/devtoolbox';

const target = z.enum(['page', 'shell']);

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
}
