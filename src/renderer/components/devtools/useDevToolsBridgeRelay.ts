import { useEffect } from 'react';

/**
 * 桥 v2 的外壳中继（规格 docs/archive/superpowers/specs/2026-11-06-devtools-cdp-bridge-design.md）。
 *
 * iframe 里的 M97 前端用 `BfbBridgeConnection`（构建期 patch 注入）把 CDP 消息
 * postMessage 到父窗；这里负责：
 *   1. `hello` → `devtoolbox.bridge.attach()`（主进程解析活动标签的 target 并建
 *      flatten session），成功回 `ready`，失败回 `detached`
 *   2. `cdp`   → `bridge.send(method, params)`，按 id 回 `response`
 *   3. 桥事件  → 逐条 `event` 推回 iframe
 *
 * 为什么必须经外壳中转：`contextBridge` 不注入 iframe（`nodeIntegrationInSubFrames`
 * 默认 false，探针 `s8-debug-targets.cjs` 实测），iframe 里没有 `electronAPI`。
 *
 * 安全：只接受 `frameUrl` 同源的消息（静态服务 origin）；回发用 `event.source`
 * （即发送方 window），不查询 DOM、不做广播。
 */
interface CdpPayload {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

interface FrameMessage {
  source?: string;
  kind?: string;
  payload?: unknown;
}

export function useDevToolsBridgeRelay(
  frameUrl: string | null,
  activeTabId: string | null,
  activeTabUrl: string | null,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!frameUrl) return;
    let frameOrigin = '';
    try { frameOrigin = new URL(frameUrl).origin; } catch { return; }
    if (!frameOrigin) return;

    let alive = true;
    let source: Window | null = null;
    let hasHello = false;

    const post = (kind: string, extra: Record<string, unknown>): void => {
      if (!source) return;
      try { source.postMessage({ source: 'bfb-devtools-bridge', kind, ...extra }, '*'); } catch { /* frame gone */ }
    };

    const attach = async (): Promise<void> => {
      const result = await window.electronAPI.devtoolbox.bridge.attach().catch(() => null);
      if (!alive) return;
      // 只有首次（前端 hello 之后）才回 ready/detached——后续 switch 是"热切换"，
      // 前端不该被当成重新连接（那会让它丢掉面板状态）。
      if (!hasHello) {
        if (result && result.ok) {
          hasHello = true;
          post('ready', {});
          return;
        }
        const reason = (result && result.error && result.error.message) || 'attach-failed';
        post('detached', { reason });
        return;
      }
      if (!(result && result.ok)) {
        post('detached', { reason: (result && result.error && result.error.message) || 'attach-failed' });
      }
    };

    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== frameOrigin) return;
      const data = event.data as FrameMessage | null;
      if (!data || data.source !== 'bfb-devtools-bridge') return;

      if (data.kind === 'hello') {
        source = (event.source as Window | null) ?? null;
        void attach();
        return;
      }
      if (data.kind !== 'cdp' || typeof data.payload !== 'string') return;

      let parsed: CdpPayload;
      try { parsed = JSON.parse(data.payload) as CdpPayload; } catch { return; }
      if (!parsed.method) return;

      void window.electronAPI.devtoolbox.bridge.send(parsed.method, parsed.params, parsed.sessionId, parsed.id).then((result) => {
        // 正常路径下响应由「有序流」统一投递（bridge-event 里的 {id} 信封），这里
        // 只兜底桥自身的失败（未连接 / 参数非法）：那种情况不会有后端消息回来。
        if (!alive || result.ok) return;
        post('response', { id: parsed.id, error: result.error });
      }).catch((error: unknown) => {
        if (!alive) return;
        post('response', { id: parsed.id, error: { message: error instanceof Error ? error.message : 'bridge-error' } });
      });
    };

    window.addEventListener('message', onMessage);
    const offEvents = window.electronAPI.devtoolbox.bridge.onEvents((events) => {
      if (!alive) return;
      for (const item of events as Array<{ id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown }>) {
        // 有序流：响应（带 id）与事件（带 method）走同一条通道，顺序与后端一致。
        if (typeof item.id === 'number') {
          if (item.error) post('response', { id: item.id, error: item.error });
          else post('response', { id: item.id, result: item.result });
          continue;
        }
        if (!item.method) continue;
        post('event', { method: item.method, params: item.params });
      }
    });

    return () => {
      alive = false;
      window.removeEventListener('message', onMessage);
      offEvents();
    };
  }, [frameUrl]);

  // 切标签 / 换页面：iframe 不重载（URL 恒定），只让主进程把桥重新绑到新标签。
  // 桥内部对「target 没变」是幂等早退，所以同标签内导航只是多一次轻量 IPC；
  // 真换了 target 时桥会重放前端的域开关并发 DOM.documentUpdated，前端据此重建面板。
  //
  // 注意依赖里有 activeTabUrl：新建标签时 tab id 不变、只有它的 URL 变，
  // 只看 activeTabId 会漏掉这类切换（实测）。加 300ms 防抖吸收导航抖动。
  useEffect(() => {
    if (!enabled || !frameUrl || !activeTabId) return;
    let cancelled = false;
    // 新标签会先经历 about:blank（此时没有 page target，attach 必然失败）。
    // 这是过渡态，不能当成「断开」——前端一旦收到 detached 就会显示断开横幅并
    // 停止一切请求。所以热切换只静默重试，绝不发 detached。
    const hotAttach = async (attempt: number): Promise<void> => {
      const result = await window.electronAPI.devtoolbox.bridge.attach().catch(() => null);
      if (cancelled || (result && result.ok)) return;
      if (attempt < 4) setTimeout(() => { if (!cancelled) void hotAttach(attempt + 1); }, 600);
    };
    const timer = setTimeout(() => { void hotAttach(0); }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [enabled, frameUrl, activeTabId, activeTabUrl]);
}
