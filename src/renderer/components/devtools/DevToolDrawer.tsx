import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, PanelBottom, PanelLeft, PanelRight, X } from 'lucide-react';
import type { DevToolEntry, DevToolFlashInfo, DevToolPageProbe } from '@shared/types/devtoolbox';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import { useTabsStore } from '@renderer/store/useTabsStore';
import {
  defaultDrawerHeight,
  defaultDrawerWidth,
  DEVTOOL_MIN_HEIGHT,
  DEVTOOL_MIN_WIDTH,
  clampDrawerHeight,
  clampDrawerWidth,
  useDevToolStore,
  type DevToolDock,
  type DevToolTab,
} from '@renderer/store/useDevToolStore';
import { setDevtoolsDragActive } from './dragState';
import LogPanel from './LogPanel';
import CaptureTab from './CaptureTab';
import DevToolsTab from './DevToolsTab';
import FlashTab from './FlashTab';

const DevToolDrawer: React.FC = () => {
  const { LL } = useI18nContext();
  const open = useDevToolStore((s) => s.open);
  const height = useDevToolStore((s) => s.height);
  const width = useDevToolStore((s) => s.width);
  const dock = useDevToolStore((s) => s.dock);
  const tab = useDevToolStore((s) => s.tab);
  const entries = useDevToolStore((s) => s.entries);
  const setOpen = useDevToolStore((s) => s.setOpen);
  const setHeight = useDevToolStore((s) => s.setHeight);
  const setWidth = useDevToolStore((s) => s.setWidth);
  const setDock = useDevToolStore((s) => s.setDock);
  const setTab = useDevToolStore((s) => s.setTab);
  const ingest = useDevToolStore((s) => s.ingest);
  const replaceEntries = useDevToolStore((s) => s.replaceEntries);
  const clearEntries = useDevToolStore((s) => s.clearEntries);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activeTabUrl = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.url ?? null);

  const [flash, setFlash] = useState<DevToolFlashInfo | null>(null);
  const [probe, setProbe] = useState<DevToolPageProbe | null>(null);
  const [cdpOwner, setCdpOwner] = useState<string | null>(null);
  /** 当前 (标签, URL) 已经自动补探过几次；换标签或换页面就归零。 */
  const probeKeyRef = useRef('');
  const probeAttemptRef = useRef(0);

  const refresh = useCallback(async (tabId?: string | null) => {
    // 探哪一页由调用方指定（正常是 activeTabId）。主进程的"活动标签"比渲染层晚一拍，
    // 它自己取会探到上一个标签——切完标签 Flash 页显示上一页的 SWF 就是这么来的。
    const requested = tabId ?? useTabsStore.getState().activeTabId;
    try {
      const snapshot = await window.electronAPI.devtoolbox.snapshot(requested);
      // 迟到响应直接丢：等它回来时用户可能已经切走了
      if (useTabsStore.getState().activeTabId !== requested) return;
      replaceEntries(snapshot.entries);
      setFlash(snapshot.flash);
      setCdpOwner(snapshot.cdpOwner);
    } catch {
      return;
    }
    const pageProbe = await window.electronAPI.devtoolbox.probePage(requested).catch(() => null);
    if (useTabsStore.getState().activeTabId !== requested) return;
    setProbe(pageProbe);
  }, [replaceEntries]);

  useEffect(() => {
    if (!open) return;
    const offEntries = window.electronAPI.devtoolbox.onEntries((incoming) => ingest(incoming));
    const offCleared = window.electronAPI.devtoolbox.onCleared(() => clearEntries());
    return () => { offEntries(); offCleared(); };
  }, [open, ingest, clearEntries]);

  // 重新探测的触发条件：打开面板、切标签、**同一个标签内的导航**。
  //
  // 最后一条不能漏：新建标签页先落在 about:newtab（没有 BrowserView，探测拿不到东西），
  // 用户随后在同一个标签里导航到真实页面时 tabId 没变——只看 tabId 的话这次导航
  // 永远不会重新探测，Flash 页就停在空结果上，非得按 F12 重开面板才刷新。
  useEffect(() => {
    if (!open) return undefined;
    const key = `${activeTabId ?? ''}|${activeTabUrl ?? ''}`;
    if (probeKeyRef.current !== key) {
      probeKeyRef.current = key;
      probeAttemptRef.current = 0;
    }
    const timer = setTimeout(() => { void refresh(activeTabId); }, 400);
    return () => clearTimeout(timer);
  }, [open, activeTabId, activeTabUrl, refresh]);

  // 自动补探：停在 Flash 页且当前没拿到 SWF 时隔 2s 再探（最多 6 次 ≈ 12s）。
  // 游戏站常常是登录/进服之后才创建插件，页面 load 完了也还没 SWF——不是探测坏了。
  useEffect(() => {
    if (!open || tab !== 'flash' || !activeTabId) return undefined;
    if (probeKeyRef.current !== `${activeTabId}|${activeTabUrl ?? ''}`) return undefined;
    if ((probe?.swf?.length ?? 0) > 0) return undefined;
    if (probeAttemptRef.current >= 6) return undefined;
    probeAttemptRef.current += 1;
    const timer = setTimeout(() => { void refresh(activeTabId); }, 2000);
    return () => clearTimeout(timer);
  }, [open, tab, activeTabId, activeTabUrl, probe, refresh]);

  const startResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const vertical = dock === 'left' || dock === 'right';
    const startX = event.clientX;
    const startY = event.clientY;
    const startSize = vertical ? useDevToolStore.getState().width : useDevToolStore.getState().height;
    let latest = startSize;
    let frame = 0;
    const apply = (size: number): void => {
      if (vertical) setWidth(size);
      else setHeight(size);
    };
    const onMove = (moveEvent: PointerEvent): void => {
      if (!vertical) {
        latest = clampDrawerHeight(startSize + (startY - moveEvent.clientY));
      } else if (dock === 'right') {
        latest = clampDrawerWidth(startSize + (startX - moveEvent.clientX));
      } else {
        latest = clampDrawerWidth(startSize + (moveEvent.clientX - startX));
      }
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        apply(latest);
      });
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setDevtoolsDragActive(false);
      if (frame) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
      apply(latest);
    };
    // 拖拽期间 DevTools 视图改走同步 bounds 更新（见 dragState.ts）
    setDevtoolsDragActive(true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [dock, setHeight, setWidth]);

  const tabs: Array<{ key: DevToolTab; label: string }> = useMemo(() => ([
    { key: 'devtools', label: LL.devtools.tabDevtools() },
    { key: 'capture', label: LL.devtools.tabCapture() },
    { key: 'flash', label: LL.devtools.tabFlash() },
    { key: 'main', label: LL.devtools.tabMain() },
  ]), [LL]);

  const byIssue = (issue: DevToolEntry['issue']): DevToolEntry[] => entries.filter((entry) => entry.issue === issue);

  // 独立窗口：抽屉打开且停靠为 undocked 时建窗；建窗失败则退回上次的内嵌位置
  useEffect(() => {
    if (dock !== 'undocked' || !open) return;
    let alive = true;
    void window.electronAPI.devtoolbox.openDevToolsWindow().then((result) => {
      if (!alive) return;
      if (!result.ok) setDock(useDevToolStore.getState().lastEmbeddedDock);
    }).catch(() => {
      if (alive) setDock(useDevToolStore.getState().lastEmbeddedDock);
    });
    return () => { alive = false; };
  }, [dock, open, setDock]);

  // 窗口被关掉 = 回到内嵌位置（抽屉保持打开），与"关窗=收起"区分开
  useEffect(() => {
    const off = window.electronAPI.devtoolbox.onDevToolsWindowClosed(() => {
      const state = useDevToolStore.getState();
      if (state.dock === 'undocked') setDock(state.lastEmbeddedDock);
    });
    return off;
  }, [setDock]);

  // 收起抽屉（F12 再次按下）时把独立窗口一起关掉
  useEffect(() => {
    if (dock === 'undocked' && !open) void window.electronAPI.devtoolbox.closeDevToolsWindow();
  }, [dock, open]);

  // 窗口尺寸变了以后，存下来的高度/宽度可能超出新的可用空间：夹回来。
  // 不夹的话抽屉会顶出可视区下半截（表现为"面板明明开着，底部却是窗口外"）。
  useEffect(() => {
    if (!open || dock === 'undocked') return undefined;
    const fit = (): void => {
      const state = useDevToolStore.getState();
      if (state.dock === 'undocked') return;
      if (state.dock === 'bottom') {
        const next = clampDrawerHeight(state.height);
        if (next !== state.height) state.setHeight(next);
      } else {
        const next = clampDrawerWidth(state.width);
        if (next !== state.width) state.setWidth(next);
      }
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [open, dock]);

  if (!open || dock === 'undocked') return null;

  const vertical = dock === 'left' || dock === 'right';
  const dockOptions: Array<{ key: DevToolDock; Icon: typeof PanelBottom; label: string }> = [
    { key: 'bottom', Icon: PanelBottom, label: LL.devtools.dockBottom() },
    { key: 'left', Icon: PanelLeft, label: LL.devtools.dockLeft() },
    { key: 'right', Icon: PanelRight, label: LL.devtools.dockRight() },
    { key: 'undocked', Icon: ExternalLink, label: LL.devtools.dockUndocked() },
  ];
  const resizeHandle = (
    <div
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      data-devtools-resize=""
      onPointerDown={startResize}
      onDoubleClick={() => (vertical ? setWidth(defaultDrawerWidth()) : setHeight(defaultDrawerHeight()))}
      style={vertical
        ? {
          width: 6,
          marginLeft: dock === 'right' ? -3 : 0,
          marginRight: dock === 'left' ? -3 : 0,
          cursor: 'col-resize',
          flex: '0 0 auto',
        }
        : { height: 6, marginTop: -3, cursor: 'row-resize', flex: '0 0 auto' }}
    />
  );

  return (
    <div
      className="flex shrink-0"
      data-devtools-drawer=""
      style={{
        flexDirection: vertical ? 'row' : 'column',
        // 左侧停靠要排在页面区之前；底部/右侧排在之后
        order: dock === 'left' ? -1 : 1,
        background: 'var(--bg-panel)',
        ...(vertical
          ? {
            width,
            minWidth: DEVTOOL_MIN_WIDTH,
            ...(dock === 'right'
              ? { borderLeft: '0.5px solid var(--border)' }
              : { borderRight: '0.5px solid var(--border)' }),
          }
          : { height, minHeight: DEVTOOL_MIN_HEIGHT, borderTop: '0.5px solid var(--border)' }),
      }}
    >
      {dock !== 'left' && resizeHandle}

      <div className="flex flex-col flex-1 min-w-0 min-h-0">
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

        {dockOptions.map(({ key, Icon, label }) => {
          const active = dock === key;
          return (
            <button
              key={key}
              type="button"
              className="px-[5px] py-[2px] rounded"
              title={label}
              aria-label={label}
              aria-pressed={active}
              onClick={() => setDock(key)}
              style={{
                color: active ? 'var(--accent)' : 'var(--text-secondary)',
                background: active ? 'var(--bg-panel)' : 'transparent',
              }}
            >
              <Icon className="w-3.5 h-3.5" />
            </button>
          );
        })}

        <button
          type="button"
          className="text-[11px] px-2 py-[2px] rounded"
          style={{ color: 'var(--text-secondary)' }}
          onClick={() => void window.electronAPI.devtoolbox.clear()}
        >
          {LL.devtools.clear()}
        </button>
        {/* 原生面板入口只在 DevToolsTab 的子标签行（带目标上下文），
            顶栏不再放一份，避免出现两个"原生面板" */}
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
          <CaptureTab entries={byIssue('capture')} cdpOwner={cdpOwner} onRefresh={() => void refresh(activeTabId)} />
        )}
        {tab === 'flash' && (
          <FlashTab
            flash={flash}
            probe={probe}
            onRefresh={() => void refresh(activeTabId)}
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

      {dock === 'left' && resizeHandle}
    </div>
  );
};

export default DevToolDrawer;
