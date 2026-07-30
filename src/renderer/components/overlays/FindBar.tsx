import React, { useRef, useEffect, useState, useCallback } from 'react';
import { ChevronUp, ChevronDown, X } from 'lucide-react';

interface FindBarProps {
  visible: boolean;
  activeTabId: string | null;
  onClose: () => void;
}

interface FindResult { activeMatchOrdinal: number; matches: number; }

const FindBar: React.FC<FindBarProps> = ({ visible, activeTabId, onClose }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [result, setResult] = useState<FindResult>({ activeMatchOrdinal: 0, matches: 0 });

  const handleClose = useCallback(() => {
    if (activeTabId) window.electronAPI.tab.stopFind(activeTabId, 'clearSelection');
    onClose();
    setText('');
    setResult({ activeMatchOrdinal: 0, matches: 0 });
  }, [activeTabId, onClose]);

  useEffect(() => {
    if (visible) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [visible]);

  useEffect(() => {
    const unsub = window.electronAPI.on('tab:found', (payload: any) => {
      if (payload.tabId === activeTabId) {
        setResult({ activeMatchOrdinal: payload.activeMatchOrdinal || 0, matches: payload.matches || 0 });
      }
    });
    return () => { try { unsub(); } catch {} };
  }, [activeTabId]);

  const doFind = useCallback((value: string) => {
    if (!activeTabId) return;
    if (!value) {
      window.electronAPI.tab.stopFind(activeTabId, 'clearSelection');
      setResult({ activeMatchOrdinal: 0, matches: 0 });
      return;
    }
    window.electronAPI.tab.find(activeTabId, value);
  }, [activeTabId]);

  const handleInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value; setText(v); doFind(v);
  }, [doFind]);

  const findNext = () => { if (activeTabId) window.electronAPI.tab.find(activeTabId, text, { forward: true, findNext: true }); };
  const findPrev = () => { if (activeTabId) window.electronAPI.tab.find(activeTabId, text, { forward: false, findNext: true }); };

  if (!visible) return null;

  return (
    <div className="find-bar-embed">
      <input ref={inputRef} className="find-bar-embed-input" value={text} onChange={handleInput}
        onKeyDown={e => {
          if (e.key === 'Escape') handleClose();
          if (e.key === 'Enter') { e.preventDefault(); return e.shiftKey ? findPrev() : findNext(); }
        }} placeholder="查找" spellCheck={false}
      />
      <span className="find-bar-embed-count">{text ? `${result.activeMatchOrdinal || 0}/${result.matches || 0}` : ''}</span>
      <button onClick={findPrev} className="find-bar-embed-btn" disabled={!text}><ChevronUp className="w-3.5 h-3.5" /></button>
      <button onClick={findNext} className="find-bar-embed-btn" disabled={!text}><ChevronDown className="w-3.5 h-3.5" /></button>
      <button onClick={handleClose} className="find-bar-embed-btn"><X className="w-3.5 h-3.5" /></button>
    </div>
  );
};
export default FindBar;
