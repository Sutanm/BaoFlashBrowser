import React from 'react';
import { Download, Play, Plus, Save, Square, Trash2, Upload, Workflow } from 'lucide-react';
import { useI18nContext } from '../../i18n/i18n-react';
import type { AutomationWorkbench } from './useAutomationWorkbench';

type Props = Pick<
  AutomationWorkbench,
  | 'packages'
  | 'detail'
  | 'mode'
  | 'scriptLanguage'
  | 'selectedScriptId'
  | 'targetTabId'
  | 'setTargetTabId'
  | 'runnableTabs'
  | 'busy'
  | 'running'
  | 'load'
  | 'importPackage'
  | 'exportPackage'
  | 'deletePackage'
  | 'stop'
  | 'runMain'
  | 'save'
  | 'createPackageDraft'
>;

export function AutomationHeader({
  packages,
  detail,
  mode,
  scriptLanguage,
  selectedScriptId,
  targetTabId,
  setTargetTabId,
  runnableTabs,
  busy,
  running,
  load,
  importPackage,
  exportPackage,
  deletePackage,
  stop,
  runMain,
  save,
  createPackageDraft,
}: Props): React.JSX.Element {
  const { LL } = useI18nContext();
  const t = LL.automationWorkbench;
  return (
    <header className="awb-header">
      <div className="awb-brand">
        <Workflow />
        <span>
          <strong>{t.automationWorkbench()}</strong>
          <small>Automation 2.0</small>
        </span>
      </div>
      <select value={detail?.packageId ?? ''} onChange={(event) => void load(event.target.value)}>
        {packages.map((item) => (
          <option key={item.packageId} value={item.packageId}>
            {item.name}
          </option>
        ))}
      </select>
      <div className="awb-breadcrumb">
        {detail?.name ?? t.noProjectSelected()} <b>/</b>{' '}
        {mode === 'blocks'
          ? t.mainWorkflow()
          : mode === 'script'
            ? `${selectedScriptId}.${scriptLanguage === 'typescript' ? 'ts' : 'js'}`
            : mode === 'assets'
              ? t.assets()
              : mode === 'test'
                ? t.testCenter()
                : t.apiDocumentation()}
      </div>
      <select value={targetTabId} onChange={(event) => setTargetTabId(event.target.value)} title={t.targetPage()}>
        {runnableTabs.length ? runnableTabs.map((tab) => <option key={tab.id} value={tab.id}>{t.runAt()}{tab.title || tab.url}</option>) : <option value="">{t.noRunnablePages()}</option>}
      </select>
      <div className="awb-actions">
        <button onClick={createPackageDraft}>
          <Plus />
          {t.newAutomationPackage()}
        </button>
        <button onClick={() => void importPackage()}>
          <Download />
          {t.import()}
        </button>
        <button disabled={!detail} onClick={exportPackage}>
          <Upload />
          {t.export()}
        </button>
        <button
          className="danger"
          disabled={!detail || busy || running}
          onClick={() => void deletePackage()}
          title={t.deleteCurrentAutomationPackage()}
        >
          <Trash2 />
          {t.deletePackageLabel()}
        </button>
        {running ? (
          <button onClick={() => void stop()}>
            <Square />
            {t.stop()}
          </button>
        ) : (
          <button onClick={() => void runMain()} disabled={!detail || busy}>
            <Play />
            {t.runMainEntry()}
          </button>
        )}
        <button className="primary" onClick={() => void save()} disabled={!detail || busy}>
          <Save />
          {t.save()}
        </button>
      </div>
    </header>
  );
}
