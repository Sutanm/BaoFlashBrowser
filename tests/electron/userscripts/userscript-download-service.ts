// GmDownloadService: main-process download proxy. Validates like GM_xmlhttpRequest
// (@connect / address / protocol), streams the response to disk with size,
// timeout and concurrency limits, and supports abort.
// Mirrors the planned src/main/modules/userscripts/userscript-download.ts.

import { net } from 'electron';
import { createWriteStream, existsSync, mkdirSync, unlinkSync } from 'fs';
import path from 'path';
import {
  connectAllows,
  isBlockedUrl,
  DEFAULT_MAX_REDIRECTS,
} from './userscript-request';
import {
  sanitizeFileName,
  DEFAULT_DOWNLOAD_MAX_BYTES,
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_DOWNLOAD_MAX_CONCURRENT_PER_SCRIPT,
} from './userscript-download';

export interface GmDownloadDetails {
  url: string;
  name?: string;
  timeout?: number;
}

export type GmDownloadError =
  | 'invalid-arguments'
  | 'address-blocked'
  | 'connect-denied'
  | 'size-limit'
  | 'timeout'
  | 'aborted'
  | 'concurrency-limit'
  | 'network'
  | 'file-error';

export interface GmDownloadResult {
  downloadId: number;
  ok: boolean;
  error?: GmDownloadError;
  fileName?: string;
  status?: number;
}

export interface GmDownloadServiceOptions {
  downloadDir: string;
  session?: Electron.Session;
  allowedLoopbackHosts?: string[];
  maxBytes?: number;
  defaultTimeoutMs?: number;
  maxConcurrentPerScript?: number;
}

interface ActiveDownload {
  request: Electron.ClientRequest;
  wcId: number;
  scriptId: string;
  timer: ReturnType<typeof setTimeout>;
  fileName: string;
  filePath: string;
  stream?: ReturnType<typeof createWriteStream>;
  resolve: (result: GmDownloadResult) => void;
}

const ALLOWED_METHODS = new Set(['GET']);

export class GmDownloadService {
  private readonly options: Required<Omit<GmDownloadServiceOptions, 'session' | 'allowedLoopbackHosts'>> & {
    allowedLoopbackHosts: string[];
  };
  private readonly session?: Electron.Session;
  private readonly active = new Map<number, ActiveDownload>();
  private readonly perScriptActive = new Map<string, number>();
  private nextId = 1;

  constructor(options: GmDownloadServiceOptions) {
    this.options = {
      downloadDir: options.downloadDir,
      session: options.session,
      allowedLoopbackHosts: options.allowedLoopbackHosts ?? [],
      maxBytes: options.maxBytes ?? DEFAULT_DOWNLOAD_MAX_BYTES,
      defaultTimeoutMs: options.defaultTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
      maxConcurrentPerScript: options.maxConcurrentPerScript ?? DEFAULT_DOWNLOAD_MAX_CONCURRENT_PER_SCRIPT,
    };
    this.session = options.session;
    if (!existsSync(this.options.downloadDir)) mkdirSync(this.options.downloadDir, { recursive: true });
  }

  download(
    wcId: number,
    scriptId: string,
    pageUrl: string,
    connect: string[],
    details: GmDownloadDetails,
    localId?: number,
  ): Promise<GmDownloadResult> {
    return new Promise((resolve) => {
      const downloadId = Number.isInteger(localId) ? Number(localId) : this.nextId++;
      const fail = (error: GmDownloadError): GmDownloadResult => {
        this.releaseConcurrency(scriptId);
        return { downloadId, ok: false, error };
      };

      if (typeof details?.url !== 'string' || !ALLOWED_METHODS.has(String(details.method ?? 'GET').toUpperCase())) {
        resolve(fail('invalid-arguments'));
        return;
      }
      if (isBlockedUrl(details.url, this.options.allowedLoopbackHosts)) {
        resolve(fail('address-blocked'));
        return;
      }
      if (!connectAllows(connect, pageUrl, details.url)) {
        resolve(fail('connect-denied'));
        return;
      }
      const perScript = this.perScriptActive.get(scriptId) ?? 0;
      if (perScript >= this.options.maxConcurrentPerScript) {
        resolve(fail('concurrency-limit'));
        return;
      }
      this.perScriptActive.set(scriptId, perScript + 1);

      const timeoutMs = Math.min(
        Number.isFinite(Number(details.timeout)) && Number(details.timeout) > 0 ? Number(details.timeout) : this.options.defaultTimeoutMs,
        this.options.defaultTimeoutMs,
      );
      const fileName = sanitizeFileName(details.name);
      const filePath = path.join(this.options.downloadDir, fileName);

      const request = net.request({
        method: 'GET',
        url: details.url,
        redirect: 'follow',
        session: this.session,
        useSessionCookies: true,
      }) as Electron.ClientRequest;

      let redirectCount = 0;
      let receivedBytes = 0;
      let settled = false;
      let fileCreated = false;

      const finish = (result: GmDownloadResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.active.delete(downloadId);
        this.releaseConcurrency(scriptId);
        resolve(result);
      };

      const cleanupFile = (): void => {
        try { if (fileCreated) unlinkSync(filePath); } catch { /* best effort */ }
      };

      const timer = setTimeout(() => {
        try { request.abort(); } catch { /* already gone */ }
        cleanupFile();
        finish({ downloadId, ok: false, error: 'timeout' });
      }, timeoutMs);

      const entry: ActiveDownload = {
        request,
        wcId,
        scriptId,
        timer,
        fileName,
        filePath,
        resolve: finish,
      };
      this.active.set(downloadId, entry);

      request.on('redirect', (statusCode: number) => {
        redirectCount += 1;
        if (redirectCount > DEFAULT_MAX_REDIRECTS) {
          try { request.abort(); } catch { /* ignore */ }
          cleanupFile();
          finish({ downloadId, ok: false, error: 'network', status: statusCode });
        }
      });

      request.on('response', (response: Electron.IncomingMessage) => {
        if (response.statusCode && response.statusCode >= 400) {
          response.resume();
          cleanupFile();
          finish({ downloadId, ok: false, error: 'network', status: response.statusCode });
          return;
        }
        let stream: ReturnType<typeof createWriteStream> | undefined;
        try {
          stream = createWriteStream(filePath);
          fileCreated = true;
          entry.stream = stream;
        } catch {
          response.resume();
          finish({ downloadId, ok: false, error: 'file-error' });
          return;
        }
        stream.on('error', () => {
          try { request.abort(); } catch { /* ignore */ }
          cleanupFile();
          finish({ downloadId, ok: false, error: 'file-error' });
        });
        response.on('data', (chunk: Buffer) => {
          receivedBytes += chunk.length;
          if (receivedBytes > this.options.maxBytes) {
            try { request.abort(); } catch { /* ignore */ }
            stream?.destroy();
            cleanupFile();
            finish({ downloadId, ok: false, error: 'size-limit' });
            return;
          }
          stream?.write(chunk);
        });
        response.on('end', () => {
          stream?.end();
          finish({
            downloadId,
            ok: true,
            fileName,
            status: response.statusCode ?? 200,
          });
        });
      });

      request.on('error', () => {
        cleanupFile();
        finish({ downloadId, ok: false, error: 'network' });
      });

      request.on('aborted', () => {
        cleanupFile();
        finish({ downloadId, ok: false, error: 'aborted' });
      });

      try {
        request.end();
      } catch {
        cleanupFile();
        finish({ downloadId, ok: false, error: 'network' });
      }
    });
  }

  abort(wcId: number, downloadId: number): boolean {
    const entry = this.active.get(downloadId);
    if (!entry || entry.wcId !== wcId) return false;
    try { entry.request.abort(); } catch { /* already gone */ }
    try { entry.stream?.destroy(); } catch { /* ignore */ }
    try { if (entry.stream) unlinkSync(entry.filePath); } catch { /* best effort */ }
    clearTimeout(entry.timer);
    this.active.delete(downloadId);
    this.releaseConcurrency(entry.scriptId);
    entry.resolve({ downloadId, ok: false, error: 'aborted' });
    return true;
  }

  cancelForWc(wcId: number): void {
    for (const [downloadId, entry] of this.active) {
      if (entry.wcId !== wcId) continue;
      this.abort(wcId, downloadId);
    }
  }

  private releaseConcurrency(scriptId: string): void {
    const current = this.perScriptActive.get(scriptId) ?? 0;
    if (current > 1) this.perScriptActive.set(scriptId, current - 1);
    else this.perScriptActive.delete(scriptId);
  }
}
