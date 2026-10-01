import React, { useEffect, useRef } from 'react';
import CodeMirror from 'codemirror';
import 'codemirror/lib/codemirror.css';
import 'codemirror/mode/javascript/javascript.js';
import 'codemirror/addon/edit/matchbrackets.js';
import './code-editor.css';

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language?: 'javascript' | 'typescript';
}

const CodeEditor: React.FC<CodeEditorProps> = ({ value, onChange, language = 'javascript' }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<CodeMirror.Editor | null>(null);

  useEffect(() => {
    if (!containerRef.current || editorRef.current) return;
    const cm = CodeMirror(containerRef.current, {
      value,
      mode: language === 'typescript' ? { name: 'javascript', typescript: true } : 'javascript',
      lineNumbers: true,
      tabSize: 2,
      indentUnit: 2,
      matchBrackets: true,
      spellcheck: false,
      lineWrapping: false,
    });
    editorRef.current = cm;
    cm.on('change', () => onChange(cm.getValue()));

    const refresh = () => {
      try { cm.refresh(); } catch { /* container may be gone */ }
    };
    const el = containerRef.current;
    const isSettled = () => {
      try {
        if (!el || el.offsetParent === null) return false;
        const scroll = el.querySelector('.CodeMirror-scroll');
        return !!scroll && scroll.scrollHeight > scroll.clientHeight;
      } catch { return false; }
    };
    const pollTimer = window.setInterval(() => {
      if (isSettled()) {
        window.clearInterval(pollTimer);
        return;
      }
      refresh();
    }, 200);
    let resizeObs: ResizeObserver | null = null;
    if (typeof ResizeObserver === 'function') {
      try {
        resizeObs = new ResizeObserver(() => refresh());
        resizeObs.observe(el);
      } catch { /* fall back to the timer only */ }
    }

    return () => {
      window.clearInterval(pollTimer);
      if (resizeObs) resizeObs.disconnect();
      editorRef.current = null;
      cm.getWrapperElement().remove();
    };
  }, []);

  useEffect(() => {
    const cm = editorRef.current;
    if (cm && cm.getValue() !== value) {
      const cursor = cm.getCursor();
      cm.setValue(value);
      cm.setCursor(cursor);
    }
  }, [value]);

  return <div ref={containerRef} className="code-editor" />;
};

export default CodeEditor;
