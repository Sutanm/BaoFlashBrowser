import crypto from 'crypto';
import path from 'path';
import { BrowserWindow, ipcMain, session, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { JavaScriptAutomationCapabilityBroker } from './javascript-capability-broker';

const REQUEST_CHANNEL = 'automation-js:request';
const CONFIG_CHANNEL = 'automation-js:config';
const routes = new Map<number, { readonly runToken: string; readonly broker: JavaScriptAutomationCapabilityBroker }>();
let ipcInstalled = false;

function installIpcRoutes(): void {
  if (ipcInstalled) return;
  ipcInstalled = true;
  ipcMain.on(CONFIG_CHANNEL, (event: IpcMainEvent) => {
    const route = routes.get(event.sender.id);
    event.returnValue = route ? { runToken: route.runToken } : { error: 'sandbox route is unavailable' };
  });
  ipcMain.handle(REQUEST_CHANNEL, async (event: IpcMainInvokeEvent, request: unknown) => {
    const route = routes.get(event.sender.id);
    if (!route) return { requestId: 'invalid', ok: false, error: { code: 'TOKEN_INVALID', message: 'sandbox route is unavailable' } };
    return route.broker.handle(request);
  });
}

export type JavaScriptSandboxRunResult =
  | { readonly status: 'completed'; readonly value: unknown }
  | { readonly status: 'cancelled'; readonly reason: string }
  | { readonly status: 'failed'; readonly error: Error };

export type JavaScriptSandboxRunHandle = {
  readonly runId: string;
  readonly completion: Promise<JavaScriptSandboxRunResult>;
  cancel(reason?: string): Promise<JavaScriptSandboxRunResult>;
};

export type JavaScriptSandboxRunOptions = {
  readonly timeoutMs?: number;
  readonly maxResultBytes?: number;
  readonly maxSourceBytes?: number;
  readonly log?: (level: number, message: string) => void;
  readonly preloadPath?: string;
  readonly input?: readonly (null | boolean | number | string)[];
};

let nextSandboxRunId = 1;

function sandboxHtml(): string {
  const html = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; connect-src \'none\'; img-src \'none\'; media-src \'none\'; object-src \'none\'; frame-src \'none\'; script-src \'none\'"><title>Bao Automation Sandbox</title>';
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** Dedicated renderer security boundary for user-authored JavaScript. */
export class JavaScriptAutomationSandboxHost {
  start(script: string, broker: JavaScriptAutomationCapabilityBroker, options: JavaScriptSandboxRunOptions = {}): JavaScriptSandboxRunHandle {
    installIpcRoutes();
    if (typeof script !== 'string') throw new Error('automation JavaScript source must be a string');
    if (Buffer.byteLength(script, 'utf8') > (options.maxSourceBytes ?? 512 * 1024)) throw new Error('automation JavaScript source byte budget exceeded');
    const timeoutMs = options.timeoutMs ?? 30 * 60 * 1_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('sandbox timeout must be positive and finite');
    const runId = `js-run-${nextSandboxRunId++}`;
    const runToken = broker.runToken;
    const partition = `bao-automation-js-${runId}-${crypto.randomBytes(8).toString('hex')}`;
    const sandboxSession = session.fromPartition(partition);
    sandboxSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'file://*/*', 'ftp://*/*'] }, (_details, callback) => callback({ cancel: true }));
    sandboxSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    sandboxSession.on('will-download', (event) => event.preventDefault());

    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        partition,
        preload: options.preloadPath ?? path.join(__dirname, 'javascript-sandbox-preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        // Electron 11 crashes renderer preloads with sandbox:true. The user
        // world remains isolated by nodeIntegration:false + contextIsolation.
        sandbox: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        enableRemoteModule: false,
        backgroundThrottling: false,
      },
    });
    const wc = window.webContents;
    routes.set(wc.id, { runToken, broker });
    let initialNavigationComplete = false;
    wc.on('will-navigate', (event, url) => {
      if (initialNavigationComplete || !url.startsWith('data:text/html')) event.preventDefault();
    });
    wc.on('new-window', (event) => event.preventDefault());
    wc.on('will-attach-webview', (event) => event.preventDefault());
    wc.on('console-message', (_event, level, message) => options.log?.(level, String(message).slice(0, 2_000)));

    let cancelledReason: string | null = null;
    let settledResult: JavaScriptSandboxRunResult | undefined;
    let finishPromise: Promise<JavaScriptSandboxRunResult> | undefined;
    let resolveCompletion!: (result: JavaScriptSandboxRunResult) => void;
    const completion = new Promise<JavaScriptSandboxRunResult>((resolve) => { resolveCompletion = resolve; });

    const finish = (result: JavaScriptSandboxRunResult): Promise<JavaScriptSandboxRunResult> => {
      if (finishPromise) return finishPromise;
      finishPromise = (async () => {
        if (timeout) clearTimeout(timeout);
        routes.delete(wc.id);
        if (!window.isDestroyed()) window.destroy();
        await broker.close();
        settledResult = result;
        resolveCompletion(result);
        return result;
      })();
      return finishPromise;
    };

    const run = async (): Promise<void> => {
      try {
        await window.loadURL(sandboxHtml());
        initialNavigationComplete = true;
        const input = JSON.stringify(options.input ?? []);
        const wrapped = `(async function(bao,input){"use strict";\n${script}\n})(globalThis.bao,${input}).then(function(value){const serialized=JSON.stringify(value===undefined?null:value);return serialized;})`;
        const serialized = await wc.executeJavaScript(wrapped, true) as unknown;
        if (typeof serialized !== 'string') throw new Error('sandbox returned an invalid result');
        const maxResultBytes = options.maxResultBytes ?? 256 * 1024;
        if (Buffer.byteLength(serialized, 'utf8') > maxResultBytes) throw new Error('script result byte budget exceeded');
        await finish({ status: 'completed', value: JSON.parse(serialized) });
      } catch (error) {
        await finish(cancelledReason
          ? { status: 'cancelled', reason: cancelledReason }
          : { status: 'failed', error: error instanceof Error ? error : new Error(String(error)) });
      }
    };
    const timeout = setTimeout(() => {
      cancelledReason = `script timed out after ${timeoutMs}ms`;
      void finish({ status: 'cancelled', reason: cancelledReason });
    }, timeoutMs);
    void run();

    return {
      runId,
      completion,
      async cancel(reason = 'cancelled by user') {
        if (settledResult) return settledResult;
        cancelledReason = reason;
        return finish({ status: 'cancelled', reason });
      },
    };
  }
}
