import React, { useEffect, useRef } from 'react';
import CodeMirror from 'codemirror';
import 'codemirror/lib/codemirror.css';
import 'codemirror/mode/javascript/javascript.js';
import 'codemirror/addon/edit/matchbrackets.js';
import './userscript-editor.css';

interface UserscriptEditorProps {
  value: string;
  onChange: (value: string) => void;
}

// CodeMirror 5 based userscript editor (plain-textarea replacement). The
// component is controlled: external `value` changes are synced without
// disturbing the cursor, and edits flow out through onChange.
const UserscriptEditor: React.FC<UserscriptEditorProps> = ({ value, onChange }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<CodeMirror.Editor | null>(null);

  useEffect(() => {
    if (!containerRef.current || editorRef.current) return;
    const cm = CodeMirror(containerRef.current, {
      value,
      mode: 'javascript',
      lineNumbers: true,
      tabSize: 2,
      indentUnit: 2,
      matchBrackets: true,
      spellcheck: false,
      lineWrapping: false,
    });
    editorRef.current = cm;
    cm.on('change', () => onChange(cm.getValue()));

    // CodeMirror measures its viewport and line heights at init time. The
    // editor lives inside UserscriptsPage, which is always mounted but its
    // ancestors can be display:none (tab not active) or zero-sized in some
    // window modes until the about:userscripts tab is shown. Initing while
    // hidden/small gives a 0-height viewport and 0px lines (no scrollbars) —
    // worst for the large built-in Fixer (425KB). Refresh robustly: keep
    // refreshing on a timer while the editor is visible and has a real size,
    // and also on every size change via ResizeObserver. Stop once the
    // scroll container actually has scrollable height (settled).
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const cm = editorRef.current;
    if (cm && cm.getValue() !== value) {
      const cursor = cm.getCursor();
      cm.setValue(value);
      cm.setCursor(cursor);
    }
  }, [value]);

  return <div ref={containerRef} className="userscript-editor" />;
};

export default UserscriptEditor;
