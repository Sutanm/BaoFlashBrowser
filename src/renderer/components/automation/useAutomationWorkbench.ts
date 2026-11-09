import { useCallback, useEffect, useRef, useState } from 'react';
import type { JavaScriptAutomationCapability } from '@shared/automation/javascript-api';
import {
  collectAutomationImageGroups,
  decodeAutomationImageGroup,
} from '@shared/automation/image-groups';
import {
  DEFAULT_IMAGE_MATCH_MASK,
  DEFAULT_IMAGE_MATCH_THRESHOLD,
  imageMatchScales,
} from '@shared/automation/vision-policy';
import { localizeAutomationMessage } from '@shared/automation/localized-message';
import { useTabsStore } from '../../store/useTabsStore';
import { useI18nContext } from '../../i18n/i18n-react';
import type { AutomationBlocklyV2EditorHandle } from './AutomationBlocklyV2Editor';
import {
  shortAsset,
  type AutomationDetail,
  type AutomationDialog,
  type AutomationMode,
  type AutomationSummary,
  type ScriptLanguage,
} from './automation-workbench-types';

export function useAutomationWorkbench() {
  const { LL, locale } = useI18nContext();
  const t = LL.automationWorkbench;
  const api = window.electronAPI.automationV3;
  const editor = useRef<AutomationBlocklyV2EditorHandle>(null);
  const lastRunState = useRef<string>('idle');
  const tabs = useTabsStore((state) => state.tabs);
  const setActiveTabId = useTabsStore((state) => state.setActiveTabId);
  const [packages, setPackages] = useState<AutomationSummary[]>([]);
  const [detail, setDetail] = useState<AutomationDetail>();
  const [mode, setMode] = useState<AutomationMode>('blocks');
  const [selectedScriptId, setSelectedScriptId] = useState('');
  const [scriptName, setScriptName] = useState('');
  const [scriptSource, setScriptSource] = useState('');
  const [scriptLanguage, setScriptLanguage] = useState<ScriptLanguage>('typescript');
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
  /** 落盘历史运行日志列表（新→旧），打开历史抽屉时拉取。 */
  const [persistedRunLogs, setPersistedRunLogs] = useState<Array<{ name: string; sizeLabel: string; scriptName: string; startedAt: number }>>([]);
  /** 当前查看的落盘日志条目；null 表示抽屉里还没选中任何一次运行。 */
  const [persistedLogEntries, setPersistedLogEntries] = useState<Array<{ timestamp: number; level: 'info' | 'success' | 'error'; message: string; system?: boolean }> | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [dialog, setDialog] = useState<AutomationDialog>();
  const runnableTabs = tabs.filter((tab) => /^(https?|file):/iu.test(tab.url));
  const [targetTabId, setTargetTabId] = useState('');
  const [currentLogFile, setCurrentLogFile] = useState<string | null>(null);
  const currentPersistedRunLog = currentLogFile ?? null;

  const showError = (error: unknown): void =>
    setNotice(localizeAutomationMessage(error instanceof Error ? error.message : String(error), locale));
  const applyDetail = useCallback((next: AutomationDetail, preserveMode = false): void => {
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
  // 与侧边栏面板共享同一份数据视图：主进程在包/脚本/素材变更后广播。这里只刷新
  // 包列表，不整体重载详情，避免覆盖工作台里正在编辑的内容；当前包被删除时回退。
  const syncRef = useRef({ packageId: '', dirty: false });
  useEffect(() => {
    syncRef.current = { packageId: detail?.packageId ?? '', dirty };
  }, [detail?.packageId, dirty]);
  useEffect(() => {
    const off = api.onChanged(() => {
      void (async () => {
        const list = await api.listPackages();
        setPackages(list);
        const current = syncRef.current;
        if (!list.some((item) => item.packageId === current.packageId)) {
          await load(list[0]?.packageId ?? '');
        }
      })().catch(showError);
    });
    return off;
  }, [api, load]);
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
          setNotice(status.message ? localizeAutomationMessage(status.message, locale) : (status.state === 'completed' ? t.automationCompleted() : status.state === 'failed' ? t.automationFailed() : t.stopped()));
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
  /** 打开历史抽屉并拉取落盘日志列表；文件名来自白名单接口，防目录穿越。 */
  const openHistory = async (): Promise<void> => {
    setHistoryOpen(true);
    try {
      const logs = await window.electronAPI.automationV3.listPersistedRunLogs();
      setPersistedRunLogs(logs);
    } catch (error) {
      showError(error);
    }
  };
  /** 读取某次落盘运行的完整日志条目；文件名白名单校验交给主进程，防目录穿越。 */
  const openPersistedRunLog = async (name: string): Promise<void> => {
    try {
      setCurrentLogFile(name);
      const entries = await window.electronAPI.automationV3.readPersistedRunLog(name);
      setPersistedLogEntries(entries);
    } catch (error) {
      setCurrentLogFile(null);
      setPersistedLogEntries(null);
      showError(error);
    }
  };
  /** 用系统默认程序打开落盘日志文件。 */
  const openPersistedRunLogFile = async (name: string): Promise<void> => {
    try { await window.electronAPI.automationV3.openPersistedRunLog(name); }
    catch (error) { showError(error); }
  };
  /** 关闭历史抽屉并清空当前查看的落盘日志条目。 */
  const closeHistory = (): void => {
    setHistoryOpen(false);
    setPersistedLogEntries(null);
    setCurrentLogFile(null);
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
  const exportPackage = (): void => {
    if (detail) void api.exportPackage(detail.packageId);
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
        applyDetail((await api.setMainEntry(detail.packageId, dialog.id)) as AutomationDetail, true);
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
  const createPackageDraft = (): void =>
    setDialog({
      kind: 'package',
      id: `automation-${Date.now()}`,
      name: t.newAutomation(),
      language: 'typescript',
    });

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

  return {
    editor,
    packages,
    detail,
    mode,
    setMode,
    selectedScriptId,
    scriptName,
    setScriptName,
    scriptSource,
    setScriptSource,
    scriptLanguage,
    setScriptLanguage,
    permissions,
    setPermissions,
    selectedAsset,
    setSelectedAsset,
    docSection,
    setDocSection,
    contextOpen,
    setContextOpen,
    testKind,
    setTestKind,
    testText,
    setTestText,
    threshold,
    setThreshold,
    testScene,
    testResult,
    setTestResult,
    dirty,
    setDirty,
    busy,
    running,
    notice,
    historyOpen,
    persistedRunLogs,
    persistedLogEntries,
    currentPersistedRunLog,
    openHistory,
    closeHistory,
    openPersistedRunLog,
    openPersistedRunLogFile,
    dialog,
    setDialog,
    runnableTabs,
    targetTabId,
    setTargetTabId,
    showError,
    load,
    selectScript,
    save,
    runMain,
    stop,
    importPackage,
    exportPackage,
    importAssets,
    importAssetFolder,
    deleteAsset,
    deletePackage,
    deleteCurrentScript,
    openTestScene,
    runTest,
    createFromDialog,
    createPackageDraft,
    applyDetail,
    scripts,
    imageGroups,
    assetChoices,
    selectedImageGroup,
    selectedPreviewAsset,
  };
}

export type AutomationWorkbench = ReturnType<typeof useAutomationWorkbench>;
