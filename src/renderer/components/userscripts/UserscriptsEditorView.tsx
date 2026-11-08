import React from 'react';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import UserscriptEditor from './UserscriptEditor';
import type { UserscriptsPageState } from './useUserscriptsPage';

type Props = Pick<UserscriptsPageState, 'editor' | 'setEditor' | 'editorDirtyRef' | 'requestSection' | 'saveEditor'> & {
  editor: NonNullable<UserscriptsPageState['editor']>;
};

export function UserscriptsEditorView({
  editor,
  setEditor,
  editorDirtyRef,
  requestSection,
  saveEditor,
}: Props): React.JSX.Element {
  const { LL } = useI18nContext();
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 20, background: 'var(--bg-primary)', color: 'var(--text-primary)', minHeight: 0, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexShrink: 0 }}>
        <button type="button" style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer' }} onClick={() => requestSection('installed', null)}>
          {LL.userscript.backToList()}
        </button>
        <h1 style={{ fontSize: 18, fontWeight: 700, flex: 1 }}>{LL.userscript.editorTitle({ scriptId: editor.scriptId })}</h1>
        <button type="button" style={{ padding: '6px 16px', borderRadius: 6, background: 'var(--accent)', color: '#fff', cursor: 'pointer' }} onClick={() => void saveEditor()}>
          {LL.userscript.save()}
        </button>
      </div>
      {editor.error ? <p style={{ color: '#e5484d', marginBottom: 8 }}>{LL.userscript.saveFailed({ error: editor.error })}</p> : null}
      <UserscriptEditor
        value={editor.source}
        onChange={(value) => {
          editorDirtyRef.current = value !== editor.initialSource;
          setEditor((previous) => (previous ? { ...previous, source: value, error: null } : previous));
        }}
      />
    </div>
  );
}
