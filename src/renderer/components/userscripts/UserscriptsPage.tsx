// Userscript management page (internal tab, stage 2), Tampermonkey-style
// layout: toolbar (title + search + add), filter tabs, script table with
// enable toggle / status badge / matches / actions, an editor, and a
// two-phase install flow with preview confirmation.

import React from 'react';
import { useUserscriptsPage } from './useUserscriptsPage';
import { UserscriptsEditorView } from './UserscriptsEditorView';
import { UserscriptsInstallView } from './UserscriptsInstallView';
import { UserscriptsList } from './UserscriptsList';
import { UserscriptsValuesDialog } from './UserscriptsValuesDialog';

export default function UserscriptsPage(): React.JSX.Element {
  const state = useUserscriptsPage();

  // ---- Editor view ----------------------------------------------------------
  if (state.section === 'editor' && state.editor) {
    return <UserscriptsEditorView {...state} editor={state.editor} />;
  }

  // ---- Install confirmation view --------------------------------------------
  if (state.section === 'install' && state.install) {
    return <UserscriptsInstallView {...state} install={state.install} />;
  }

  // ---- Installed list (Tampermonkey-style table) ----------------------------
  return (
    <>
      <UserscriptsList {...state} />
      {state.valuesPanel ? (
        <UserscriptsValuesDialog {...state} valuesPanel={state.valuesPanel} />
      ) : null}
    </>
  );
}
