import React from 'react';
import { FileCode2, Workflow } from 'lucide-react';
import { useI18nContext } from '../../i18n/i18n-react';
import type { AutomationWorkbench } from './useAutomationWorkbench';

type Props = Pick<AutomationWorkbench, 'dialog' | 'setDialog' | 'detail' | 'scripts' | 'createFromDialog'>;

export function AutomationDialogModal({
  dialog,
  setDialog,
  detail,
  scripts,
  createFromDialog,
}: Props): React.JSX.Element | null {
  const { LL } = useI18nContext();
  const t = LL.automationWorkbench;
  if (!dialog) return null;
  return (
    <div
      className="awb-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setDialog(undefined);
      }}
    >
      <form
        className="awb-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void createFromDialog();
        }}
      >
        <h2>
          {dialog.kind === 'package'
            ? t.newAutomationPackage()
            : dialog.kind === 'script'
              ? t.newReusableScript()
              : t.selectMainEntry()}
        </h2>
        {dialog.kind === 'main' ? (
          <div className="main-entry-options">
            {[
              ...(detail?.workflow
                ? [{ id: 'workflow', name: t.blocklyWorkflow(), language: 'javascript' as const }]
                : []),
              ...scripts,
            ].map((entry) => (
              <button
                type="button"
                key={entry.id}
                className={dialog.id === entry.id ? 'selected' : ''}
                onClick={() => setDialog({ ...dialog, id: entry.id })}
              >
                {entry.id === 'workflow' ? <Workflow /> : <FileCode2 />}
                <span>
                  <b>{entry.name}</b>
                  <small>{entry.id === 'workflow' ? t.blocklyEntry() : t.scriptEntry()}</small>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <>
            <label>
              ID
              <input
                autoFocus
                value={dialog.id}
                onChange={(event) => setDialog({ ...dialog, id: event.target.value })}
                pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
                required
              />
            </label>
            <label>
              {t.name()}
              <input
                value={dialog.name}
                onChange={(event) => setDialog({ ...dialog, name: event.target.value })}
                required
              />
            </label>
            {dialog.kind === 'script' && (
              <label>
                {t.language()}
                <select
                  value={dialog.language}
                  onChange={(event) =>
                    setDialog({
                      ...dialog,
                      language: event.target.value as 'javascript' | 'typescript',
                    })
                  }
                >
                  <option value="typescript">TypeScript</option>
                  <option value="javascript">JavaScript</option>
                </select>
              </label>
            )}
          </>
        )}
        <div>
          <button type="button" onClick={() => setDialog(undefined)}>
            {t.cancel()}
          </button>
          <button className="primary" type="submit">
            {dialog.kind === 'main' ? t.setAsMainEntry() : t.create()}
          </button>
        </div>
      </form>
    </div>
  );
}
