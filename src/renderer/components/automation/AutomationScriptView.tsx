import React, { lazy, Suspense } from 'react';
import { BookOpen, Trash2 } from 'lucide-react';
import { useI18nContext } from '../../i18n/i18n-react';
import { AUTOMATION_CAPABILITIES, type AutomationDetail } from './automation-workbench-types';
import type { AutomationWorkbench } from './useAutomationWorkbench';

const CodeEditor = lazy(() => import('../common/CodeEditor'));

type Props = Pick<
  AutomationWorkbench,
  | 'detail'
  | 'selectedScriptId'
  | 'scriptName'
  | 'setScriptName'
  | 'scriptSource'
  | 'setScriptSource'
  | 'scriptLanguage'
  | 'setScriptLanguage'
  | 'permissions'
  | 'setPermissions'
  | 'setDirty'
  | 'busy'
  | 'running'
  | 'setMode'
  | 'deleteCurrentScript'
  | 'applyDetail'
  | 'showError'
> & { detail: AutomationDetail };

export function AutomationScriptView({
  detail,
  selectedScriptId,
  scriptName,
  setScriptName,
  scriptSource,
  setScriptSource,
  scriptLanguage,
  setScriptLanguage,
  permissions,
  setPermissions,
  setDirty,
  busy,
  running,
  setMode,
  deleteCurrentScript,
  applyDetail,
  showError,
}: Props): React.JSX.Element {
  const { LL } = useI18nContext();
  const t = LL.automationWorkbench;
  return (
    <section className="awb-script">
      <div className="script-head">
        <div>
          <h2>
            {selectedScriptId}.{scriptLanguage === 'typescript' ? 'ts' : 'js'}
          </h2>
          <p>
            {scriptLanguage === 'typescript' ? t.typescriptCompiledOnSave() : 'JavaScript'} ·
            {t.sandbox()}
          </p>
        </div>
        {detail.mainEntryId !== selectedScriptId && (
          <button
            onClick={() =>
              void window.electronAPI.automationV3
                .setMainEntry(detail.packageId, selectedScriptId)
                .then((value) => applyDetail(value as AutomationDetail, true))
                .catch(showError)
            }
          >
            {t.setAsMainEntry()}
          </button>
        )}
        <button
          className="danger"
          onClick={() => void deleteCurrentScript()}
          disabled={busy || running}
        >
          <Trash2 />
          {t.deleteScriptLabel()}
        </button>
        <button onClick={() => setMode('docs')}>
          <BookOpen />
          {t.fullApiDocumentation()}
        </button>
      </div>
      <div className="script-body">
        <div className="code-pane">
          <div className="code-meta">
            <input
              value={scriptName}
              onChange={(event) => {
                setScriptName(event.target.value);
                setDirty(true);
              }}
            />
            <select
              value={scriptLanguage}
              onChange={(event) => {
                setScriptLanguage(event.target.value as 'javascript' | 'typescript');
                setDirty(true);
              }}
            >
              <option value="typescript">TypeScript</option>
              <option value="javascript">JavaScript</option>
            </select>
          </div>
          <Suspense fallback={<div role="status">{t.loadingEditor()}</div>}>
            <CodeEditor
              value={scriptSource}
              onChange={(value) => {
                setScriptSource(value);
                setDirty(true);
              }}
              language={scriptLanguage}
            />
          </Suspense>
          <div className="permission-row">
            <b>{t.permissions()}</b>
            {AUTOMATION_CAPABILITIES.map((capability) => (
              <label key={capability}>
                <input
                  type="checkbox"
                  checked={permissions.includes(capability)}
                  onChange={(event) => {
                    setPermissions(
                      event.target.checked
                        ? [...permissions, capability]
                        : permissions.filter((item) => item !== capability),
                    );
                    setDirty(true);
                  }}
                />
                {capability}
              </label>
            ))}
          </div>
        </div>
        <aside className="api-reference">
          <h3>{t.apiQuickReference()}</h3>
          <p>{t.commonSignaturesAreShownHereOpenThe()}</p>
          {[
            'bao.input.click(target)',
            'bao.vision.find(locator)',
            'bao.vision.waitForRegionChange(region, options)',
            'bao.vision.waitForColor(region, colors, options)',
            'bao.ocr.readNumber(region)',
            'bao.time.sleep(ms)',
            'bao.log.info(message)',
          ].map((item) => (
            <button key={item}>{item}</button>
          ))}
        </aside>
      </div>
    </section>
  );
}
