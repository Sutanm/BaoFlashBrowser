import React from 'react';
import { BookOpen, Box, FileCode2, Plus, ScanSearch, Workflow } from 'lucide-react';
import { useI18nContext } from '../../i18n/i18n-react';
import { shortAsset } from './automation-workbench-types';
import type { AutomationWorkbench } from './useAutomationWorkbench';

type Props = Pick<
  AutomationWorkbench,
  'detail' | 'mode' | 'setMode' | 'scripts' | 'selectedScriptId' | 'selectScript' | 'setDialog'
>;

export function AutomationSidebar({
  detail,
  mode,
  setMode,
  scripts,
  selectedScriptId,
  selectScript,
  setDialog,
}: Props): React.JSX.Element {
  const { LL } = useI18nContext();
  const t = LL.automationWorkbench;
  return (
    <aside className="awb-sidebar">
      <div className="awb-section-title">
        <strong>{t.mainEntry()}</strong>
        <span>1</span>
      </div>
      {detail && (
        <button
          className={`awb-entry ${mode === (detail.mainEntryId === 'workflow' ? 'blocks' : 'script') ? 'selected' : ''}`}
          onClick={() =>
            detail.mainEntryId === 'workflow'
              ? setMode('blocks')
              : selectScript(detail.mainEntryId)
          }
        >
          {detail.mainEntryId === 'workflow' ? <Workflow /> : <FileCode2 />}
          <span>
            <strong>
              {detail.mainEntryId === 'workflow'
                ? t.mainWorkflow()
                : scripts.find((entry) => entry.id === detail.mainEntryId)?.name}
            </strong>
            <small>
              {detail.mainEntryId === 'workflow'
                ? t.blocklyExecutedWhenRun()
                : t.scriptExecutedWhenRun()}
            </small>
          </span>
        </button>
      )}
      <button
        className="dashed"
        onClick={() =>
          detail &&
          setDialog({ kind: 'main', id: detail.mainEntryId, name: '', language: 'typescript' })
        }
      >
        {t.changeMainEntry()}
      </button>
      <div className="awb-section-title">
        <strong>{t.reusableScripts()}</strong>
        <span>{scripts.length}</span>
      </div>
      {scripts.map((script) => (
        <button
          key={script.id}
          className={`awb-entry ${mode === 'script' && selectedScriptId === script.id ? 'selected' : ''}`}
          onClick={() => selectScript(script.id)}
        >
          <span className={`language ${script.language === 'typescript' ? 'ts' : 'js'}`}>
            {script.language === 'typescript' ? 'TS' : 'JS'}
          </span>
          <span>
            <strong>{script.name}</strong>
            <small>{shortAsset(script.path)}{t.callable()}</small>
          </span>
        </button>
      ))}
      {detail && (
        <button
          className="dashed"
          onClick={() =>
            setDialog({
              kind: 'script',
              id: `script-${scripts.length + 1}`,
              name: t.newScript(),
              language: 'typescript',
            })
          }
        >
          <Plus />
          {t.newJsTsScript()}
        </button>
      )}
      <div className="awb-section-title">
        <strong>{t.resources()}</strong>
      </div>
      <nav>
        <button className={mode === 'assets' ? 'active' : ''} onClick={() => setMode('assets')}>
          <Box />
          {t.manageAssets()}
        </button>
        <button className={mode === 'test' ? 'active' : ''} onClick={() => setMode('test')}>
          <ScanSearch />
          {t.testRecognition()}
        </button>
        <button className={mode === 'docs' ? 'active' : ''} onClick={() => setMode('docs')}>
          <BookOpen />
          {t.apiDocumentation()}
        </button>
      </nav>
      <p className="awb-help">
        <b>{t.oneDefaultMainEntry()}</b>{t.scriptsCanRunAsTheMainEntry()}
      </p>
    </aside>
  );
}
