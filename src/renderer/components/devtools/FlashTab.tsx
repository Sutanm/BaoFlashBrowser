import React from 'react';
import type { DevToolFlashInfo, DevToolPageProbe } from '@shared/types/devtoolbox';
import { useI18nContext } from '@renderer/i18n/i18n-react';

interface FlashTabProps {
  flash: DevToolFlashInfo | null;
  probe: DevToolPageProbe | null;
  onRefresh: () => void;
  onOpenNative: () => void;
}

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex gap-3 py-[3px]">
    <span className="shrink-0 w-[92px] text-[12px]" style={{ color: 'var(--text-secondary)' }}>{label}</span>
    <span className="min-w-0 flex-1 text-[12px] break-all" style={{ color: 'var(--text-primary)' }}>{children}</span>
  </div>
);

const FlashTab: React.FC<FlashTabProps> = ({ flash, probe, onRefresh, onOpenNative }) => {
  const { LL } = useI18nContext();
  const swf = probe?.swf ?? [];
  // 同一 URL 的 frame 会重复出现（7k7k 那种动态建一堆 about:blank），
  // 直接 map 既刷屏又会让 React 报重复 key，去重后只留第一条。
  const frames = React.useMemo(() => {
    const seen = new Set<string>();
    return (probe?.frames ?? []).filter((frame) => {
      const key = `${frame.sameOrigin ? 'same' : 'cross'}|${frame.url}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [probe]);
  const flashPlugins = probe?.flashPlugins ?? 0;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-1.5" style={{ borderBottom: '0.5px solid var(--border)', background: 'var(--bg-secondary)' }}>
        <button type="button" className="text-[12px] px-2 py-[2px] rounded" style={{ border: '0.5px solid var(--border)', color: 'var(--text-primary)' }} onClick={onRefresh}>{LL.devtools.refresh()}</button>
        <button type="button" className="text-[12px] px-2 py-[2px] rounded" style={{ border: '0.5px solid var(--border)', color: 'var(--text-primary)' }} onClick={onOpenNative}>{LL.devtools.native()}</button>
        <span className="ml-auto text-[11px]" style={{ color: 'var(--text-secondary)' }}>
          {probe ? `${probe.viewport.width}×${probe.viewport.height} · ${probe.frameCount} frame` : LL.devtools.emptyFlash()}
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-auto px-3 py-2">
        <Row label={LL.devtools.flashPlugin()}>{flash?.pluginPath || '—'}</Row>
        <Row label={LL.devtools.flashVersion()}>{flash?.version || '—'}</Row>
        <Row label={LL.devtools.flashChannel()}>{flash?.channel || '—'}</Row>
        <Row label={LL.devtools.flashSource()}>{flash?.source || '—'}</Row>
        {flash?.fallbackReason && <Row label={LL.devtools.flashFallback()}>{flash.fallbackReason}</Row>}

        <div className="mt-2 mb-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>{LL.devtools.flashSwf()}</div>
        {swf.length === 0 ? (
          <div className="text-[12px]" style={{ color: 'var(--text-primary)' }}>
            {/* 三种"没 SWF"要分清：插件在跑只是地址没解析出来 / 游戏在跨域 iframe 里读不到 / 真没有 */}
            {flashPlugins > 0
              ? LL.devtools.swfPluginOnly({ n: flashPlugins })
              : frames.some((frame) => !frame.sameOrigin)
                ? LL.devtools.swfInFrames()
                : LL.devtools.swfEmpty()}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {swf.map((item) => (
              <div key={`${item.kind}:${item.url}`} className="flex items-start gap-2 text-[12px]">
                <span className="shrink-0 px-[5px] rounded text-[11px]" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>{item.kind}</span>
                <span className="min-w-0 flex-1 break-all" style={{ color: 'var(--text-primary)' }}>{item.url}</span>
                {item.width ? <span className="shrink-0" style={{ color: 'var(--text-secondary)' }}>{Math.round(item.width)}×{Math.round(item.height ?? 0)}</span> : null}
              </div>
            ))}
          </div>
        )}

        {frames.length > 0 && (
          <>
            <div className="mt-3 mb-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>{LL.devtools.flashFrames()}</div>
            <div className="flex flex-col gap-1">
              {frames.map((frame, index) => (
                <div key={`${frame.url}:${index}`} className="flex items-start gap-2 text-[12px]">
                  <span className="shrink-0 px-[5px] rounded text-[11px]" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
                    {frame.sameOrigin ? LL.devtools.sameOrigin() : LL.devtools.crossOrigin()}
                  </span>
                  <span className="min-w-0 flex-1 break-all" style={{ color: 'var(--text-primary)' }}>{frame.url || '(about:blank)'}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {flash?.mmsCfg && (
          <>
            <div className="mt-3 mb-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>{LL.devtools.flashMms()}</div>
            <pre className="m-0 p-2 rounded text-[11px] whitespace-pre-wrap break-all" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}>{flash.mmsCfg}</pre>
          </>
        )}

        <div className="mt-3 text-[12px]" style={{ color: 'var(--text-secondary)' }}>{LL.devtools.flashUa()}</div>
        <div className="text-[12px] break-all" style={{ color: 'var(--text-primary)' }}>{flash?.ua || '—'}</div>
      </div>
    </div>
  );
};

export default FlashTab;
