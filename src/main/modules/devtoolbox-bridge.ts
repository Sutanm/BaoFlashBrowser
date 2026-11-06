/**
 * DevTools CDP 桥（桥 v2）——把 M97 前端与 CDP agent 之间的连接从
 * 「前端直连 page-ws」改为「前端 ↔ 主进程 ↔ browser ws 的 flatten session」。
 *
 * 规格：docs/archive/superpowers/specs/2026-11-06-devtools-cdp-bridge-design.md
 *
 * 本阶段（B2）只做传输层，**对前端保持 page-ws 等价语义**：消息不带 sessionId，
 * 桥内部补/剥 sessionId。因此 M97 前端无需任何改动即可跑在这条通道上（B3 才替换
 * 前端的 Connection 层），桥也能被探针独立验证。
 *
 * 关键约束（规格 §2）：
 * - B1 只走 flatten，不碰 embedded（密码 capture/fill、automation 的 wc.debugger 零影响）。
 * - B4 CDP 流量不落日志，只记条数/字节统计。
 * - S9 结论：attach 后不能立刻放行流量，必须等 Target.attachedToTarget（域就绪）。
 */
import http from 'http';
import log from 'electron-log';
import WebSocket from 'ws';

export interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
  sessionId?: string;
}

export interface BridgeStats {
  state: 'idle' | 'connecting' | 'ready' | 'closed';
  targetId: string | null;
  sessionId: string | null;
  sent: number;
  events: number;
  eventsDropped: number;
  bytesOut: number;
  bytesIn: number;
}

/** 必须发到 browser session（不带 sessionId）的方法；其余默认补当前 sessionId。 */
const BROWSER_LEVEL_METHODS = new Set([
  'Target.attachToTarget',
  'Target.detachFromTarget',
  'Target.getTargets',
  'Target.getTargetInfo',
  'Target.setDiscoverTargets',
  'Target.setAutoAttach',
  'Target.createTarget',
  'Target.closeTarget',
  'Target.activateTarget',
  'Target.getBrowserContexts',
  'Target.exposeDevToolsProtocol',
  'Target.sendMessageToTarget',
  'Target.autoAttachRelated',
  'Target.setRemoteLocations',
]);

/** 事件合批窗口：Network/Elements 的事件风暴逐条跨 IPC 会压垮主进程。 */
const EVENT_FLUSH_MS = 16;

type SendResult = { ok: true; result: unknown } | { ok: false; error: { message: string; code?: number } };

class DevToolsBridge {
  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private messageId = 0;
  private pending = new Map<number, (msg: CdpMessage) => void>();
  private sessionId: string | null = null;
  private targetId: string | null = null;
  private sink: ((events: CdpMessage[]) => void) | null = null;
  private buffer: CdpMessage[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private port: number | null = null;
  private state: BridgeStats['state'] = 'idle';
  private counters = { sent: 0, events: 0, eventsDropped: 0, bytesOut: 0, bytesIn: 0 };

  setEventSink(sink: ((events: CdpMessage[]) => void) | null): void {
    this.sink = sink;
  }

  getStats(): BridgeStats {
    return {
      state: this.state,
      targetId: this.targetId,
      sessionId: this.sessionId,
      ...this.counters,
    };
  }

  /** 把当前活动标签的 target 挂到桥上（切标签时重新调用）。 */
  async attach(targetId: string, port: number): Promise<{ sessionId: string }> {
    await this.ensureSocket(port);
    if (this.targetId === targetId && this.sessionId) return { sessionId: this.sessionId };
    if (this.sessionId) await this.detach();

    this.targetId = targetId;
    const response = await this.sendRaw('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = (response.result as { sessionId?: string } | undefined)?.sessionId;
    if (!sessionId) {
      this.targetId = null;
      throw new Error(`attachToTarget 未返回 sessionId：${JSON.stringify(response.error ?? response.result)}`);
    }
    this.sessionId = sessionId;
    // S9：session 建立后域尚未就绪，立即发包会得到 "… wasn't found"。等 attached 事件
    // 或一次短延迟再放行（attached 事件通常先于本次响应到达，这里兜底 60ms）。
    await new Promise((resolve) => setTimeout(resolve, 60));
    log.info(`[DevToolsBridge] attached target=${targetId.slice(0, 12)}… session=${sessionId.slice(0, 12)}…`);
    return { sessionId };
  }

  async detach(): Promise<void> {
    if (!this.sessionId) return;
    const sessionId = this.sessionId;
    this.sessionId = null;
    this.targetId = null;
    try {
      await this.sendRaw('Target.detachFromTarget', { sessionId });
    } catch (error) {
      log.warn('[DevToolsBridge] detach 失败（忽略）:', error instanceof Error ? error.message : String(error));
    }
  }

  /** 前端的一条 CDP 命令。browser 级方法直接走 browser session，其余补当前 sessionId。 */
  async send(method: string, params: Record<string, unknown> | undefined): Promise<SendResult> {
    if (!this.socket || this.state !== 'ready') {
      return { ok: false, error: { message: 'bridge-not-connected' } };
    }
    if (!BROWSER_LEVEL_METHODS.has(method) && !this.sessionId) {
      return { ok: false, error: { message: 'bridge-no-session' } };
    }
    const response = await this.sendRaw(method, params, BROWSER_LEVEL_METHODS.has(method) ? undefined : this.sessionId ?? undefined);
    if (response.error) return { ok: false, error: { message: response.error.message ?? 'cdp-error', code: response.error.code } };
    return { ok: true, result: response.result ?? null };
  }

  shutdown(): void {
    this.state = 'closed';
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.buffer = [];
    for (const resolve of this.pending.values()) resolve({ error: { message: 'bridge-shutdown' } });
    this.pending.clear();
    const socket = this.socket;
    this.socket = null;
    this.sessionId = null;
    this.targetId = null;
    if (socket) { try { socket.close(); } catch { /* ignore */ } }
  }

  private async ensureSocket(port: number): Promise<void> {
    if (this.socket && this.state === 'ready' && this.port === port) return;
    if (this.connecting) { await this.connecting; return; }
    this.state = 'connecting';
    this.connecting = (async () => {
      const wsUrl = await this.resolveBrowserWs(port);
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(wsUrl, { perMessageDeflate: false });
        const fail = (error: Error): void => {
          this.state = 'closed';
          reject(error);
        };
        socket.once('open', () => {
          this.socket = socket;
          this.port = port;
          this.state = 'ready';
          resolve();
        });
        socket.once('error', fail);
        socket.on('message', (raw) => this.handleMessage(raw.toString()));
        socket.on('close', () => {
          this.state = 'closed';
          this.socket = null;
          this.sessionId = null;
          this.targetId = null;
        });
      });
      log.info('[DevToolsBridge] browser ws ready:', wsUrl.replace(/\/devtools\/browser\/.*/, '/devtools/browser/…'));
    })();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  /** /json/version 的 webSocketDebuggerUrl 是唯一权威来源（不要手拼 uuid）。 */
  private resolveBrowserWs(port: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const request = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 2500 }, (response) => {
        let body = '';
        response.setEncoding('utf-8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          try {
            const parsed = JSON.parse(body) as { webSocketDebuggerUrl?: string };
            if (!parsed.webSocketDebuggerUrl) reject(new Error('no webSocketDebuggerUrl'));
            else resolve(parsed.webSocketDebuggerUrl);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });
      request.on('error', reject);
      request.on('timeout', () => { request.destroy(new Error('json/version timeout')); });
    });
  }

  private sendRaw(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<CdpMessage> {
    return new Promise((resolve) => {
      const socket = this.socket;
      if (!socket) { resolve({ error: { message: 'bridge-not-connected' } }); return; }
      const id = ++this.messageId;
      const message: CdpMessage = { id, method, params: params ?? {} };
      if (sessionId) message.sessionId = sessionId;
      const payload = JSON.stringify(message);
      this.counters.sent += 1;
      this.counters.bytesOut += payload.length;
      this.pending.set(id, resolve);
      socket.send(payload, (error) => {
        if (!error) return;
        this.pending.delete(id);
        resolve({ error: { message: error.message } });
      });
    });
  }

  private handleMessage(raw: string): void {
    this.counters.bytesIn += raw.length;
    let message: CdpMessage;
    try { message = JSON.parse(raw) as CdpMessage; } catch { return; }

    if (typeof message.id === 'number' && this.pending.has(message.id)) {
      const resolve = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (resolve) resolve(message);
      return;
    }
    if (!message.method) return;

    // Target 生命周期：session 失效时桥自己知道，不必依赖前端。
    if (message.method === 'Target.detachedFromTarget') {
      const detached = (message.params as { sessionId?: string } | undefined)?.sessionId;
      if (detached && detached === this.sessionId) {
        this.sessionId = null;
        this.targetId = null;
      }
      return;
    }

    // page-ws 等价语义：只把当前 session 的事件转给前端（browser 级事件前端在
    // page-ws 模式下本来就看不到，转发会造成行为差异）。
    if (message.sessionId && message.sessionId !== this.sessionId) {
      this.counters.eventsDropped += 1;
      return;
    }
    if (!message.sessionId) {
      this.counters.eventsDropped += 1;
      return;
    }
    this.counters.events += 1;
    const forwarded: CdpMessage = { method: message.method, params: message.params };
    this.buffer.push(forwarded);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        const batch = this.buffer;
        this.buffer = [];
        if (batch.length && this.sink) this.sink(batch);
      }, EVENT_FLUSH_MS);
      this.flushTimer.unref?.();
    }
  }
}

export const devToolsBridge = new DevToolsBridge();
