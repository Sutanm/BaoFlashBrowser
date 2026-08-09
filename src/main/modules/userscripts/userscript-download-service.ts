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
  method?: string;
  timeout?: number;
}

export type GmDownloadError =
  | 'invalid-arguments'
  | 'address-blocked'
  | 'connect-denied'
  | 'redirect-limit'
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
  session: Electron.Session;
  allowedLoopbackHosts?: string[];
  maxBytes?: number;
  defaultTimeoutMs?: number;
  maxConcurrentPerScript?: number;
}

interface ActiveDownload {
  request: Electron.ClientRequest;
  downloadId: number;
  wcId: number;
  scriptId: string;
  timer: ReturnType<typeof setTimeout>;
  fileName: string;
  filePath: string;
  stream?: ReturnType<typeof createWriteStream>;
  cleanup: () => void;
  resolve: (result: GmDownloadResult) => void;
}

const ALLOWED_METHODS = new Set(['GET']);

export class GmDownloadService {
  private readonly options: Required<Omit<GmDownloadServiceOptions, 'session' | 'allowedLoopbackHosts'>> & {
    allowedLoopbackHosts: string[];
  };
  private readonly session?: Electron.Session;
  private readonly active = new Map<string, ActiveDownload>();
  private readonly perScriptActive = new Map<string, number>();
  private nextId = 1;

  private downloadKey(wcId: number, scriptId: string, downloadId: number): string {
    return `${wcId}:${scriptId}:${downloadId}`;
  }

  private availablePath(fileName: string): string {
    const ext = path.extname(fileName);
    const stem = path.basename(fileName, ext);
    const reserved = new Set(Array.from(this.active.values(), (entry) => path.resolve(entry.filePath).toLowerCase()));
    for (let index = 0; ; index += 1) {
      const candidateName = index === 0 ? fileName : `${stem} (${index})${ext}`;
      const candidate = path.join(this.options.downloadDir, candidateName);
      if (!existsSync(candidate) && !reserved.has(path.resolve(candidate).toLowerCase())) return candidate;
    }
  }

  constructor(options: GmDownloadServiceOptions) {
    this.options = {
      downloadDir: options.downloadDir,
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
      const downloadId = localId === undefined ? this.nextId++ : Number(localId);
      const fail = (error: GmDownloadError): GmDownloadResult => ({ downloadId, ok: false, error });

      if (!Number.isSafeInteger(downloadId) || downloadId <= 0 || typeof details?.url !== 'string' || !ALLOWED_METHODS.has(String(details.method ?? 'GET').toUpperCase())) {
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
      const requestedName = sanitizeFileName(details.name ?? '');
      const filePath = this.availablePath(requestedName);
      const fileName = path.basename(filePath);

      let request: Electron.ClientRequest;
      try {
        request = net.request({
          method: 'GET',
          url: details.url,
          redirect: 'manual',
          session: this.session,
          useSessionCookies: true,
        }) as Electron.ClientRequest;
      } catch {
        this.releaseConcurrency(scriptId);
        resolve(fail('network'));
        return;
      }

      let redirectCount = 0;
      let receivedBytes = 0;
      let settled = false;
      let fileCreated = false;
      let cleanupScheduled = false;

      const finish = (result: GmDownloadResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.active.delete(this.downloadKey(wcId, scriptId, downloadId));
        this.releaseConcurrency(scriptId);
        resolve(result);
      };

      const cleanupFile = (): void => {
        if (!fileCreated || cleanupScheduled) return;
        cleanupScheduled = true;
        const remove = (): void => {
          try { unlinkSync(filePath); } catch { /* best effort */ }
        };
        const stream = entry?.stream;
        if (stream && !stream.closed) {
          stream.once('close', remove);
          try { stream.destroy(); } catch { remove(); }
        } else {
          remove();
        }
      };

      const timer = setTimeout(() => {
        try { request.abort(); } catch { /* already gone */ }
        cleanupFile();
        finish({ downloadId, ok: false, error: 'timeout' });
      }, timeoutMs);

      const entry: ActiveDownload = {
        request,
        downloadId,
        wcId,
        scriptId,
        timer,
        fileName,
        filePath,
        cleanup: cleanupFile,
        resolve: finish,
      };
      this.active.set(this.downloadKey(wcId, scriptId, downloadId), entry);

      request.on('redirect', (statusCode: number, _method: string, redirectUrl: string) => {
        redirectCount += 1;
        if (redirectCount > DEFAULT_MAX_REDIRECTS) {
          try { request.abort(); } catch { /* ignore */ }
          cleanupFile();
          finish({ downloadId, ok: false, error: 'redirect-limit', status: statusCode });
          return;
        }
        if (isBlockedUrl(redirectUrl, this.options.allowedLoopbackHosts)) {
          try { request.abort(); } catch { /* ignore */ }
          cleanupFile();
          finish({ downloadId, ok: false, error: 'address-blocked', status: statusCode });
          return;
        }
        if (!connectAllows(connect, pageUrl, redirectUrl)) {
          try { request.abort(); } catch { /* ignore */ }
          cleanupFile();
          finish({ downloadId, ok: false, error: 'connect-denied', status: statusCode });
          return;
        }
        try {
          (request as unknown as { followRedirect(): void }).followRedirect();
        } catch {
          cleanupFile();
          finish({ downloadId, ok: false, error: 'network', status: statusCode });
        }
      });

      request.on('response', (response: Electron.IncomingMessage) => {
        if (response.statusCode && response.statusCode >= 400) {
          try { (response as unknown as { resume(): void }).resume(); } catch { /* already consumed */ }
          cleanupFile();
          finish({ downloadId, ok: false, error: 'network', status: response.statusCode });
          return;
        }
        let stream: ReturnType<typeof createWriteStream> | undefined;
        try {
          stream = createWriteStream(filePath);
          fileCreated = true;
          entry!.stream = stream;
        } catch {
          try { (response as unknown as { resume(): void }).resume(); } catch { /* already consumed */ }
          finish({ downloadId, ok: false, error: 'file-error' });
          return;
        }
        stream.on('error', () => {
          try { request.abort(); } catch { /* ignore */ }
          cleanupFile();
          finish({ downloadId, ok: false, error: 'file-error' });
        });
        stream.on('finish', () => {
          finish({
            downloadId,
            ok: true,
            fileName,
            status: response.statusCode ?? 200,
          });
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
        });
      });

      request.on('error', () => {
        cleanupFile();
        finish({ downloadId, ok: false, error: 'network' });
      });

      // 'aborted' is not in Electron 11's ClientRequest event typings.
      (request as unknown as { on(event: 'aborted', listener: () => void): void }).on('aborted', () => {
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

  abort(wcId: number, scriptId: string, downloadId: number): boolean {
    const entry = this.active.get(this.downloadKey(wcId, scriptId, downloadId));
    if (!entry) return false;
    try { entry.request.abort(); } catch { /* already gone */ }
    entry.cleanup();
    entry.resolve({ downloadId, ok: false, error: 'aborted' });
    return true;
  }

  cancelForWc(wcId: number): void {
    for (const [, entry] of this.active) {
      if (entry.wcId !== wcId) continue;
      this.abort(wcId, entry.scriptId, entry.downloadId);
    }
  }

  // Live capacity update (settings panel hot-apply).
  setLimits(partial: Partial<Pick<GmDownloadServiceOptions, 'maxBytes' | 'maxConcurrentPerScript'>>): void {
    for (const [key, value] of Object.entries(partial)) {
      if (value !== undefined) (this.options as Record<string, unknown>)[key] = value;
    }
  }

  private releaseConcurrency(scriptId: string): void {
    const current = this.perScriptActive.get(scriptId) ?? 0;
    if (current > 1) this.perScriptActive.set(scriptId, current - 1);
    else this.perScriptActive.delete(scriptId);
  }
}
