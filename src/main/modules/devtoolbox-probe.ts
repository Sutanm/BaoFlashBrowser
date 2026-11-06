/**
 * Flash 探测的 CDP 深探：把「跨域 / 嵌套 / 无 JS 上下文」的 frame 也扫一遍。
 *
 * 只说 `executeJavaScript` 的话，工具箱只能看主文档 + 同源 iframe 两层：
 * - 跨域 iframe 的 document 读不到（Electron 11 没有 `mainFrame`）；
 * - 直接以 `.swf` 作为 frame URL 的 PPAPI 文档没有可用的执行上下文；
 * - 老 XHTML 游戏页的 `<object>` 在命名空间里，`querySelectorAll` 选不到。
 *
 * 这里用的是 DevTools 自己的办法（同 `automation/game-surface-detector.ts`）：
 * `Page.getFrameTree` 拿到全部 frame → 每个 frame `Page.createIsolatedWorld`
 * 建一个独立世界（跨域也能建）→ 在里面 `Runtime.evaluate`；OOPIF（独立进程的
 * 跨域 iframe）再走 `Target.setAutoAttach` 的独立 session；最后用 DOM 域兜底。
 *
 * **传输走端口上的独立 page 连接，不用 `wc.debugger`**：embedded 调试器被密码
 * 捕获/填充占着（cdp-lease 的自动化租约是另一套语义），工具箱插进去会让捕获拿到
 * `already attached by an unmanaged client`。page target 允许多个客户端并存
 * （规格里的「page-ws × 2 共存」实测过）。
 */
import WebSocket from 'ws';

export interface DeepFrame {
  url: string;
  depth: number;
  sameOrigin: boolean;
  /** 是否真的在它里面跑过探测脚本（OOPIF / 无 JS 上下文时为 false）。 */
  readable: boolean;
}

export interface DeepSwf {
  url: string;
  kind: 'embed' | 'object' | 'param' | 'resource' | 'frame';
  width?: number;
  height?: number;
  /** 这条 SWF 是在哪个 frame 里找到的（frame URL）。 */
  frameUrl?: string;
}

export interface DeepProbe {
  frames: DeepFrame[];
  swf: DeepSwf[];
  plugins: number;
  /** 每种手段的命中数，排障用（isolation / session / dom / frame-url）。 */
  via: Record<string, number>;
  elapsedMs: number;
}

type CdpMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
  sessionId?: string;
};

const COMMAND_TIMEOUT_MS = 3000;
const OPEN_TIMEOUT_MS = 4000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

class CdpClient {
  private socket: WebSocket;

  private seq = 0;

  private pending = new Map<number, (message: CdpMessage) => void>();

  private listeners: Array<(message: CdpMessage) => void> = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (raw: WebSocket.RawData) => {
      let message: CdpMessage;
      try { message = JSON.parse(raw.toString()) as CdpMessage; } catch { return; }
      if (typeof message.id === 'number' && this.pending.has(message.id)) {
        const resolve = this.pending.get(message.id);
        this.pending.delete(message.id);
        resolve?.(message);
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
    socket.on('close', () => {
      for (const resolve of [...this.pending.values()]) resolve({ error: { message: 'socket-closed' } });
      this.pending.clear();
    });
  }

  static open(url: string): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { perMessageDeflate: false });
      const timer = setTimeout(() => {
        try { socket.close(); } catch { /* ignore */ }
        reject(new Error('cdp-open-timeout'));
      }, OPEN_TIMEOUT_MS);
      socket.once('open', () => { clearTimeout(timer); resolve(new CdpClient(socket)); });
      socket.once('error', (error: Error) => { clearTimeout(timer); reject(error); });
    });
  }

  on(listener: (message: CdpMessage) => void): void { this.listeners.push(listener); }

  /** 永不抛：失败统一成 `{ error }`，调用方按结果分支。 */
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<CdpMessage> {
    const id = (this.seq += 1);
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: { message: 'timeout' } });
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
      try { this.socket.send(JSON.stringify(payload)); } catch { clearTimeout(timer); this.pending.delete(id); resolve({ error: { message: 'send-failed' } }); }
    });
  }

  close(): void {
    try { this.socket.close(); } catch { /* ignore */ }
  }
}

/** 在每个 frame 自己的上下文里跑：只找「这个 frame 里的 SWF 与插件实例」。 */
const FRAME_PROBE = `(function () {
  function abs(value) {
    try { return new URL(value, location.href).href; } catch (e) { return String(value || ''); }
  }
  function isSwf(url) { return /\\.swf(?:$|[?#])/i.test(String(url || '')); }
  function dim(value) { var n = Number(value); return isFinite(n) && n > 0 ? Math.round(n) : undefined; }
  var found = []; var seen = Object.create(null); var plugins = 0; var visited = [];
  function seenNode(node) {
    for (var i = 0; i < visited.length; i += 1) if (visited[i] === node) return true;
    visited.push(node);
    return false;
  }
  function push(url, kind, width, height) {
    var full = abs(url);
    if (!isSwf(full)) return;
    var key = kind + '|' + full;
    if (seen[key]) return;
    seen[key] = true;
    found.push({ url: full, kind: kind, width: dim(width), height: dim(height) });
  }
  function scan(nodes) {
    for (var i = 0; i < (nodes ? nodes.length : 0); i += 1) {
      var node = nodes[i];
      var tag = String(node.tagName || '').toLowerCase();
      if (seenNode(node)) continue;
      if (tag === 'param') {
        if (String(node.getAttribute('name') || '').toLowerCase() === 'movie') push(node.value || node.getAttribute('value'), 'param');
        continue;
      }
      var type = String(node.getAttribute('type') || '').toLowerCase();
      var src = node.getAttribute('src') || node.getAttribute('data');
      if (type.indexOf('shockwave') !== -1 || isSwf(abs(src))) plugins += 1;
      push(src, tag === 'object' ? 'object' : 'embed', node.clientWidth || node.width, node.clientHeight || node.height);
    }
  }
  try { scan(document.querySelectorAll('embed,object,param,ruffle-player,ruffle-embed')); } catch (e) { /* ignore */ }
  // 老 XHTML 游戏页的节点常带命名空间，querySelectorAll 选不到，按标签名再扫一遍
  var names = ['embed', 'object', 'param'];
  for (var n = 0; n < names.length; n += 1) {
    try { scan(document.getElementsByTagName(names[n])); } catch (e) { /* ignore */ }
    try { scan(document.getElementsByTagNameNS('*', names[n])); } catch (e) { /* ignore */ }
  }
  try {
    var list = performance.getEntriesByType('resource');
    for (var j = 0; j < list.length; j += 1) push(list[j].name, 'resource');
  } catch (e) { /* ignore */ }
  return { href: location.href, swf: found, plugins: plugins };
})()`;

interface FrameRecord { id: string; parentId?: string; url: string; depth: number }

function frameTreeRecords(tree: unknown, baseDepth = 0): Map<string, FrameRecord> {
  const records = new Map<string, FrameRecord>();
  const visit = (node: unknown, parentId: string | undefined, depth: number): void => {
    if (!node || typeof node !== 'object') return;
    const value = node as { frame?: { id?: unknown; url?: unknown }; childFrames?: unknown[] };
    const id = typeof value.frame?.id === 'string' ? value.frame.id : '';
    if (!id) return;
    records.set(id, { id, parentId, url: typeof value.frame?.url === 'string' ? value.frame.url : '', depth });
    for (const child of value.childFrames ?? []) visit(child, id, depth + 1);
  };
  const root = tree && typeof tree === 'object' ? (tree as { frameTree?: unknown }).frameTree : undefined;
  visit(root, undefined, baseDepth);
  return records;
}

function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return ''; }
}

function safeUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'about:') return value;
    return `${parsed.origin}${parsed.pathname}`.slice(0, 600);
  } catch { return String(value || '').split(/[?#]/u)[0].slice(0, 600); }
}

interface RawFrameProbe {
  href?: string;
  swf?: Array<{ url?: string; kind?: string; width?: number; height?: number }>;
  plugins?: number;
}

function absorb(
  target: { swf: Map<string, DeepSwf>; plugins: number },
  frameUrl: string,
  value: RawFrameProbe | undefined,
): number {
  let hit = 0;
  for (const item of value?.swf ?? []) {
    const url = typeof item.url === 'string' ? item.url : '';
    if (!url) continue;
    const kind = item.kind === 'object' || item.kind === 'param' ? item.kind : item.kind === 'resource' ? 'resource' : 'embed';
    const key = `${kind}|${url}`;
    if (!target.swf.has(key)) {
      target.swf.set(key, {
        url,
        kind,
        width: item.width,
        height: item.height,
        frameUrl: safeUrl(frameUrl) || undefined,
      });
      hit += 1;
    }
  }
  target.plugins += Math.max(0, Number(value?.plugins) || 0);
  return hit;
}

/**
 * 深探一个 page target。失败（没端口 / 页面正在导航 / 版本不支持）返回 null，
 * 调用方退回主文档探测——**深探只是增强，绝不能成为探测的前置条件**。
 */
export async function probeFramesDeep(wsUrl: string): Promise<DeepProbe | null> {
  const startedAt = Date.now();
  let client: CdpClient;
  try {
    client = await CdpClient.open(wsUrl);
  } catch {
    return null;
  }

  const sessions = new Map<string, { url: string }>();
  client.on((message) => {
    if (message.method !== 'Target.attachedToTarget') return;
    const params = message.params as { sessionId?: unknown; targetInfo?: { type?: unknown; url?: unknown } } | undefined;
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : '';
    if (!sessionId) return;
    const type = typeof params?.targetInfo?.type === 'string' ? params.targetInfo.type : '';
    if (type !== 'iframe' && type !== 'page') return;
    sessions.set(sessionId, { url: typeof params?.targetInfo?.url === 'string' ? params.targetInfo.url : '' });
  });

  const via: Record<string, number> = { isolation: 0, session: 0, dom: 0, frameUrl: 0 };

  try {
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    // OOPIF（跨域 iframe 独立进程）只有在自己那条 session 里才看得到 document
    await client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await sleep(120);
    for (const sessionId of [...sessions.keys()]) {
      await client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
      await client.send('Page.enable', {}, sessionId);
      await client.send('Runtime.enable', {}, sessionId);
    }
    await sleep(100);

    // 根 frame 树：本进程内所有 frame（含 OOPIF 的占位）都在这里
    const treeResponse = await client.send('Page.getFrameTree');
    const frames = frameTreeRecords(treeResponse.result);
    const mainFrame = [...frames.values()].find((frame) => !frame.parentId);
    const mainOrigin = originOf(mainFrame?.url ?? '');

    // OOPIF 的 Page 域是它自己的：把它的根 frame 并进树里，深度按父级算
    const sessionRoots = new Map<string, string>();
    await Promise.all([...sessions.keys()].map(async (sessionId) => {
      const response = await client.send('Page.getFrameTree', {}, sessionId);
      const tree = frameTreeRecords(response.result, 1);
      const root = [...tree.values()].find((frame) => !frame.parentId);
      if (!root) return;
      sessionRoots.set(sessionId, root.id);
      for (const frame of tree.values()) {
        if (!frames.has(frame.id)) {
          frames.set(frame.id, { ...frame, url: frame.url || sessions.get(sessionId)?.url || '' });
        }
      }
    }));

    const collected = { swf: new Map<string, DeepSwf>(), plugins: 0 };
    const readable = new Set<string>();

    // 手段一：给每个 frame 建隔离世界（跨域也能建），在里面跑探测脚本。
    // 不依赖 executionContextCreated 的回放——老 XHTML / 插件文档不给默认上下文。
    await Promise.all([...frames.values()].map(async (frame) => {
      const world = await client.send('Page.createIsolatedWorld', {
        frameId: frame.id,
        worldName: `bfb-flash-probe-${frame.id}`,
        grantUniveralAccess: false,
      });
      const contextId = world.result?.executionContextId;
      if (typeof contextId !== 'number') return;
      const evaluated = await client.send('Runtime.evaluate', {
        expression: FRAME_PROBE,
        contextId,
        returnByValue: true,
      });
      const value = evaluated.result?.result as { value?: RawFrameProbe } | undefined;
      const probe = value?.value;
      if (!probe || typeof probe !== 'object') return;
      readable.add(frame.id);
      via.isolation += absorb(collected, probe.href || frame.url, probe);
    }));

    // 手段二：OOPIF 可能压根不给根会话执行上下文，直接在它自己的 session 里求值
    await Promise.all([...sessionRoots.entries()].map(async ([sessionId, frameId]) => {
      const evaluated = await client.send('Runtime.evaluate', {
        expression: FRAME_PROBE,
        returnByValue: true,
      }, sessionId);
      const value = evaluated.result?.result as { value?: RawFrameProbe } | undefined;
      const probe = value?.value;
      if (!probe || typeof probe !== 'object') return;
      readable.add(frameId);
      const frame = frames.get(frameId);
      via.session += absorb(collected, probe.href || frame?.url || sessions.get(sessionId)?.url || '', probe);
    }));

    // 手段三：DOM 域兜底。PPAPI 插件文档（直接以 .swf 作为 frame）没有可用上下文，
    // 但它仍然是 DOM 树里的节点；老站的分支也可能被 flattened 文档漏掉。
    const domNodes: Array<Record<string, unknown>> = [];
    const flattened = await client.send('DOM.getFlattenedDocument', { depth: -1, pierce: true });
    const flattenedNodes = flattened.result?.nodes;
    if (Array.isArray(flattenedNodes)) domNodes.push(...(flattenedNodes as Array<Record<string, unknown>>));
    const document = await client.send('DOM.getDocument', { depth: -1, pierce: true });
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const value = node as { children?: unknown[]; contentDocument?: unknown; shadowRoots?: unknown[]; templateContent?: unknown; nodeName?: unknown };
      domNodes.push(value as Record<string, unknown>);
      for (const child of value.children ?? []) walk(child);
      walk(value.contentDocument);
      for (const shadow of value.shadowRoots ?? []) walk(shadow);
      walk(value.templateContent);
    };
    walk(document.result?.root);
    const seenBackend = new Set<number>();
    for (const node of domNodes) {
      const name = String(node.nodeName ?? '').toLowerCase();
      if (!['embed', 'object', 'param', 'ruffle-player', 'ruffle-embed'].includes(name)) continue;
      const backendNodeId = Number(node.backendNodeId ?? 0);
      if (backendNodeId && seenBackend.has(backendNodeId)) continue;
      if (backendNodeId) seenBackend.add(backendNodeId);
      const attributes = (node.attributes as string[] | undefined) ?? [];
      const map = new Map<string, string>();
      for (let i = 0; i + 1 < attributes.length; i += 2) map.set(attributes[i].toLowerCase(), attributes[i + 1]);
      if (name === 'param') {
        if (String(map.get('name') || '').toLowerCase() !== 'movie') continue;
        const movie = map.get('value') || '';
        if (!/\.swf(?:$|[?#])/i.test(movie)) continue;
        const key = `param|${movie}`;
        if (!collected.swf.has(key)) {
          collected.swf.set(key, { url: movie, kind: 'param' });
          via.dom += 1;
        }
        continue;
      }
      const src = map.get('src') || map.get('data') || '';
      if (!/\.swf(?:$|[?#])/i.test(src)) continue;
      const kind = name === 'object' ? 'object' : 'embed';
      const key = `${kind}|${src}`;
      if (!collected.swf.has(key)) {
        collected.swf.set(key, { url: src, kind });
        via.dom += 1;
      }
    }

    // 手段四：frame URL 本身就是 .swf（很多站直接把 SWF 当 iframe 的地址）
    for (const frame of frames.values()) {
      if (!frame.parentId || !/\.swf(?:$|[?#])/i.test(frame.url)) continue;
      const url = safeUrl(frame.url);
      const key = `frame|${url}`;
      if (collected.swf.has(key)) continue;
      collected.swf.set(key, { url, kind: 'frame', frameUrl: url });
      via.frameUrl += 1;
    }

    const frameList: DeepFrame[] = [...frames.values()].map((frame) => ({
      url: safeUrl(frame.url) || 'about:blank',
      depth: frame.depth,
      sameOrigin: Boolean(mainOrigin) && originOf(frame.url) === mainOrigin,
      readable: readable.has(frame.id),
    }));

    return {
      frames: frameList.sort((left, right) => left.depth - right.depth),
      swf: [...collected.swf.values()],
      plugins: collected.plugins,
      via,
      elapsedMs: Date.now() - startedAt,
    };
  } catch {
    return null;
  } finally {
    client.close();
  }
}
