import React, { useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react';
import {
  BookOpen,
  Box,
  ChevronLeft,
  ChevronRight,
  Download,
  FileCode2,
  FolderPlus,
  Image,
  ImagePlus,
  Play,
  Plus,
  Save,
  ScanSearch,
  Square,
  Trash2,
  Upload,
  Workflow,
} from 'lucide-react';
import type { JavaScriptAutomationCapability } from '@shared/automation/javascript-api';
import {
  collectAutomationImageGroups,
  decodeAutomationImageGroup,
} from '@shared/automation/image-groups';
import { DEFAULT_IMAGE_MATCH_MASK, DEFAULT_IMAGE_MATCH_THRESHOLD, imageMatchScales } from '@shared/automation/vision-policy';
import { useTabsStore } from '../../store/useTabsStore';
import type { AutomationBlocklyV2EditorHandle } from './AutomationBlocklyV2Editor';
import { docSections } from './automation-docs-data';
import './automation.css';
import { useI18nContext } from '../../i18n/i18n-react';

const AutomationBlocklyV2Editor = lazy(() => import('./AutomationBlocklyV2Editor'));
const CodeEditor = lazy(() => import('../common/CodeEditor'));

const CAPABILITIES: readonly JavaScriptAutomationCapability[] = [
  'input',
  'vision',
  'ocr',
  'page.read',
  'page.navigate',
  'notify',
  'log',
];
type Summary = Awaited<ReturnType<Window['electronAPI']['automationV3']['listPackages']>>[number];
type Detail = Awaited<ReturnType<Window['electronAPI']['automationV3']['getPackage']>>;
type Mode = 'blocks' | 'assets' | 'test' | 'script' | 'docs';
type Dialog = {
  kind: 'package' | 'script' | 'main';
  id: string;
  name: string;
  language: 'javascript' | 'typescript';
};

function shortAsset(asset: string): string {
  return asset.replace(/^assets\//u, '');
}

function AssetPreview({
  packageId,
  asset,
}: {
  packageId: string;
  asset: string;
}): React.JSX.Element {
  const [preview, setPreview] = useState<{ dataUrl: string; width: number; height: number }>();
  useEffect(() => {
    let live = true;
    void window.electronAPI.automationV3
      .assetPreview(packageId, asset)
      .then((value) => {
        if (live) setPreview(value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [asset, packageId]);
  return (
    <>
      {preview ? <img src={preview.dataUrl} alt="" /> : <Image />}
      {preview && (
        <small>
          {preview.width} × {preview.height}
        </small>
      )}
    </>
  );
}

export default function AutomationPage(): React.JSX.Element {
  const { LL } = useI18nContext();
  const t = LL.automationWorkbench;
  const api = window.electronAPI.automationV3;
  const editor = useRef<AutomationBlocklyV2EditorHandle>(null);
  const lastRunState = useRef<string>('idle');
  const tabs = useTabsStore((state) => state.tabs);
  const setActiveTabId = useTabsStore((state) => state.setActiveTabId);
  const [packages, setPackages] = useState<Summary[]>([]);
  const [detail, setDetail] = useState<Detail>();
  const [mode, setMode] = useState<Mode>('blocks');
  const [selectedScriptId, setSelectedScriptId] = useState('');
  const [scriptName, setScriptName] = useState('');
  const [scriptSource, setScriptSource] = useState('');
  const [scriptLanguage, setScriptLanguage] = useState<'javascript' | 'typescript'>('typescript');
  const [permissions, setPermissions] = useState<JavaScriptAutomationCapability[]>(['log']);
  const [selectedAsset, setSelectedAsset] = useState('');
  const [docSection, setDocSection] = useState(0);
  const [contextOpen, setContextOpen] = useState(true);
  const [testKind, setTestKind] = useState<'image' | 'ocr'>('image');
  const [testText, setTestText] = useState<string>(t.buy());
  const [threshold, setThreshold] = useState(DEFAULT_IMAGE_MATCH_THRESHOLD);
  const [testScene, setTestScene] = useState<{
    token: string;
    name: string;
    dataUrl: string;
    sourceWidth: number;
    sourceHeight: number;
  }>();
  const [testResult, setTestResult] = useState<{
    dataUrl: string;
    sourceWidth: number;
    sourceHeight: number;
    matched: boolean;
    rejectionReason?: 'automatic-policy' | 'threshold';
    candidate?: {
      text?: string;
      x: number;
      y: number;
      width: number;
      height: number;
      score?: number;
    };
  }>();
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string>(t.automationCoreReady());
  const [dialog, setDialog] = useState<Dialog>();
  const runnableTabs = tabs.filter((tab) => /^(https?|file):/iu.test(tab.url));
  const [targetTabId, setTargetTabId] = useState('');

  const showError = (error: unknown): void =>
    setNotice(error instanceof Error ? error.message : String(error));
  const applyDetail = useCallback((next: Detail, preserveMode = false): void => {
    setDetail(next);
    setSelectedAsset((current) =>
      next.assets.includes(current) ? current : (next.assets[0] ?? ''),
    );
    if (!preserveMode) {
      if (next.mainEntryId === 'workflow' && next.workflow) setMode('blocks');
      else {
        const script =
          next.scripts.find((entry) => entry.id === next.mainEntryId) ?? next.scripts[0];
        if (script) {
          setSelectedScriptId(script.id);
          setScriptName(script.name);
          setScriptSource(script.source);
          setScriptLanguage(script.language);
          setPermissions([...script.permissions]);
          setMode('script');
        }
      }
    }
    setDirty(false);
  }, []);
  const load = useCallback(
    async (packageId: string) => {
      if (!packageId) {
        setDetail(undefined);
        return;
      }
      applyDetail(await api.getPackage(packageId));
    },
    [api, applyDetail],
  );
  const refresh = useCallback(
    async (preferred?: string) => {
      const list = await api.listPackages();
      setPackages(list);
      const id =
        preferred && list.some((item) => item.packageId === preferred)
          ? preferred
          : (list[0]?.packageId ?? '');
      await load(id);
    },
    [api, load],
  );
  useEffect(() => {
    void refresh().catch(showError);
  }, []);
  useEffect(() => {
    setTargetTabId((current) => runnableTabs.some((tab) => tab.id === current)
      ? current
      : (runnableTabs.slice().sort((left, right) => right.createdAt - left.createdAt)[0]?.id ?? ''));
  }, [runnableTabs.map((tab) => `${tab.id}:${tab.url}`).join('|')]);
  useEffect(() => {
    let live = true;
    const poll = async (): Promise<void> => {
      try {
        const status = await api.status(); if (!live) return;
        const active = ['preparing', 'running', 'cancelling'].includes(status.state);
        setRunning(active);
        if (status.state !== lastRunState.current && ['completed', 'failed', 'cancelled'].includes(status.state)) {
          setNotice(status.message ?? (status.state === 'completed' ? t.automationCompleted() : status.state === 'failed' ? t.automationFailed() : t.stopped()));
        }
        lastRunState.current = status.state;
      } catch { /* Workbench teardown. */ }
    };
    void poll(); const timer = window.setInterval(() => void poll(), 600);
    return () => { live = false; window.clearInterval(timer); };
  }, [api]);

  const selectScript = (id: string): void => {
    const script = detail?.scripts.find((entry) => entry.id === id);
    if (!script) return;
    setSelectedScriptId(id);
    setScriptName(script.name);
    setScriptSource(script.source);
    setScriptLanguage(script.language);
    setPermissions([...script.permissions]);
    setMode('script');
    setDirty(false);
  };
  const save = async (): Promise<boolean> => {
    if (!detail) return false;
    setBusy(true);
    try {
      if (mode === 'script')
        await api.upsertScript(
          detail.packageId,
          selectedScriptId,
          scriptName,
          scriptSource,
          [...permissions],
          scriptLanguage,
        );
      else if (mode === 'blocks' && detail.workflow) {
        const workflow = editor.current?.compile();
        if (!workflow) throw new Error(t.blocklyWorkspaceIsNotReady());
        const validation = await api.validateWorkflow(workflow);
        if (!validation.valid)
          throw new Error(validation.issues.map((issue) => issue.message).join('\n'));
        await api.updateWorkflow(detail.packageId, validation.workflow);
        editor.current?.clearDraft();
      } else {
        setNotice(t.nothingToSaveOnThisPage());
        return true;
      }
      applyDetail(await api.getPackage(detail.packageId), true);
      setNotice(t.saved());
      setDirty(false);
      return true;
    } catch (error) {
      showError(error);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const runMain = async (): Promise<void> => {
    if (!detail || !targetTabId) {
      setNotice(t.openAGamePageFirst());
      return;
    }
    if (dirty && !await save()) return;
    setBusy(true);
    try {
      // The workbench is an internal tab and cannot itself be automated. Switch
      // to the explicitly selected page before reserving its BrowserView.
      setActiveTabId(targetTabId);
      await window.electronAPI.tab.activate(targetTabId);
      await api.start(detail.packageId, detail.mainEntryId, targetTabId);
      setRunning(true);
      setNotice(
        t.starting({ name: detail.mainEntryId === 'workflow' ? t.mainWorkflow() : detail.mainEntryId }),
      );
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };
  const stop = async (): Promise<void> => {
    await api.cancel();
    setRunning(false);
    setNotice(t.stopped());
  };
  const importPackage = async (): Promise<void> => {
    setBusy(true);
    try {
      const opened = await api.openPackage();
      if (opened.canceled) return;
      const requested = [...new Set(opened.scripts.flatMap((entry) => entry.permissions))];
      if (
        requested.length &&
        !window.confirm(t.permission({ permissions: requested.join('\n') }))
      )
        return;
      const approvals = Object.fromEntries(
        opened.scripts.map((entry) => [entry.id, entry.permissions]),
      );
      await api.installPackage(opened.token, opened.exists, approvals);
      await refresh(opened.packageId);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };
  const importAssets = async (): Promise<void> => {
    if (!detail) return;
    setBusy(true);
    try {
      const result = await api.importAssets(detail.packageId);
      if (!result.canceled) {
        applyDetail(result.detail, true);
        setNotice(t.assetsImported());
      }
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };
  const importAssetFolder = async (): Promise<void> => {
    if (!detail) return;
    setBusy(true);
    try {
      const result = await api.importAssetFolder(detail.packageId);
      if (!result.canceled) {
        applyDetail(result.detail, true);
        setNotice(t.imageGroupImportedAndAvailableInImage());
      }
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };
  const deleteAsset = async (): Promise<void> => {
    if (!detail || !selectedAsset || !window.confirm(t.deleteAsset({ name: shortAsset(selectedAsset) })))
      return;
    try {
      applyDetail(await api.deleteAsset(detail.packageId, selectedAsset), true);
    } catch (error) {
      showError(error);
    }
  };
  const deletePackage = async (): Promise<void> => {
    if (!detail || running) return;
    const warning = t.deletePackage({ name: detail.name });
    if (!window.confirm(warning)) return;
    setBusy(true);
    try {
      const deletedName = detail.name;
      await api.deletePackage(detail.packageId);
      setSelectedScriptId('');
      setMode('blocks');
      await refresh();
      setNotice(t.packageDeleted({ name: deletedName }));
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };
  const deleteCurrentScript = async (): Promise<void> => {
    if (!detail || !selectedScriptId || running) return;
    const script = detail.scripts.find((entry) => entry.id === selectedScriptId);
    if (!script) return;
    const mainWarning = detail.mainEntryId === script.id
      ? t.mainWarning()
      : '';
    const dirtyWarning = dirty ? t.dirtyWarning() : '';
    if (!window.confirm(t.deleteScript({ name: script.name, main: mainWarning, dirty: dirtyWarning }))) return;
    setBusy(true);
    try {
      const next = await api.deleteScript(detail.packageId, script.id);
      setSelectedScriptId('');
      applyDetail(next);
      setNotice(t.scriptDeleted({ name: script.name }));
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };
  const openTestScene = async (): Promise<void> => {
    setBusy(true);
    try {
      const opened = await api.openTestScene();
      if (!opened.canceled) {
        setTestScene({
          token: opened.token,
          name: opened.name,
          dataUrl: opened.dataUrl,
          sourceWidth: opened.sourceWidth,
          sourceHeight: opened.sourceHeight,
        });
        setTestResult(undefined);
        setNotice(t.sceneImported({ name: opened.name }));
      }
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };
  const runTest = async (): Promise<void> => {
    if (!detail || !testScene) {
      setNotice(t.importATestScreenshotFirst());
      return;
    }
    setBusy(true);
    try {
      if (testKind === 'image') {
        if (!selectedAsset) throw new Error(t.selectAnAssetFirst());
        const result = await api.testAssetOnScene(
          detail.packageId,
          testScene.token,
          selectedAsset,
          threshold,
          imageMatchScales(),
          DEFAULT_IMAGE_MATCH_MASK,
        );
        setTestResult({
          dataUrl: testScene.dataUrl,
          sourceWidth: testScene.sourceWidth,
          sourceHeight: testScene.sourceHeight,
          matched: result.matched,
          rejectionReason: result.rejectionReason,
          candidate: result.candidate ?? undefined,
        });
      } else {
        const result = await api.testTextOnScene(testScene.token, testText, 'contains', 0.5);
        setTestResult({
          dataUrl: testScene.dataUrl,
          sourceWidth: testScene.sourceWidth,
          sourceHeight: testScene.sourceHeight,
          matched: result.matched,
          candidate: result.candidate ?? undefined,
        });
      }
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };
  const createFromDialog = async (): Promise<void> => {
    if (!dialog) return;
    setBusy(true);
    try {
      if (dialog.kind === 'package') {
        await api.createPackage(dialog.id, dialog.name);
        setDialog(undefined);
        await refresh(dialog.id);
        return;
      }
      if (dialog.kind === 'main') {
        if (!detail) return;
        applyDetail((await api.setMainEntry(detail.packageId, dialog.id)) as Detail, true);
        setDialog(undefined);
        setNotice(t.mainEntryUpdated());
        return;
      }
      if (!detail) return;
      const source =
        dialog.language === 'typescript'
          ? 'const [value] = input as [unknown];\nawait bao.log.info("Script started");\nreturn value ?? null;\n'
          : 'const value = input[0];\nawait bao.log.info("Script started");\nreturn value ?? null;\n';
      await api.upsertScript(
        detail.packageId,
        dialog.id,
        dialog.name,
        source,
        ['log'],
        dialog.language,
      );
      const next = await api.getPackage(detail.packageId);
      const created = next.scripts.find((entry) => entry.id === dialog.id);
      applyDetail(next, true);
      setDialog(undefined);
      if (created) {
        setSelectedScriptId(created.id);
        setScriptName(created.name);
        setScriptSource(created.source);
        setScriptLanguage(created.language);
        setPermissions([...created.permissions]);
        setMode('script');
        setDirty(false);
      }
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const scripts = detail?.scripts ?? [];
  const imageGroups = collectAutomationImageGroups(detail?.assets ?? []);
  const assetChoices = [
    ...imageGroups.map((group) => ({
      value: group.value,
      label: t.groupLabel({ name: shortAsset(group.directory), count: group.assets.length }),
    })),
    ...(detail?.assets ?? []).map((asset) => ({ value: asset, label: shortAsset(asset) })),
  ];
  const selectedImageGroup = decodeAutomationImageGroup(selectedAsset);
  const selectedPreviewAsset = selectedImageGroup?.[0] ?? selectedAsset;
  return (
    <div className="automation-workbench-v3">
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
          <button
            onClick={() =>
              setDialog({
                kind: 'package',
                id: `automation-${Date.now()}`,
                name: t.newAutomation(),
                language: 'typescript',
              })
            }
          >
            <Plus />
            {t.newAutomationPackage()}
          </button>
          <button onClick={() => void importPackage()}>
            <Download />
            {t.import()}
          </button>
          <button
            disabled={!detail}
            onClick={() => detail && void api.exportPackage(detail.packageId)}
          >
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
      <div className="awb-body">
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
        <main className="awb-main">
          {detail?.workflow && mode === 'blocks' && (
            <div className={`awb-blocks ${contextOpen ? '' : 'context-closed'}`}>
              <Suspense fallback={<div role="status">{t.loadingEditor()}</div>}>
                <AutomationBlocklyV2Editor
                  ref={editor}
                  key={`${detail.packageId}:${scripts.map((entry) => entry.id).join(',')}`}
                  packageId={detail.packageId}
                  workflowId={detail.workflow.id}
                  workflowName={detail.workflow.name}
                  initialDocument={detail.workflow}
                  assets={detail.assets.map(shortAsset)}
                  scripts={scripts.map((entry) => entry.id)}
                  onDirtyChange={setDirty}
                />
              </Suspense>
              <aside className="awb-context">
                <button className="collapse" onClick={() => setContextOpen((value) => !value)}>
                  {contextOpen ? <ChevronRight /> : <ChevronLeft />}
                </button>
                {contextOpen && (
                  <>
                    <div className="context-head">
                      <strong>{t.assetTray()}</strong>
                      <button onClick={() => void importAssets()}>
                        <FolderPlus />
                        {t.import()}
                      </button>
                      <small>{t.clickAnAssetToUseItIn()}</small>
                    </div>
                    <div className="awb-asset-grid compact">
                      {detail.assets.map((asset) => (
                        <button
                          key={asset}
                          className={selectedAsset === asset ? 'selected' : ''}
                          onClick={() => setSelectedAsset(asset)}
                        >
                          <AssetPreview packageId={detail.packageId} asset={asset} />
                          <b>{shortAsset(asset)}</b>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </aside>
            </div>
          )}
          {detail && mode === 'assets' && (
            <section className="awb-page">
              <div className="awb-page-head">
                <div>
                  <h2>{t.assets()}</h2>
                  <p>
                    {t.blocklyAndJsTsSharePackageAssets()}
                  </p>
                </div>
                <div>
                  <button onClick={() => void importAssets()}>
                    <Image />
                    {t.importImages()}
                  </button>
                  <button className="primary" onClick={() => void importAssetFolder()}>
                    <FolderPlus />
                    {t.importImageGroupFolder()}
                  </button>
                </div>
              </div>
              <div className="awb-assets-layout">
                <div className="awb-asset-grid">
                  {detail.assets.map((asset) => (
                    <button
                      key={asset}
                      className={selectedAsset === asset ? 'selected' : ''}
                      onClick={() => setSelectedAsset(asset)}
                    >
                      <AssetPreview packageId={detail.packageId} asset={asset} />
                      <b>{shortAsset(asset)}</b>
                    </button>
                  ))}
                  {!detail.assets.length && (
                    <div className="awb-empty">
                      <Image />
                      <b>{t.noAssets()}</b>
                      <span>{t.importPngJpgWebpOrBmpImages()}</span>
                    </div>
                  )}
                </div>
                <aside className="awb-preview">
                  <h3>{selectedAsset ? shortAsset(selectedAsset) : t.selectAnAsset()}</h3>
                  {selectedAsset && (
                    <>
                      <div className="large-preview">
                        <AssetPreview packageId={detail.packageId} asset={selectedAsset} />
                      </div>
                      <button onClick={() => setMode('test')}>{t.testInScene()}</button>
                      <button className="danger" onClick={() => void deleteAsset()}>
                        <Trash2 />
                        {t.deleteAssetLabel()}
                      </button>
                    </>
                  )}
                </aside>
              </div>
            </section>
          )}
          {detail && mode === 'test' && (
            <section className="awb-page">
              <div className="awb-page-head">
                <div>
                  <h2>{t.testCenter()}</h2>
                  <p>{t.importAScreenshotToTestImagesImage()}</p>
                </div>
                <div className="awb-segment">
                  <button
                    className={testKind === 'image' ? 'active' : ''}
                    onClick={() => {
                      setTestKind('image');
                      setTestResult(undefined);
                    }}
                  >
                    {t.imageMatching()}
                  </button>
                  <button
                    className={testKind === 'ocr' ? 'active' : ''}
                    onClick={() => {
                      setTestKind('ocr');
                      setTestResult(undefined);
                    }}
                  >
                    {t.textRecognitionOcr()}
                  </button>
                </div>
              </div>
              <div className="awb-test-layout">
                <aside className="awb-test-controls">
                  {testKind === 'image' ? (
                    <>
                      <label>
                        {t.selectImageOrImageGroup()}
                        <select
                          value={selectedAsset}
                          onChange={(event) => {
                            setSelectedAsset(event.target.value);
                            setTestResult(undefined);
                          }}
                        >
                          {assetChoices.map((choice) => (
                            <option key={choice.value} value={choice.value}>
                              {choice.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        {t.similarity()}{Math.round(threshold * 100)}%
                        <input
                          type="range"
                          min="10"
                          max="100"
                          value={threshold * 100}
                          onChange={(event) => setThreshold(Number(event.target.value) / 100)}
                        />
                      </label>
                      {selectedPreviewAsset && (
                        <div className="awb-test-target-preview">
                          <div>
                            <AssetPreview
                              packageId={detail.packageId}
                              asset={selectedPreviewAsset}
                            />
                          </div>
                          <strong>
                            {selectedImageGroup
                              ? t.groupCount({ count: selectedImageGroup.length })
                              : t.currentMatchingAsset()}
                          </strong>
                          <span>
                            {selectedImageGroup
                              ? shortAsset(selectedImageGroup[0])
                              : shortAsset(selectedPreviewAsset)}
                          </span>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <label>
                        {t.textToRecognize()}
                        <input
                          value={testText}
                          onChange={(event) => setTestText(event.target.value)}
                        />
                      </label>
                      <div className="awb-test-target-preview text">
                        <ScanSearch />
                        <strong>{t.ocrText()}</strong>
                        <span>{testText || t.noTextEntered()}</span>
                      </div>
                    </>
                  )}
                  <button
                    className="primary"
                    onClick={() => void runTest()}
                    disabled={busy || !testScene}
                  >
                    {t.startTest()}
                  </button>
                  {testResult && (
                    <div className={testResult.matched ? 'result good' : 'result bad'}>
                      <b>
                        {testResult.matched
                          ? t.matchFound()
                          : testResult.candidate
                            ? testResult.rejectionReason === 'automatic-policy'
                              ? t.bestCandidateFailedAutomaticValidation()
                              : t.bestCandidateBelowThreshold()
                            : t.noCandidatesFound()}
                      </b>
                      {testResult.candidate && (
                        <span>
                          {testResult.candidate.text
                            ? `“${testResult.candidate.text}” · `
                            : ''}
                          {t.position()}{Math.round(testResult.candidate.x)},
                          {Math.round(testResult.candidate.y)} ·{' '}
                          {Math.round((testResult.candidate.score ?? 0) * 100)}%
                        </span>
                      )}
                    </div>
                  )}
                </aside>
                <div className="awb-scene">
                  {testScene ? (
                    <>
                      <svg
                        className="awb-scene-frame"
                        viewBox={`0 0 ${testScene.sourceWidth} ${testScene.sourceHeight}`}
                        preserveAspectRatio="xMidYMid meet"
                        role="img"
                        aria-label={testScene.name}
                      >
                        <image
                          href={testScene.dataUrl}
                          x="0"
                          y="0"
                          width={testScene.sourceWidth}
                          height={testScene.sourceHeight}
                        />
                        {testResult?.candidate && (
                          <rect
                            className={testResult.matched ? 'matched' : 'candidate'}
                            x={testResult.candidate.x}
                            y={testResult.candidate.y}
                            width={testResult.candidate.width}
                            height={testResult.candidate.height}
                            vectorEffect="non-scaling-stroke"
                          />
                        )}
                      </svg>
                      <span className="automation-test-scene-size">
                        {t.original()}{testScene.sourceWidth} × {testScene.sourceHeight}{t.fit()}
                      </span>
                      <button
                        className="automation-test-scene-replace"
                        onClick={() => void openTestScene()}
                        disabled={busy}
                      >
                        <ImagePlus />
                        {t.changeTestScreenshot()}
                      </button>
                    </>
                  ) : (
                    <button
                      className="automation-test-scene-empty"
                      onClick={() => void openTestScene()}
                      disabled={busy}
                    >
                      <ImagePlus />
                      <strong>{t.importTestScreenshot()}</strong>
                      <small>{t.selectAFullScreenshotForLocalOffline()}</small>
                    </button>
                  )}
                </div>
              </div>
            </section>
          )}
          {detail && mode === 'script' && (
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
                      void api
                        .setMainEntry(detail.packageId, selectedScriptId)
                        .then((value) => applyDetail(value as Detail, true))
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
                    {CAPABILITIES.map((capability) => (
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
          )}
          {mode === 'docs' && (
            <section className="awb-docs">
              <aside>
                {docSections.map((section, index) => (
                  <button key={section.id} className={docSection === index ? 'active' : ''} onClick={() => setDocSection(index)}>{section.title}</button>
                ))}
              </aside>
              <article>
                {docSections[docSection]?.content}
              </article>
            </section>
          )}
          {!detail && (
            <div className="awb-empty full">
              <Workflow />
              <h2>{t.createOrImportAnAutomationPackage()}</h2>
              <button
                onClick={() =>
                  setDialog({
                    kind: 'package',
                    id: `automation-${Date.now()}`,
                    name: t.newAutomation(),
                    language: 'typescript',
                  })
                }
              >
                {t.createAutomation()}
              </button>
            </div>
          )}
        </main>
      </div>
      <footer className="awb-status">
        <span className="ready">● {notice}</span>
        <span>
          {t.entryLabel()}
          {detail?.mainEntryId === 'workflow' ? t.blocklyWorkflow() : (detail?.mainEntryId ?? '-')}
        </span>
        <span>{t.assetCount()}{detail?.assets.length ?? 0}</span>
        <span>{dirty ? t.unsaved() : t.saved()}</span>
      </footer>
      {dialog && (
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
      )}
    </div>
  );
}
