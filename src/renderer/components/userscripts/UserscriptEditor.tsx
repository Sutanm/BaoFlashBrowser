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
    return () => {
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
