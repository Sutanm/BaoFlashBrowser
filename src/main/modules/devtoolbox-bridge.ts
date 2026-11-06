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
import { listDebugTargets } from './devtoolbox-targets';

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
  /**
   * 被桥主动判失败的前端请求数（换 target / 断链 / 超时）。
   * 这些请求本来会永远 pending，前端表现为面板一直转圈。
   */
  failed?: number;
  /** sink 被调用的次数（调试用：区分"桥没发"与"renderer 没收到"）。 */
  sinkCalls?: number;
  /** 最近 60 条命令的方法名（调试用，独立于环形缓冲）。 */
  lastMethods?: string[];
  /** 最近一次 DOM.getDocument 响应摘要（调试用：rootId/子节点数）。 */
  lastDoc?: string | null;
  bytesOut: number;
  bytesIn: number;
  /** 最近 40 条命令的方法名（调试用；只记名字，不含参数/结果）。 */
  recentMethods?: string[];
  /** 前端自己发起的 attach 记录（调试用：targetId 前缀 + 结果）。 */
  recentAttach?: Array<{ targetId: string; sessionId?: string; error?: string }>;
  /** 前 80 条命令/事件的方法名轨迹（调试用；只记方法名与 sessionId 前缀）。 */
  trace?: Array<{ d: 'cmd' | 'evt'; m: string; s?: string }>;
  /** 双向消息流水（调试用，与 tools/devtools-spike/page-ws-baseline-capture.cjs 的代理格式一致）。 */
  flow?: Array<{ d: '>' | '<'; m: string; s?: string; x?: string }>;
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
/** 前端请求的兜底超时（见 sendRaw 注释）。正常命令都是毫秒级，15s 只兜异常。 */
const FRONTEND_REQUEST_TIMEOUT_MS = 15000;

/**
 * 设计上就是长轮询的方法：不能套兜底超时。
 *
 * `CSS.takeComputedStyleUpdates` 在 Chrome 88+ 引入，语义是"有变化才回包"，
 * 可能长时间不回；87 的后端即使实现了也不会主动结束。给它 15s 超时会在
 * CSS 模型里制造一个错误响应，前端随后就画不出样式（实测：重开容器后
 * Styles 面板永久空白）。
 */
const LONG_POLL_METHODS = new Set(['CSS.takeComputedStyleUpdates']);

/**
 * raw 模式（BAO_DEVTOOLS_BRIDGE_RAW=1）：完全不做 Target 重写，按 page-ws 的真实
 * 语义转发——这正是 S14 基线抓出来的形态：
 *   page-ws 下前端自己发 setDiscoverTargets/setAutoAttach，Chromium 回 targetCreated
 *   事件（**带 browser 级 scope，无 sessionId**，且所有 target 都 attached:true），
 *   前端据此正常工作。桥此前把 browser 级事件一律丢弃、再伪造一条 targetCreated，
 *   等于替前端编了个残缺的世界。
 * raw 模式保留命令侧的 sessionId 适配（前端不带 sessionId，桥补自己的），其余全透传。
 */
const RAW_MODE = process.env.BAO_DEVTOOLS_BRIDGE_RAW === '1';

type SendResult = { ok: true; result: unknown } | { ok: false; error: { message: string; code?: number } };

class DevToolsBridge {
  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private messageId = 0;
  private pending = new Map<number, {
    resolve: (msg: CdpMessage) => void;
    method: string;
    params?: Record<string, unknown>;
    internal?: boolean;
    /** 入队给前端时用这个 id（前端自己的请求 id），不是桥内部的 messageId。 */
    frontendId?: number;
    /** 前端请求的兜底超时（换 session / socket 断开都靠它或 failPending 收尾）。 */
    timer?: NodeJS.Timeout;
    /** 发起这条请求时的前端实例代号（见 frontendEpoch）。 */
    epoch?: number;
  }>();

  /**
   * 前端实例代号。每次新建 DevTools 容器（切工具箱页签、重开抽屉、开独立窗口）都 +1。
   *
   * 为什么必须有：前端的请求 id 是**每条连接各自从 1 开始**的。旧前端留下的请求
   * （典型是 `CSS.takeComputedStyleUpdates` 这种长轮询）如果在新前端起来之后才被
   * 兜底超时判失败，那条错误信封带的是旧 id，会正好命中新前端某个正在进行的请求；
   * 新前端把错误当成自己的，CSS 模型就此失效——**样式面板永久空白**。
   * 所以换实例时静默丢弃旧请求，绝不再往回发信封。
   */
  private frontendEpoch = 0;

  private sessionId: string | null = null;
  private targetId: string | null = null;
  private sink: ((events: CdpMessage[]) => void) | null = null;
  private buffer: CdpMessage[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private port: number | null = null;
  private state: BridgeStats['state'] = 'idle';
  private counters = { sent: 0, events: 0, eventsDropped: 0, bytesOut: 0, bytesIn: 0, failed: 0 };
  private sinkCalls = 0;
  private lastDoc: string | null = null;
  private lastMethods: string[] = [];
  private recent: string[] = [];
  private recentAttach: Array<{ targetId: string; sessionId?: string; error?: string }> = [];
  private trace: Array<{ d: 'cmd' | 'evt'; m: string; s?: string }> = [];
  private flow: Array<{ d: '>' | '<'; m: string; s?: string; x?: string }> = [];
  /** 前端发过的开关类命令（切标签时重放到新 session）。 */
  private frontendState = new Map<string, Record<string, unknown>>();

  /**
   * 与 page-ws-baseline-capture 的 proxy summarise() 保持同一口径，
   * 这样两边的流水可以直接 diff（这是定位「树为什么不同」的唯一硬手段）。
   */
  private static summarise(method: string, params?: Record<string, unknown>, result?: unknown, error?: { message?: string }): string | undefined {
    // 响应优先（同一 method 的请求/响应摘要不同，必须先判别）。
    if (error) return `ERR=${String(error.message || 'err').slice(0, 50)}`;
    if (result !== undefined) {
      const r = result as Record<string, unknown>;
      const root = r.root as { nodeName?: string; childNodeCount?: number; children?: unknown[]; documentURL?: string } | undefined;
      if (root) return `root=${root.nodeName} kids=${root.childNodeCount} inline=${(root.children || []).length} url=${String(root.documentURL || '').slice(0, 30)}`;
      const ti = r.targetInfo as { type?: string; attached?: boolean; url?: string } | undefined;
      if (ti) return `type=${ti.type} attached=${ti.attached} url=${String(ti.url || '').slice(0, 30)}`;
      return undefined;
    }
    const p = params ?? {};
    if (method === 'DOM.getDocument') return `depth=${p.depth} pierce=${p.pierce}`;
    if (method === 'DOM.requestChildNodes') return `nodeId=${p.nodeId} depth=${p.depth}`;
    if (method === 'DOM.setChildNodes') {
      const nodes = (p.nodes as Array<{ nodeName?: string; nodeId?: number; childNodeCount?: number; attributes?: string[] }> | undefined) ?? [];
      const names = nodes.slice(0, 8).map((n) => `${n.nodeName}${n.childNodeCount ? '(' + n.childNodeCount + ')' : ''}`);
      return `parentId=${p.parentId} n=${nodes.length} [${names.join(',')}]`;
    }
    if (method === 'Target.setAutoAttach') return `autoAttach=${p.autoAttach} flatten=${p.flatten} wait=${p.waitForDebuggerOnStart}`;
    if (method === 'Target.setDiscoverTargets') return `discover=${p.discover}`;
    if (method === 'Target.targetCreated' || method === 'Target.attachedToTarget') {
      const info = p.targetInfo as { type?: string; attached?: boolean; url?: string } | undefined;
      return `type=${info?.type} attached=${info?.attached} url=${String(info?.url || '').slice(0, 30)}`;
    }
    return undefined;
  }

  private recordFlow(d: '>' | '<', method: string, sessionId?: string, extra?: string): void {
    // 事件噪音（脚本列表/控制台输出）会把环形缓冲瞬间冲掉，初始化的关键序列就没了。
    if (method === 'Debugger.scriptParsed' || method === 'Runtime.consoleAPICalled' || method === 'CSS.styleSheetAdded') return;
    this.flow.push({ d, m: method, s: sessionId ? sessionId.slice(0, 6) : undefined, x: extra });
    if (this.flow.length > 600) this.flow.shift();
  }

  private record(d: 'cmd' | 'evt', method: string, sessionId?: string): void {
    // 独立命令流：不受 120 条环形缓冲影响，能看到前端最近发的命令。
    if (d === 'cmd') {
      this.lastMethods.push(method);
      if (this.lastMethods.length > 60) this.lastMethods.shift();
    }
    // 调试轨迹：过滤高频噪音，保住初始化序列（CSS/Network 事件会瞬间冲掉环形缓冲）。
    if (d === 'evt' && !/^(DOM|Target|Inspector|Page|CSS\.document|Emulation\.)/.test(method)) return;
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
      lastDoc: this.lastDoc,
      lastMethods: this.lastMethods.slice(),
      flow: this.flow.slice(),
    };
  }

  /** 把当前活动标签的 target 挂到桥上（切标签时重新调用）。 */
  async attach(targetId: string, port: number): Promise<{ sessionId: string }> {
    if (this.targetId === targetId && this.sessionId) return { sessionId: this.sessionId };
    const run = async (): Promise<{ sessionId: string }> => {
      await this.ensureSocket(port);
      const previousTarget = this.targetId;
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

      // 切标签（换 target）或换了新前端实例：前端没有重新连过，它只发过一次
      // 初始化命令，新 session 上这些域一个都没开。把前端此前发过的「开关类」
      // 命令按最新参数重放一遍，再宣告文档已换，前端就会重建 Elements/Console。
      if (previousTarget && previousTarget !== targetId) {
        await this.replayFrontendState(sessionId);
        this.enqueue({ method: 'DOM.documentUpdated' });
        this.enqueue({ method: 'Runtime.executionContextsCleared' });
      }
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

  /**
   * 记录前端发过的「开关类」命令（enable / setXxx / trackXxx / startXxx）。
   *
   * 切标签时桥换了 target，前端并不知道自己连的已经换了一页，它不会重发初始化
   * 命令；新 session 上 DOM/Runtime/CSS 等域一个都没开，前端就再也收不到事件。
   * 把这份记录按方法去重（保留最新参数）后重放，前端就能在新 session 上续上。
   * 只记开关类，不记 getDocument 这类一次性查询。
   */
  private rememberFrontendState(method: string, params: Record<string, unknown> | undefined): void {
    if (!/\.(enable|disable|set[A-Z]|track[A-Z]|start[A-Z])/.test(method)) return;
    this.frontendState.set(method, params ?? {});
  }

  private async replayFrontendState(sessionId: string): Promise<void> {
    let replayed = 0;
    for (const [method, params] of this.frontendState) {
      // 单条命令卡住不能拖死切标签流程：400ms 上限，超时只记日志。
      await Promise.race([
        this.sendRaw(method, params, sessionId),
        new Promise((resolve) => setTimeout(resolve, 400)),
      ]);
      replayed += 1;
    }
    log.info(`[DevToolsBridge] replayed ${replayed} stateful commands onto new session`);
  }

  async detach(): Promise<void> {    if (!this.sessionId) return;
    const sessionId = this.sessionId;
    // 换 target 前先把在途的前端请求失败掉：旧 session 上的响应永远不会回来，
    // 不主动失败的话前端那边就是一个永远 pending 的 Promise——「样式一直转圈」
    // 就是这么来的（CSS.getMatchedStylesForNode 发在旧 session 上）。
    this.failPending('bridge-detached');
    this.sessionId = null;
    this.targetId = null;
    try {
      await this.sendRaw('Target.detachFromTarget', { sessionId });
    } catch (error) {
      log.warn('[DevToolsBridge] detach 失败（忽略）:', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * 新的前端实例接管连接（新建 / 重建 DevTools 容器时调用）。
   *
   * 旧实例的请求 id 空间随之作废：**静默**丢弃它们的在途请求，绝不回发信封——
   * 否则那条迟到错误会命中新实例里同号的请求（表现：Styles 永久空白）。
   */
  beginFrontendSession(): void {
    this.frontendEpoch += 1;
    if (this.pending.size === 0) return;
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve({ error: { message: 'frontend-replaced' } });
      this.pending.delete(id);
    }
  }

  /**
   * 把所有「前端发起、还在等响应」的请求立刻判失败并告诉前端。
   *
   * 换 target / socket 断开 / 关闭时，旧 session 上在途的请求不可能再有响应。
   * 桥自己不失败它们，前端就永远等（它的 Promise 没有超时）——用户看到的是
   * Styles/Computed 一直转圈、只能重新点一次节点才恢复。
   */
  private failPending(reason: string): void {
    if (this.pending.size === 0) return;
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      // 只有同一个前端实例才通知：旧实例的请求号在新实例里是别人的
      if (!entry.internal && typeof entry.frontendId === 'number' && entry.epoch === this.frontendEpoch) {
        this.enqueue({ id: entry.frontendId, error: { message: reason } });
        this.counters.failed += 1;
      }
      entry.resolve({ error: { message: reason } });
      this.pending.delete(id);
    }
  }

  /**
   * 前端的一条 CDP 命令。
   *
   * `requestId` 由前端给出时（BfbBridgeConnection 一定给），**响应走有序流**：
   * 与事件同一条队列、同一个 16ms 合批窗口，模拟 WebSocket 的严格串行语义。
   * 这一点是 S15 的核心结论——早先响应走 IPC promise 快车道、事件走合批队列，
   * 两者顺序被打乱（`DOM.setChildNodes` 可能先于它所属请求的响应到达），前端
   * 把子节点挂到还没建立的父节点上直接丢弃，表现就是「Elements 树残缺/闪回旧文档」。
   *
   * 不给 `requestId` 时（命令行探针）保持同步返回结果，便于脚本直接断言。
   */
  async send(
    method: string,
    params: Record<string, unknown> | undefined,
    _sessionId?: string,
    requestId?: number,
  ): Promise<SendResult> {
    const deliver = typeof requestId === 'number';
    const finish = (result: SendResult): SendResult => {
      if (!deliver) return result;
      if (result.ok) this.enqueue({ id: requestId, result: result.result });
      else this.enqueue({ id: requestId, error: { message: result.error.message, code: result.error.code } });
      return { ok: true, result: null };
    };

    if (!this.socket || this.state !== 'ready') {
      return finish({ ok: false, error: { message: 'bridge-not-connected' } });
    }
    if (!RAW_MODE) {
      const intercepted = await this.interceptTargetMethod(method);
      if (intercepted) return finish(intercepted);
    }

    // 前端带 sessionId 时忽略（桥只认自己的 session，单 target 世界）。
    const resolved = BROWSER_LEVEL_METHODS.has(method) ? undefined : this.sessionId ?? undefined;
    if (!resolved && !BROWSER_LEVEL_METHODS.has(method)) {
      return finish({ ok: false, error: { message: 'bridge-no-session' } });
    }
    const response = await this.sendRaw(method, params, resolved, !deliver, deliver ? requestId : undefined);
    if (deliver) this.rememberFrontendState(method, params);
    if (method === 'DOM.getDocument') {
      const root = (response.result as { root?: { nodeId?: number; childNodeCount?: number } } | undefined)?.root;
      this.lastDoc = response.error
        ? 'ERR ' + (response.error.message ?? '?')
        : 'root=' + String(root?.nodeId) + ' kids=' + String(root?.childNodeCount);
    }
    if (deliver) {
      // 响应已在 handleMessage 里按到达顺序入队（sendRaw 的 internal=false 分支）。
      return { ok: true, result: null };
    }
    if (response.error) return { ok: false, error: { message: response.error.message ?? 'cdp-error', code: response.error.code } };
    return { ok: true, result: response.result ?? null };
  }

  /**
   * 把 Target 域**按 page-ws 的真实语义**模拟（S14 基线逐条对齐）。
   *
   * page-ws 的连接天生绑一个 target，Target 域在它上面表现为：
   *  - `setAutoAttach` 只作用于“该页面的子 target”（本页无 iframe/worker → 无事件）；
   *  - `setDiscoverTargets(true)` 会收到**全应用所有 page target** 的 `targetCreated`，
   *    且都是 `attached: true`（前端据此建 TargetManager 记录，不做二次 attach）；
   *  - `getTargets/getTargetInfo` 正常返回；
   *  - `attachToTarget` 前端根本不会发（主 target 由连接隐含）。
   */
  private async interceptTargetMethod(method: string): Promise<SendResult | null> {
    switch (method) {
      case 'Target.setAutoAttach':
        // 绝不能转发到 browser 级：那会把无关 target（外壳、前端自身）attach 到本连接
        // 并回 Target.attachedToTarget，前端拿到别人的 sessionId，随后命令与事件分属
        // 两个 session（S15 实测两条 attachedToTarget → nodeId 空间错乱）。
        return { ok: true, result: {} };
      case 'Target.setDiscoverTargets': {
        const targets = await listDebugTargets();
        for (const item of targets) {
          if (item.type !== 'page') continue;
          this.enqueue({
            method: 'Target.targetCreated',
            params: {
              targetInfo: {
                targetId: item.id,
                type: item.type,
                title: item.title,
                url: item.url,
                attached: true,
                canAccessOpener: false,
              },
            },
          });
        }
        return { ok: true, result: {} };
      }
      case 'Target.detachFromTarget':
        return { ok: true, result: {} };
      case 'Target.attachToTarget': {
        // 前端正常不会发；发了就给桥自己的 session（前端世界只有一个 target）。
        const sessionId = await this.currentOrPendingSession();
        return sessionId
          ? { ok: true, result: { sessionId } }
          : { ok: false, error: { message: 'bridge-no-session' } };
      }
      default:
        return null;
    }
  }

  /** 一条消息进有序队列（响应与事件共用，保证与 WebSocket 同样的串行语义）。 */
  private enqueue(message: CdpMessage): void {
    this.buffer.push(message);
    this.scheduleFlush();
  }

  /** 把合批队列排空到 sink（16ms 窗口，顺序即入队顺序）。 */
  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const batch = this.buffer;
      this.buffer = [];
      if (batch.length && this.sink) { this.sinkCalls += 1; this.sink(batch); }
    }, EVENT_FLUSH_MS);
    this.flushTimer.unref?.();
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
    // 先把在途的前端请求判失败（会入队错误响应），再同步投递一次——
    // 不然这些错误信封跟着 buffer 一起被清掉，等于没通知前端。
    this.failPending('bridge-shutdown');
    const pendingErrors = this.buffer;
    this.buffer = [];
    if (pendingErrors.length && this.sink) {
      try { this.sink(pendingErrors); } catch { /* sink 已失效，忽略 */ }
    }
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

  private sendRaw(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    internal = true,
    frontendId?: number,
  ): Promise<CdpMessage> {
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
      this.recordFlow('>', method, sessionId, DevToolsBridge.summarise(method, params));
      this.pending.set(id, { resolve, method, params, internal, frontendId, epoch: this.frontendEpoch });
      // 前端请求的兜底超时：正常路径靠 detach/断链的 failPending 收尾，
      // 但 target 卡死、session 半死不活时响应可能永远不来；不兜底前端就一直转圈。
      // 例外：`CSS.takeComputedStyleUpdates` 是**设计上的长轮询**（Chrome 88+ 才有，
      // 87 后端可能永远不回），给它套超时只会在 15s 后往 CSS 模型里塞一个错误。
      if (!internal && typeof frontendId === 'number' && !LONG_POLL_METHODS.has(method)) {
        const timeout = setTimeout(() => {
          const entry = this.pending.get(id);
          if (!entry) return;
          this.pending.delete(id);
          this.counters.failed += 1;
          log.warn('[DevToolsBridge] 请求超时:', method);
          // 只有同一个前端实例才通知：旧实例的 id 在新实例里是别人的请求号
          if (entry.epoch === this.frontendEpoch) {
            this.enqueue({ id: frontendId, error: { message: 'bridge-timeout' } });
          }
          resolve({ error: { message: 'bridge-timeout' } });
        }, FRONTEND_REQUEST_TIMEOUT_MS);
        timeout.unref?.();
        const entry = this.pending.get(id);
        if (entry) entry.timer = timeout;
      }
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
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (entry) {
        if (entry.timer) clearTimeout(entry.timer);
        this.recordFlow('<', entry.method, message.sessionId,
          DevToolsBridge.summarise(entry.method, entry.params, message.result, message.error));
        // 前端的命令：响应入有序队列（与事件同一条流水），前端按 id 自行关联。
        // id 必须是**前端的请求 id**——桥内部的 messageId 前端不认识。
        if (!entry.internal && typeof entry.frontendId === 'number') {
          const envelope: CdpMessage = { id: entry.frontendId };
          if (message.error) envelope.error = message.error;
          else envelope.result = message.result ?? null;
          this.enqueue(envelope);
        }
        entry.resolve(message);
      }
      return;
    }
    if (!message.method) return;
    this.recordFlow('<', message.method, message.sessionId,
      DevToolsBridge.summarise(message.method, message.params as Record<string, unknown> | undefined));

    // Target 生命周期：session 失效时桥自己知道，不必依赖前端。
    if (message.method === 'Target.detachedFromTarget') {
      const detached = (message.params as { sessionId?: string } | undefined)?.sessionId;
      if (detached && detached === this.sessionId) {
        // 目标自己没了（页面崩了/进程退出）：在途请求同样不可能有响应，先失败掉
        this.failPending('bridge-detached');
        this.sessionId = null;
        this.targetId = null;
      }
      return;
    }

    // raw 模式：按 page-ws 真实语义转发。
    //  - 桥 session 的事件：剥掉 sessionId（page-ws 下不带）
    //  - browser 级 Target.* 事件（无 sessionId）：照转（page-ws 下前端能看到全部 target）
    //  - 其余无 sessionId 的事件（其他 session 的噪声）：丢弃
    if (RAW_MODE) {
      const ownSession = Boolean(message.sessionId) && message.sessionId === this.sessionId;
      const browserTargetEvent = !message.sessionId && message.method.startsWith('Target.');
      if (!ownSession && !browserTargetEvent) {
        this.counters.eventsDropped += 1;
        return;
      }
      this.counters.events += 1;
      this.record('evt', message.method, message.sessionId);
      this.buffer.push({ method: message.method, params: message.params });
      this.scheduleFlush();
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
    this.scheduleFlush();
  }
}

export const devToolsBridge = new DevToolsBridge();
