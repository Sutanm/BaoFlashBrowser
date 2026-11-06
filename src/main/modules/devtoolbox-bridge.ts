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
  /** sink 被调用的次数（调试用：区分"桥没发"与"renderer 没收到"）。 */
  sinkCalls?: number;
  bytesOut: number;
  bytesIn: number;
  /** 最近 40 条命令的方法名（调试用；只记名字，不含参数/结果）。 */
  recentMethods?: string[];
  /** 前端自己发起的 attach 记录（调试用：targetId 前缀 + 结果）。 */
  recentAttach?: Array<{ targetId: string; sessionId?: string; error?: string }>;
  /** 前 80 条命令/事件的方法名轨迹（调试用；只记方法名与 sessionId 前缀）。 */
  trace?: Array<{ d: 'cmd' | 'evt'; m: string; s?: string }>;
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
  private sinkCalls = 0;
  private recent: string[] = [];
  private recentAttach: Array<{ targetId: string; sessionId?: string; error?: string }> = [];
  private trace: Array<{ d: 'cmd' | 'evt'; m: string; s?: string }> = [];

  private record(d: 'cmd' | 'evt', method: string, sessionId?: string): void {
    // 调试轨迹：过滤高频噪音，保住初始化序列（CSS/Network 事件会瞬间冲掉环形缓冲）。
    if (d === 'evt' && !/^(DOM|Target|Inspector|Page|CSS.document|Emulation.)/.test(method)) return; // 只留关键事件+全部命令
    this.trace.push({ d, m: method, s: sessionId ? sessionId.slice(0, 6) : undefined });
    if (this.trace.length > 120) this.trace.shift();
  }

  setEventSink(sink: ((events: CdpMessage[]) => void) | null): void {
    this.sink = sink;
  }

  getStats(): BridgeStats {
    return {
      state: this.state,
      targetId: this.targetId,
      sessionId: this.sessionId,
      ...this.counters,
      recentMethods: this.recent.slice(),
      recentAttach: this.recentAttach.slice(),
      trace: this.trace.slice(),
      sinkCalls: this.sinkCalls,
    };
  }

  /** 把当前活动标签的 target 挂到桥上（切标签时重新调用）。 */
  async attach(targetId: string, port: number): Promise<{ sessionId: string }> {
    if (this.targetId === targetId && this.sessionId) return { sessionId: this.sessionId };
    const run = async (): Promise<{ sessionId: string }> => {
      await this.ensureSocket(port);
      if (this.sessionId) await this.detach();

      this.targetId = targetId;
      this.targetInfo = null;
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
    };
    this.attaching = run();
    try {
      return await this.attaching;
    } finally {
      this.attaching = null;
    }
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

  /**
   * 前端的一条 CDP 命令。
   *
   * 语义：桥给前端一个**只有当前标签 target** 的世界（page-ws 等价）。
   * M97 前端会自动 `Target.setAutoAttach` 把看得到的 target 全挂上，若放行它
   * 会 attach 到 DevTools 自己/外壳等 target，命令与事件落到不同 session、
   * nodeId 空间错乱 —— 实测表现就是 Elements 只有空 html/head/body +
   * Styles 无限刷 CSS.getMatchedStylesForNode。所以 Target 发现类方法在此被
   * 拦截成"只有一个 target"的假象。
   */
  async send(method: string, params: Record<string, unknown> | undefined, _sessionId?: string): Promise<SendResult> {
    if (!this.socket || this.state !== 'ready') {
      return { ok: false, error: { message: 'bridge-not-connected' } };
    }
    const intercepted = await this.interceptTargetMethod(method);
    if (intercepted) return intercepted;

    // 前端自己带 sessionId 时忽略它（参数保留以对齐 IPC 契约）——桥只认自己的 session（单 target 世界）。
    const resolved = BROWSER_LEVEL_METHODS.has(method) ? undefined : this.sessionId ?? undefined;
    if (!resolved && !BROWSER_LEVEL_METHODS.has(method)) {
      return { ok: false, error: { message: 'bridge-no-session' } };
    }
    const response = await this.sendRaw(method, params, resolved);
    if (response.error) return { ok: false, error: { message: response.error.message ?? 'cdp-error', code: response.error.code } };
    return { ok: true, result: response.result ?? null };
  }

  /** 把 Target 发现/attach 类方法伪造成"只有一个 target"（见 send 的注释）。 */
  private async interceptTargetMethod(method: string): Promise<SendResult | null> {
    switch (method) {
      case 'Target.setDiscoverTargets':
      case 'Target.setAutoAttach':
      case 'Target.detachFromTarget':
        return { ok: true, result: {} };
      case 'Target.attachToTarget': {
        // 前端在 `hello` 之后立刻就会发这条，可能早于桥自己的 attach 完成；
        // 必须等它（否则前端 fallback 到真 Chromium 分配 session，命令与事件
        // 分属两个 session，nodeId 空间错乱）。
        const sessionId = await this.currentOrPendingSession();
        return sessionId
          ? { ok: true, result: { sessionId } }
          : { ok: false, error: { message: 'bridge-no-session' } };
      }
      case 'Target.getTargets': {
        const info = await this.readTargetInfo();
        return { ok: true, result: { targetInfos: info ? [info] : [] } };
      }
      case 'Target.getTargetInfo': {
        const info = await this.readTargetInfo();
        return info
          ? { ok: true, result: { targetInfo: info } }
          : { ok: false, error: { message: 'bridge-no-target' } };
      }
      default:
        return null;
    }
  }

  private async currentOrPendingSession(): Promise<string | null> {
    if (this.sessionId) return this.sessionId;
    if (this.attaching) {
      try { await this.attaching; } catch { /* attach 失败时按无 session 处理 */ }
      return this.sessionId;
    }
    return null;
  }

  private targetInfo: { targetId: string; type: string; title: string; url: string; attached: boolean } | null = null;
  private attaching: Promise<{ sessionId: string }> | null = null;

  private async readTargetInfo(): Promise<{ targetId: string; type: string; title: string; url: string; attached: boolean } | null> {
    if (this.targetInfo) return this.targetInfo;
    if (!this.targetId) return null;
    const response = await this.sendRaw('Target.getTargetInfo', { targetId: this.targetId });
    const info = (response.result as { targetInfo?: { targetId: string; type: string; title: string; url: string; attached: boolean } } | undefined)?.targetInfo;
    if (!info) return null;
    this.targetInfo = { targetId: info.targetId, type: info.type ?? 'page', title: info.title ?? '', url: info.url ?? '', attached: true };
    return this.targetInfo;
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
      this.recent.push(method);
      this.record('cmd', method, 'in:' + (sessionId ? sessionId.slice(0, 6) : '-'));
      if (this.recent.length > 40) this.recent.shift();
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

    // 事件只转发桥自己的 session（单个 target 世界），并剥掉 sessionId：
    // page-ws 连接天生绑定单一 target，Chromium 下发的事件不带 sessionId，
    // M97 前端只认这种形态（带 sessionId 会被丢弃）。前端世界是单 target，
    // 所以不需要关心其他 session 的事件。
    if (!message.sessionId || message.sessionId !== this.sessionId) {
      this.counters.eventsDropped += 1;
      // 调试：记录被丢弃的关键域事件（看 sessionId 是否与桥 session 不一致）
      if (/^(DOM|Page|Inspector)./.test(message.method)) {
        this.trace.push({ d: 'evt', m: 'DROP:' + message.method, s: (message.sessionId || 'none').slice(0, 6) });
        if (this.trace.length > 120) this.trace.shift();
      }
      return;
    }
    this.counters.events += 1;
    this.record('evt', message.method, message.sessionId);
    const forwarded: CdpMessage = { method: message.method, params: message.params };
    this.buffer.push(forwarded);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        const batch = this.buffer;
        this.buffer = [];
        if (batch.length && this.sink) { this.sinkCalls += 1; this.sink(batch); }
      }, EVENT_FLUSH_MS);
      this.flushTimer.unref?.();
    }
  }
}

export const devToolsBridge = new DevToolsBridge();
