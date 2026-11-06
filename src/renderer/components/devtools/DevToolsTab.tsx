import React, { useCallback, useEffect, useState } from 'react';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import { useTabsStore } from '@renderer/store/useTabsStore';

type Target = 'page' | 'shell';

/**
 * 真 DevTools 宿主。
 *
 * 里面是官方前端（`assets/devtools-frontend`，取自 chii 的构建产物，经
 * `scripts/build-devtools-frontend.cjs` 降级到 Chromium 87），由主进程的本地
 * HTTP 服务（127.0.0.1 + 系统分配端口）托管，再用 `?ws=` 连本应用自己的
 * CDP 端口。前端只认 WebSocket，那个端口是它的传输层——不是我们在应用和
 * 浏览器之间加的转接。
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
  // 拿回的是同一个 URL，iframe 不会重载，面板状态照常保留。
  const activeTabUrl = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.url ?? null);
  const [target, setTarget] = useState<Target>('page');
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [noTarget, setNoTarget] = useState(false);
  const [nonce, setNonce] = useState(0);

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
        <iframe
          key={url}
          title="DevTools"
          src={url}
          className="flex-1 min-h-0 w-full"
          style={{ border: 0, background: 'var(--bg-panel)' }}
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
