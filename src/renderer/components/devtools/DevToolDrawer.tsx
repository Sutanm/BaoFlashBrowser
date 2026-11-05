import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import type { DevToolEntry, DevToolFlashInfo, DevToolPageProbe } from '@shared/types/devtoolbox';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import { useTabsStore } from '@renderer/store/useTabsStore';
import {
  defaultDrawerHeight,
  DEVTOOL_MIN_HEIGHT,
  clampDrawerHeight,
  useDevToolStore,
  type DevToolTab,
} from '@renderer/store/useDevToolStore';
import LogPanel from './LogPanel';
import CaptureTab from './CaptureTab';
import DevToolsTab from './DevToolsTab';
import FlashTab from './FlashTab';

const DevToolDrawer: React.FC = () => {
  const { LL } = useI18nContext();
  const open = useDevToolStore((s) => s.open);
  const height = useDevToolStore((s) => s.height);
  const tab = useDevToolStore((s) => s.tab);
  const entries = useDevToolStore((s) => s.entries);
  const setOpen = useDevToolStore((s) => s.setOpen);
  const setHeight = useDevToolStore((s) => s.setHeight);
  const setTab = useDevToolStore((s) => s.setTab);
  const ingest = useDevToolStore((s) => s.ingest);
  const replaceEntries = useDevToolStore((s) => s.replaceEntries);
  const clearEntries = useDevToolStore((s) => s.clearEntries);
  const activeTabId = useTabsStore((s) => s.activeTabId);

  const [flash, setFlash] = useState<DevToolFlashInfo | null>(null);
  const [probe, setProbe] = useState<DevToolPageProbe | null>(null);
  const [cdpOwner, setCdpOwner] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const snapshot = await window.electronAPI.devtoolbox.snapshot();
      replaceEntries(snapshot.entries);
      setFlash(snapshot.flash);
      setCdpOwner(snapshot.cdpOwner);
      const pageProbe = await window.electronAPI.devtoolbox.probePage();
      setProbe(pageProbe);
    } catch {
      // 工具箱是只读观察者：快照失败不应打断浏览器
    }
  }, [replaceEntries]);

  useEffect(() => {
    if (!open) return;
    const offEntries = window.electronAPI.devtoolbox.onEntries((incoming) => ingest(incoming));
    const offCleared = window.electronAPI.devtoolbox.onCleared(() => clearEntries());
    // 打开时补历史，切标签时刷新 CDP 占用者（快照是主进程的权威状态）
    void refresh();
    return () => { offEntries(); offCleared(); };
  }, [open, activeTabId, ingest, clearEntries, refresh]);

  const startResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = useDevToolStore.getState().height;
    let latest = startHeight;
    let frame = 0;
    const onMove = (moveEvent: PointerEvent): void => {
      latest = clampDrawerHeight(startHeight + (startY - moveEvent.clientY));
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setHeight(latest);
      });
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (frame) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
      setHeight(latest);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [setHeight]);

  const tabs: Array<{ key: DevToolTab; label: string }> = useMemo(() => ([
    { key: 'devtools', label: LL.devtools.tabDevtools() },
    { key: 'capture', label: LL.devtools.tabCapture() },
    { key: 'flash', label: LL.devtools.tabFlash() },
    { key: 'main', label: LL.devtools.tabMain() },
  ]), [LL]);

  const byIssue = (issue: DevToolEntry['issue']): DevToolEntry[] => entries.filter((entry) => entry.issue === issue);

  if (!open) return null;

  return (
    <div
      className="flex flex-col shrink-0"
      style={{ height, minHeight: DEVTOOL_MIN_HEIGHT, borderTop: '0.5px solid var(--border)', background: 'var(--bg-panel)' }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={startResize}
        onDoubleClick={() => setHeight(defaultDrawerHeight())}
        style={{ height: 6, marginTop: -3, cursor: 'row-resize', flex: '0 0 auto' }}
      />

      <div className="flex items-center gap-1 px-2" style={{ height: 30, borderBottom: '0.5px solid var(--border)', background: 'var(--bg-secondary)' }}>
        {tabs.map((item) => {
          const active = item.key === tab;
          const count = item.key === 'capture'
            ? byIssue('capture').length
            : item.key === 'main'
              ? byIssue('log').length
              : 0;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              className="text-[12px] px-2 py-[2px] rounded"
              style={{
                color: active ? 'var(--accent)' : 'var(--text-secondary)',
                background: active ? 'var(--bg-panel)' : 'transparent',
                border: active ? '0.5px solid var(--border)' : '0.5px solid transparent',
              }}
            >
              {item.label}
              {count > 0 && <span className="ml-1 text-[10px]" style={{ color: 'var(--text-secondary)' }}>{count > 999 ? '999+' : count}</span>}
            </button>
          );
        })}

        <span className="ml-auto" />

        <button
          type="button"
          className="text-[11px] px-2 py-[2px] rounded"
          style={{ color: 'var(--text-secondary)' }}
          onClick={() => void window.electronAPI.devtoolbox.clear()}
        >
          {LL.devtools.clear()}
        </button>
        <button
          type="button"
          className="text-[11px] px-2 py-[2px] rounded"
          style={{ color: 'var(--text-secondary)' }}
          title={LL.devtools.nativePage()}
          onClick={() => { void window.electronAPI.devtoolbox.openNative('page'); }}
        >
          {LL.devtools.native()}
        </button>
        <button
          type="button"
          className="px-[5px] py-[2px] rounded"
          style={{ color: 'var(--text-secondary)' }}
          title={LL.devtools.close()}
          onClick={() => setOpen(false)}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 min-h-0">
        {tab === 'devtools' && <DevToolsTab />}
        {tab === 'capture' && (
          <CaptureTab entries={byIssue('capture')} cdpOwner={cdpOwner} onRefresh={() => void refresh()} />
        )}
        {tab === 'flash' && (
          <FlashTab
            flash={flash}
            probe={probe}
            onRefresh={() => void refresh()}
            onOpenNative={() => { void window.electronAPI.devtoolbox.openNative('page'); }}
          />
        )}
        {tab === 'main' && (
          <LogPanel
            entries={byIssue('log')}
            empty={LL.devtools.emptyMain()}
          />
        )}
      </div>
    </div>
  );
};

export default DevToolDrawer;
