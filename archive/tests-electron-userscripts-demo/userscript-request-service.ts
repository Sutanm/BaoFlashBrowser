// GmRequestService: main-process request proxy over Electron net.request.
// Mirrors the planned request chain:
//   userscript → preload validation → main-process proxy → net.request
// Mirrors the planned src/main/modules/userscripts/userscript-request.ts.

import { net } from 'electron';
import {
  connectAllows,
  isBlockedUrl,
  redactHeadersForLog,
  stripSensitiveHeaders,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT_PER_SCRIPT,
  DEFAULT_MAX_CONCURRENT_GLOBAL,
} from './userscript-request';

export interface GmRequestDetails {
  method: string;
  url: string;
  headers?: Record<string, string>;
  data?: string;
  responseType?: 'text' | 'json' | 'blob' | 'arraybuffer';
  timeout?: number;
}

export interface GmRequestResponse {
  finalUrl: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  responseText: string;
  responseBase64?: string;
}

export type GmRequestError =
  | 'invalid-arguments'
  | 'protocol-blocked'
  | 'address-blocked'
  | 'connect-denied'
  | 'redirect-limit'
  | 'size-limit'
  | 'timeout'
  | 'aborted'
  | 'concurrency-limit'
  | 'network';

export interface GmRequestResult {
  requestId: number;
  ok: boolean;
  error?: GmRequestError;
  errorMessage?: string;
  response?: GmRequestResponse;
}

export interface GmRequestServiceOptions {
  session?: Electron.Session;
  allowedLoopbackHosts?: string[];
  maxRedirects?: number;
  maxResponseBytes?: number;
  defaultTimeoutMs?: number;
  maxConcurrentPerScript?: number;
  maxConcurrentGlobal?: number;
}

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']);

export class GmRequestService {
  private readonly options: Required<Omit<GmRequestServiceOptions, 'allowedLoopbackHosts' | 'session'>> & { allowedLoopbackHosts: string[] };
  private readonly session?: Electron.Session;
  private readonly active = new Map<number, {
    request: Electron.ClientRequest;
    wcId: number;
    scriptId: string;
    timer: ReturnType<typeof setTimeout>;
    resolve: (result: GmRequestResult) => void;
  }>();
  private readonly perScriptActive = new Map<string, number>();
  private nextId = 1;
  private globalActive = 0;

  constructor(options: GmRequestServiceOptions = {}) {
    this.options = {
      allowedLoopbackHosts: options.allowedLoopbackHosts ?? [],
      maxRedirects: options.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
      maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      defaultTimeoutMs: options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxConcurrentPerScript: options.maxConcurrentPerScript ?? DEFAULT_MAX_CONCURRENT_PER_SCRIPT,
      maxConcurrentGlobal: options.maxConcurrentGlobal ?? DEFAULT_MAX_CONCURRENT_GLOBAL,
    };
    this.session = options.session;
  }

  request(
    wcId: number,
    scriptId: string,
    pageUrl: string,
    connect: string[],
    details: GmRequestDetails,
    localId?: number,
  ): Promise<GmRequestResult> {
    return new Promise((resolve) => {
      // localId comes from the preload so abort() can target the same request
      // without a separate id mapping round trip.
      const requestId = Number.isInteger(localId) ? Number(localId) : this.nextId++;
      const fail = (error: GmRequestError, errorMessage?: string): GmRequestResult => {
        this.releaseConcurrency(scriptId);
        return { requestId, ok: false, error, errorMessage };
      };

      const method = String(details?.method || 'GET').toUpperCase();
      if (!ALLOWED_METHODS.has(method) || typeof details?.url !== 'string') {
        resolve(fail('invalid-arguments'));
        return;
      }
      if (isBlockedUrl(details.url, this.options.allowedLoopbackHosts)) {
        resolve(fail('address-blocked', details.url));
        return;
      }
      if (!connectAllows(connect, pageUrl, details.url)) {
        resolve(fail('connect-denied', details.url));
        return;
      }
      const perScript = this.perScriptActive.get(scriptId) ?? 0;
      if (perScript >= this.options.maxConcurrentPerScript || this.globalActive >= this.options.maxConcurrentGlobal) {
        resolve(fail('concurrency-limit'));
        return;
      }
      this.perScriptActive.set(scriptId, perScript + 1);
      this.globalActive += 1;

      const timeoutMs = Math.min(
        Number.isFinite(Number(details.timeout)) && Number(details.timeout) > 0 ? Number(details.timeout) : this.options.defaultTimeoutMs,
        this.options.defaultTimeoutMs,
      );
      const request = net.request({
        method,
        url: details.url,
        redirect: 'follow',
        session: this.session,
        useSessionCookies: true,
      }) as Electron.ClientRequest;

      let redirectCount = 0;
      let receivedBytes = 0;
      let settled = false;
      const finish = (result: GmRequestResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.active.delete(requestId);
        this.releaseConcurrency(scriptId);
        resolve(result);
      };

      const timer = setTimeout(() => {
        try { request.abort(); } catch { /* already gone */ }
        finish({ requestId, ok: false, error: 'timeout' });
      }, timeoutMs);

      this.active.set(requestId, { request, wcId, scriptId, timer, resolve: finish });

      request.on('redirect', (statusCode: number, _method: string, _redirectUrl: string) => {
        redirectCount += 1;
        if (redirectCount > this.options.maxRedirects) {
          try { request.abort(); } catch { /* ignore */ }
          finish({ requestId, ok: false, error: 'redirect-limit', errorMessage: String(statusCode) });
        }
      });

      const safeHeaders = stripSensitiveHeaders(details.headers ?? {});
      for (const [name, value] of Object.entries(safeHeaders)) {
        if (name.toLowerCase() === 'user-agent') continue;
        request.setHeader(name, String(value));
      }
      if (details.data !== undefined && details.data !== null) {
        request.write(String(details.data));
      }

      let bodyChunks: Buffer[] = [];
      let status = 0;
      let statusText = '';
      let finalUrl = details.url;
      let responseHeaders: Record<string, string> = {};

      request.on('response', (response: Electron.IncomingMessage) => {
        status = response.statusCode ?? 0;
        statusText = response.statusMessage ?? '';
        finalUrl = response.url || details.url;
        const rawHeaders: Record<string, string> = {};
        for (const [name, value] of Object.entries(response.headers ?? {})) {
          rawHeaders[name] = Array.isArray(value) ? value.join(', ') : String(value ?? '');
        }
        responseHeaders = redactHeadersForLog(rawHeaders);
        response.on('data', (chunk: Buffer) => {
          receivedBytes += chunk.length;
          if (receivedBytes > this.options.maxResponseBytes) {
            try { request.abort(); } catch { /* ignore */ }
            finish({ requestId, ok: false, error: 'size-limit' });
            return;
          }
          bodyChunks.push(chunk);
        });
        response.on('end', () => {
          const body = Buffer.concat(bodyChunks);
          const wantsBinary = details.responseType === 'blob' || details.responseType === 'arraybuffer';
          finish({
            requestId,
            ok: true,
            response: {
              finalUrl,
              status,
              statusText,
              headers: responseHeaders,
              responseText: wantsBinary ? '' : body.toString('utf8'),
              responseBase64: wantsBinary ? body.toString('base64') : undefined,
            },
          });
        });
      });

      request.on('error', (error: Error) => {
        finish({ requestId, ok: false, error: 'network', errorMessage: error?.message });
      });

      request.on('aborted', () => {
        finish({ requestId, ok: false, error: 'aborted' });
      });

      try {
        request.end();
      } catch (error) {
        finish({ requestId, ok: false, error: 'network', errorMessage: String(error) });
      }
    });
  }

  abort(wcId: number, requestId: number): boolean {
    const entry = this.active.get(requestId);
    if (!entry || entry.wcId !== wcId) return false;
    try { entry.request.abort(); } catch { /* already gone */ }
    clearTimeout(entry.timer);
    this.active.delete(requestId);
    this.releaseConcurrency(entry.scriptId);
    // Resolve deterministically: Electron 11 does not reliably emit an abort
    // event on net.request, so the in-flight promise must be settled here.
    entry.resolve({ requestId, ok: false, error: 'aborted' });
    return true;
  }

  cancelForWc(wcId: number): void {
    for (const [requestId, entry] of this.active) {
      if (entry.wcId !== wcId) continue;
      try { entry.request.abort(); } catch { /* already gone */ }
      clearTimeout(entry.timer);
      this.active.delete(requestId);
      this.releaseConcurrency(entry.scriptId);
      entry.resolve({ requestId, ok: false, error: 'aborted' });
    }
  }

  getActiveCount(): number {
    return this.globalActive;
  }

  private releaseConcurrency(scriptId: string): void {
    const current = this.perScriptActive.get(scriptId) ?? 0;
    if (current > 1) this.perScriptActive.set(scriptId, current - 1);
    else this.perScriptActive.delete(scriptId);
    this.globalActive = Math.max(0, this.globalActive - 1);
  }
}
