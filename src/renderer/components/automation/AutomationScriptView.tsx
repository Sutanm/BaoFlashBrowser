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

interface ApiRefEntry {
  name: string;
  signature: string;
}
interface ApiRefGroup {
  module: string;
  permission?: string;
  entries: ApiRefEntry[];
}

// 与 automation-docs-data.tsx 的完整文档保持一致的常用签名。
const API_QUICK_REFERENCE: ApiRefGroup[] = [
  {
    module: 'bao.input',
    permission: 'input',
    entries: [
      {
        name: 'click',
        signature:
          "click(target: TargetRef, options?: { button?, count?, timeoutMs?, pollIntervalMs? }): Promise<null>",
      },
      {
        name: 'move',
        signature: "move(target: TargetRef, options?: { durationMs?, timeoutMs? }): Promise<null>",
      },
      {
        name: 'drag',
        signature:
          "drag(options: { from: TargetRef, to: TargetRef, button?, durationMs? }): Promise<null>",
      },
    ],
  },
  {
    module: 'bao.vision',
    permission: 'vision',
    entries: [
      {
        name: 'find',
        signature: 'find(locator: ImageLocator): Promise<ScriptLocatedTarget | null>',
      },
      { name: 'exists', signature: 'exists(locator: LocatorSpec): Promise<boolean>' },
      {
        name: 'waitForRegionChange',
        signature:
          "waitForRegionChange(region: PersistedRegion, options?: { timeoutMs?, consecutiveFrames?, reference? }): Promise<RegionChangeResult>",
      },
      {
        name: 'waitForColor',
        signature:
          "waitForColor(region: PersistedRegion, colors: readonly string[], options?: { timeoutMs?, tolerance? }): Promise<RegionColorResult>",
      },
    ],
  },
  {
    module: 'bao.ocr',
    permission: 'ocr',
    entries: [
      {
        name: 'findText',
        signature: 'findText(locator: TextLocator): Promise<ScriptLocatedTarget | null>',
      },
      {
        name: 'readText',
        signature: 'readText(region?: PersistedRegion, minConfidence?): Promise<string>',
      },
      {
        name: 'readNumber',
        signature: 'readNumber(region?: PersistedRegion, locale?): Promise<number>',
      },
    ],
  },
  {
    module: 'bao.page',
    permission: 'page.read / page.navigate',
    entries: [
      { name: 'url', signature: 'url(): Promise<string>' },
      { name: 'navigate', signature: 'navigate(url: string): Promise<null>' },
      { name: 'reload', signature: 'reload(): Promise<null>' },
    ],
  },
  {
    module: 'bao.time',
    entries: [
      { name: 'sleep', signature: 'sleep(durationMs: number): Promise<null>' },
      { name: 'now', signature: 'now(): Promise<number>' },
    ],
  },
  {
    module: 'bao.log',
    permission: 'log',
    entries: [
      {
        name: 'debug / info / warn / error',
        signature: '(message: string): Promise<null>',
      },
    ],
  },
  {
    module: 'bao.notify',
    permission: 'notify',
    entries: [
      { name: 'show', signature: 'show(title: string, body?: string): Promise<null>' },
    ],
  },
];

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
          {API_QUICK_REFERENCE.map((group) => (
            <div key={group.module} className="api-ref-group">
              <h4>
                {group.module}
                {group.permission && <span className="api-ref-perm">{group.permission}</span>}
              </h4>
              {group.entries.map((entry) => (
                <div key={entry.name} className="api-ref-entry">
                  <code className="api-ref-name">{entry.name}</code>
                  <code className="api-ref-signature">{entry.signature}</code>
                </div>
              ))}
            </div>
          ))}
          <button className="api-ref-full-docs" onClick={() => setMode('docs')}>
            <BookOpen />
            {t.fullApiDocumentation()}
          </button>
        </aside>
      </div>
    </section>
  );
}
