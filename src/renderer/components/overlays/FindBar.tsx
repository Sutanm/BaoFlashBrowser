import React, { useRef, useEffect, useState, useCallback } from 'react';
import { ChevronUp, ChevronDown, X } from 'lucide-react';

interface FindBarProps {
  visible: boolean;
  onClose: () => void;
  activeWebview: () => HTMLElement | null;
}

interface FindResult {
  activeMatchOrdinal: number;
  matches: number;
}

const FindBar: React.FC<FindBarProps> = ({ visible, onClose, activeWebview }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [result, setResult] = useState<FindResult>({ activeMatchOrdinal: 0, matches: 0 });

  const handleClose = useCallback(() => {
    const el = activeWebview();
    if (el) (el as any).focus();
    onClose();
  }, [activeWebview, onClose]);

  useEffect(() => {
    if (visible) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      const wv = activeWebview() as any;
      if (wv?.stopFindInPage) wv.stopFindInPage('clearSelection');
      setText('');
      setResult({ activeMatchOrdinal: 0, matches: 0 });
    }
  }, [visible, activeWebview]);

  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        handleClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [visible, handleClose]);

  useEffect(() => {
    const wv = activeWebview() as HTMLElement | null;
    if (!wv) return;
    const onFoundInPage = (e: any) => {
      const r = e.result || e.detail || e;
      if (r.matches !== undefined) {
        setResult({ activeMatchOrdinal: r.activeMatchOrdinal || 0, matches: r.matches });
      }
    };
    wv.addEventListener('found-in-page', onFoundInPage);
    return () => wv.removeEventListener('found-in-page', onFoundInPage);
  }, [activeWebview, visible]);

  const doFind = useCallback((value: string) => {
    const wv = activeWebview() as any;
    if (!wv?.findInPage) return;

    if (!value) {
      wv.stopFindInPage('clearSelection');
      setResult({ activeMatchOrdinal: 0, matches: 0 });
      return;
    }

    wv.findInPage(value);
  }, [activeWebview]);

  const handleInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setText(v);
    doFind(v);
  }, [doFind]);

  const findNext = useCallback(() => {
    (activeWebview() as any)?.findInPage(text, { forward: true, findNext: true });
  }, [activeWebview, text]);

  const findPrev = useCallback(() => {
    (activeWebview() as any)?.findInPage(text, { forward: false, findNext: true });
  }, [activeWebview, text]);

  if (!visible) return null;

  return (
    <div className="find-capsule">
      <input
        ref={inputRef}
        className="find-capsule-input"
        value={text}
        onChange={handleInput}
        onKeyDown={(e) => {
          if (e.key === 'Escape') return handleClose();
          if (e.key === 'Enter') { e.preventDefault(); return e.shiftKey ? findPrev() : findNext(); }
        }}
        placeholder="查找"
        spellCheck={false}
      />
      <span className="find-capsule-count">
        {text ? `${result.activeMatchOrdinal || 0}/${result.matches || 0}` : ''}
      </span>
      <button onClick={findPrev} className="find-capsule-btn" disabled={!text} title="上一个">
        <ChevronUp className="w-3.5 h-3.5" />
      </button>
      <button onClick={findNext} className="find-capsule-btn" disabled={!text} title="下一个">
        <ChevronDown className="w-3.5 h-3.5" />
      </button>
      <button onClick={handleClose} className="find-capsule-btn" title="关闭">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};

export default FindBar;
