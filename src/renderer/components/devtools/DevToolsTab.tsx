import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import { useTabsStore } from '@renderer/store/useTabsStore';
import { useDevToolsBridgeAttach } from './useDevToolsBridgeAttach';

type Target = 'page' | 'shell';

/**
 * 真 DevTools 宿主。
 *
 * 里面是官方前端（`assets/devtools-frontend`，取自 chii 的构建产物，经
 * `scripts/build-devtools-frontend.cjs` 降级到 Chromium 87）。
 *
 * 承载方式：**统一由主进程 BrowserView 承载**（这里是占位 div，只上报矩形）。
 *
 * - **桥模式（默认）**：URL 恒定，切标签只重绑桥的 session，前端不重载。
 *   传输是 preload 暴露的 `bfbBridge` → IPC → 主进程桥（B3 之前是 iframe +
 *   postMessage 中继，已删除）。
 * - **page-ws（`BAO_DEVTOOLS_PAGE_WS=1` 回退）**：URL 带 target id，切标签
 *   会重建容器，面板状态丢失。
 *
 * 前端只认 WebSocket 或桥；`?ws=` 是它的传输层参数，桥模式刻意不带。
 *
 * 已知降级：前端约 M97，后端是 Chromium 87，新版才有的可选 CDP 方法
 * （Overlay 的 flex/scroll-snap 高亮、Network.setAttachDebugStack 等）会 404，
 * Console/Elements/Network/Sources 主路径不受影响。
 */
const DevToolsTab: React.FC = () => {
  const { LL } = useI18nContext();
  const activeTabId = useTabsStore((s) => s.activeTabId);
  // 活动标签的 URL 只用于触发重新解析（比如绑定时标签还停在 about:newtab，
  // 导航完成后需要再试一次）；page target 的 id 跨导航恒定，同标签内导航
  // 拿回的是同一个 URL，视图不会重载，面板状态照常保留。
  const activeTabUrl = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.url ?? null);
  const [target, setTarget] = useState<Target>('page');
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [noTarget, setNoTarget] = useState(false);
  const [nonce, setNonce] = useState(0);
  /** 桥模式下 URL 恒定（不含 target id），切标签只换绑定、不换 URL → iframe 不重载。 */
  const [mode, setMode] = useState<'ws' | 'bridge'>('ws');
  const hostRef = useRef<HTMLDivElement>(null);
  /** 容器挂载时用的目标。不进 effect 依赖，理由见下面容器 effect 的注释。 */
  const targetRef = useRef<Target>(target);
  targetRef.current = target;

  useEffect(() => {
    let alive = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let portAttempts = 0;
    let targetAttempts = 0;
    setMissing(false);
    setNoTarget(false);
    const resolveUrl = () => {
      window.electronAPI.devtoolbox.devtoolsUrl(target).then((result) => {
        if (!alive) return;
        if (result && result.url) {
          setUrl(result.url);
          setMode(result.mode === 'bridge' ? 'bridge' : 'ws');
          setMissing(false);
          setNoTarget(false);
          return;
        }
        // no-target：当前标签根本没有 page target（about:newtab 不创建 BrowserView）。
        // 少量重试覆盖导航过渡态，仍无则给明确文案，不伪装成"端口故障"。
        if (result && result.reason === 'no-target') {
          targetAttempts += 1;
          if (targetAttempts <= 3) {
            retryTimer = setTimeout(resolveUrl, 500);
          } else {
            setUrl(null);
            setNoTarget(true);
          }
          return;
        }
        // no-port：端口/前端服务还没就绪，长一点的重试窗口。
        portAttempts += 1;
        if (portAttempts <= 12) {
          retryTimer = setTimeout(resolveUrl, 750);
        } else {
          setUrl(null);
          setMissing(true);
        }
      }).catch(() => {
        if (!alive) return;
        setUrl(null);
        setMissing(true);
      });
    };
    resolveUrl();
    return () => {
      alive = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [target, activeTabId, activeTabUrl, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  // 容器挂载：把前端挂成独立 WebContents，并持续把占位 div 的矩形同步给主进程。
  // 切换停靠 / 拖拽抽屉 / 窗口缩放都会让矩形变化，ResizeObserver 会逐帧上报。
  //
  // 依赖里**故意没有 target**：
  // - ws 模式切 target 时 URL 会跟着变（带 target id），靠 url 触发重建；
  // - 桥模式切 target 时 URL 恒定，容器不该重建——重绑由 useDevToolsBridgeAttach
  //   完成。首挂目标从 ref 取，避免把 target 写进依赖而破坏这条语义。
  useEffect(() => {
    if (!url) return undefined;
    const host = hostRef.current;
    if (!host) return undefined;

    let alive = true;
    let observer: ResizeObserver | null = null;
    const report = (): void => {
      const rect = host.getBoundingClientRect();
      void window.electronAPI.devtoolbox.setDevToolsBounds({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
    };

    void window.electronAPI.devtoolbox.attachDevToolsView(targetRef.current).then((result) => {
      if (!alive || !result.ok) return;
      report();
      observer = new ResizeObserver(report);
      observer.observe(host);
      window.addEventListener('resize', report);
    }).catch(() => {
      // 失败由 missing/noTarget 占位兜底，这里不额外弹错
    });

    return () => {
      alive = false;
      observer?.disconnect();
      window.removeEventListener('resize', report);
      void window.electronAPI.devtoolbox.detachDevToolsView();
    };
  }, [mode, url, nonce]);

  // 桥模式下 URL 恒定，切标签只重绑 session：前端不重载，面板状态保留。
  useDevToolsBridgeAttach(mode === 'bridge', target, activeTabId, activeTabUrl);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-1.5" style={{ borderBottom: '0.5px solid var(--border)', background: 'var(--bg-secondary)' }}>
        <div className="flex items-center rounded" style={{ border: '0.5px solid var(--border)' }}>
          {(['page', 'shell'] as Target[]).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setTarget(item)}
              className="text-[12px] px-2 py-[2px]"
              style={{
                background: target === item ? 'var(--bg-panel)' : 'transparent',
                color: target === item ? 'var(--accent)' : 'var(--text-secondary)',
              }}
            >
              {item === 'page' ? LL.devtools.targetPage() : LL.devtools.targetShell()}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="text-[12px] px-2 py-[2px] rounded"
          style={{ border: '0.5px solid var(--border)', color: 'var(--text-primary)' }}
          onClick={reload}
        >
          {LL.devtools.refresh()}
        </button>
        <button
          type="button"
          className="text-[12px] px-2 py-[2px] rounded"
          style={{ border: '0.5px solid var(--border)', color: 'var(--text-primary)' }}
          onClick={() => { void window.electronAPI.devtoolbox.openNative(target); }}
        >
          {LL.devtools.native()}
        </button>
        <span className="ml-auto text-[11px] truncate" style={{ color: 'var(--text-secondary)' }}>
          {missing ? '' : 'DevTools'}
        </span>
      </div>

      {noTarget ? (
        <div className="flex-1 flex items-center justify-center px-6 text-center">
          <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>{LL.devtools.noTarget()}</div>
        </div>
      ) : missing ? (
        <div className="flex-1 flex items-center justify-center px-6 text-center">
          <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>{LL.devtools.noDebugPort()}</div>
        </div>
      ) : url ? (
        // 占位：真正的画面来自主进程的 BrowserView，这里只负责占位与上报矩形
        <div
          ref={hostRef}
          className="flex-1 min-h-0 w-full"
          style={{ background: 'var(--bg-panel)' }}
        />
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>…</div>
        </div>
      )}
    </div>
  );
};

export default DevToolsTab;
