import React, { useRef, useEffect } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { contextMenuAtom } from '@renderer/atoms/ui.atom';
import { tabsAtom, activeTabIdAtom } from '@renderer/atoms/tabs.atom';

interface ContextMenuProps {
  onOpenUrl: (url: string, newTab: boolean) => void;
}

function getActiveWebview(): any {
  return document.querySelector('#webview-container webview.active');
}

const ContextMenu: React.FC<ContextMenuProps> = ({ onOpenUrl }) => {
  const [menu, setMenu] = useAtom(contextMenuAtom);
  const tabs = useAtomValue(tabsAtom);
  const activeId = useAtomValue(activeTabIdAtom);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu.visible) return;

    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenu((prev) => ({ ...prev, visible: false }));
      }
    };
    setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => document.removeEventListener('mousedown', handler);
  }, [menu.visible, setMenu]);

  useEffect(() => {
    const onKey = () => setMenu((prev) => ({ ...prev, visible: false }));
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [setMenu]);

  if (!menu.visible) return null;

  const close = () => setMenu((prev) => ({ ...prev, visible: false }));

  const currentTab = tabs.find((t) => t.id === activeId);
  const canGoBack = currentTab?.canGoBack ?? false;
  const canGoForward = currentTab?.canGoForward ?? false;

  let posX = menu.x;
  let posY = menu.y;
  if (posX + 220 > window.innerWidth) posX = window.innerWidth - 224;
  if (posY + 190 > window.innerHeight) posY = window.innerHeight - 194;

  return (
    <div ref={menuRef} className="context-menu" style={{ left: posX, top: posY }}>
      <button
        onClick={() => { getActiveWebview()?.goBack(); close(); }}
        disabled={!canGoBack}
      >
        后退
      </button>
      <button
        onClick={() => { getActiveWebview()?.goForward(); close(); }}
        disabled={!canGoForward}
      >
        前进
      </button>
      <button
        onClick={() => { getActiveWebview()?.reload(); close(); }}
      >
        刷新
      </button>
      <div className="context-separator" />

      {menu.linkURL && (
        <>
          <button onClick={() => { onOpenUrl(menu.linkURL!, true); close(); }}>
            新标签页打开链接
          </button>
          <div className="context-separator" />
        </>
      )}

      {menu.selectionText && (
        <>
          <button onClick={() => { navigator.clipboard.writeText(menu.selectionText!); close(); }}>
            复制
          </button>
          <div className="context-separator" />
        </>
      )}

      <button
        onClick={() => { getActiveWebview()?.openDevTools(); close(); }}
      >
        检查元素
      </button>
    </div>
  );
};

export default ContextMenu;
