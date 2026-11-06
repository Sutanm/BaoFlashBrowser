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

export function useDevToolsBridgeRelay(frameUrl: string | null): void {
  useEffect(() => {
    if (!frameUrl) return;
    let frameOrigin = '';
    try { frameOrigin = new URL(frameUrl).origin; } catch { return; }
    if (!frameOrigin) return;

    let alive = true;
    let source: Window | null = null;

    const post = (kind: string, extra: Record<string, unknown>): void => {
      if (!source) return;
      try { source.postMessage({ source: 'bfb-devtools-bridge', kind, ...extra }, '*'); } catch { /* frame gone */ }
    };

    const attach = async (): Promise<void> => {
      const result = await window.electronAPI.devtoolbox.bridge.attach().catch(() => null);
      if (!alive) return;
      if (result && result.ok) {
        post('ready', {});
        return;
      }
      const reason = (result && result.error && result.error.message) || 'attach-failed';
      post('detached', { reason });
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

      void window.electronAPI.devtoolbox.bridge.send(parsed.method, parsed.params, parsed.sessionId).then((result) => {
        if (!alive) return;
        if (result.ok) post('response', { id: parsed.id, result: result.result });
        else post('response', { id: parsed.id, error: result.error });
      }).catch((error: unknown) => {
        if (!alive) return;
        post('response', { id: parsed.id, error: { message: error instanceof Error ? error.message : 'bridge-error' } });
      });
    };

    window.addEventListener('message', onMessage);
    const offEvents = window.electronAPI.devtoolbox.bridge.onEvents((events) => {
      if (!alive) return;
      for (const item of events as Array<{ method: string; params?: unknown }>) {
        post('event', { method: item.method, params: item.params });
      }
    });

    return () => {
      alive = false;
      window.removeEventListener('message', onMessage);
      offEvents();
    };
  }, [frameUrl]);
}
