import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InstalledUserscript, ParsedUserscriptMetadata } from '@shared/userscript-types';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import type {
  BackgroundStatus,
  EditorState,
  Filter,
  InstallPreview,
  Section,
  ValuesPanelState,
} from './userscripts-page-types';

export function useUserscriptsPage() {
  const { LL } = useI18nContext();
  const [section, setSection] = useState<Section>('installed');
  const [scripts, setScripts] = useState<InstalledUserscript[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [addOpen, setAddOpen] = useState(false);
  const [installUrlInput, setInstallUrlInput] = useState('');
  const [pasteSource, setPasteSource] = useState('');
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [install, setInstall] = useState<InstallPreview | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [updates, setUpdates] = useState<Map<string, string> | null>(null);
  const [checking, setChecking] = useState(false);
  const [bgStatus, setBgStatus] = useState<BackgroundStatus | null>(null);
  const editorDirtyRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const result = (await window.electronAPI.userscripts.list()) as { scripts: InstalledUserscript[] };
      setScripts(result.scripts ?? []);
    } catch {
      setScripts([]);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshBgStatus = useCallback(async (): Promise<void> => {
    try {
      const result = (await window.electronAPI.userscripts.backgroundStatus()) as BackgroundStatus;
      setBgStatus(result);
    } catch { /* status is best-effort */ }
  }, []);

  useEffect(() => {
    void refreshBgStatus();
  }, [refreshBgStatus]);

  const restartBackground = useCallback(async (): Promise<void> => {
    await window.electronAPI.userscripts.backgroundRestart();
    await refreshBgStatus();
  }, [refreshBgStatus]);

  const restartBackgroundScript = useCallback(async (scriptId: string): Promise<void> => {
    await window.electronAPI.userscripts.backgroundRestart(scriptId);
    await refreshBgStatus();
  }, [refreshBgStatus]);

  // Live sync: re-query whenever the main process reports a store change
  // (installs/enables/deletes from the sidebar panel or this page itself).
  useEffect(() => {
    const off = window.electronAPI.userscripts.onChanged(() => void refresh());
    return off;
  }, [refresh]);

  const showNotice = useCallback((message: string): void => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 3000);
  }, []);

  const requestSection = useCallback((next: Section, scriptId: string | null): void => {
    if (section === 'editor' && editorDirtyRef.current && next !== 'editor') {
      const proceed = window.confirm(LL.userscript.dirtyConfirm());
      if (!proceed) return;
    }
    editorDirtyRef.current = false;
    setEditor(null);
    setInstall(null);
    setSection(next);
    if (next === 'editor' && scriptId) {
      void window.electronAPI.userscripts.getSource(scriptId).then((result) => {
        const source = result.source ?? '';
        setEditor({ scriptId, source, initialSource: source, error: null });
      });
    }
  }, [section, LL]);

  const showInstallPreview = useCallback(async (source: string, from: string): Promise<void> => {
    if (section === 'editor' && editorDirtyRef.current) {
      const proceed = window.confirm(LL.userscript.dirtyConfirm());
      if (!proceed) return;
    }
    editorDirtyRef.current = false;
    const result = (await window.electronAPI.userscripts.parseSource(source)) as
      | { ok: false; error: string }
      | { ok: true; preview: ParsedUserscriptMetadata };
    setEditor(null);
    setSection('install');
    if (result.ok) {
      setInstall({ source, from, error: null, metadata: result.preview });
    } else {
      setInstall({ source, from, error: result.error, metadata: null });
    }
  }, [section, LL]);

  const confirmInstall = useCallback(async (): Promise<void> => {
    if (!install) return;
    const result = (await window.electronAPI.userscripts.installSource(install.source)) as
      | { ok: false; error: string }
      | { ok: true; script: InstalledUserscript };
    if (!result.ok) {
      setInstall((previous) => (previous ? { ...previous, error: result.error } : previous));
      return;
    }
    setInstall(null);
    await refresh();
    requestSection('installed', null);
    showNotice(LL.userscript.installSuccess({ name: result.script.metadata.name }));
  }, [install, refresh, requestSection, showNotice, LL]);

  const pickFile = useCallback(async (): Promise<void> => {
    try {
      const result = (await window.electronAPI.userscripts.installFile(LL.userscript.installFileDialogTitle())) as { ok: false; error: string } | { source: string };
      if (!('source' in result)) {
        if (result.error !== 'cancelled') showNotice(LL.userscript.fileReadFailed({ error: result.error }));
        return;
      }
      setAddOpen(false);
      await showInstallPreview(result.source, LL.userscript.installLocalFile());
    } catch (error) {
      showNotice(LL.userscript.fileReadFailed({ error: error instanceof Error ? error.message : String(error) }));
    }
  }, [showInstallPreview, showNotice, LL]);

  const installFromUrl = useCallback(async (): Promise<void> => {
    const url = installUrlInput.trim();
    if (!url) return;
    try {
      const result = (await window.electronAPI.userscripts.installUrl(url)) as { ok: false; error: string } | { source: string };
      if (!('source' in result)) {
        showNotice(LL.userscript.downloadFailed({ error: result.error }));
        return;
      }
      setAddOpen(false);
      await showInstallPreview(result.source, `URL: ${url}`);
    } catch (error) {
      showNotice(LL.userscript.downloadFailed({ error: error instanceof Error ? error.message : String(error) }));
    }
  }, [installUrlInput, showInstallPreview, showNotice, LL]);

  const confirmPaste = useCallback(async (): Promise<void> => {
    if (!pasteSource.trim()) return;
    await showInstallPreview(pasteSource, LL.userscript.pasteSource());
  }, [pasteSource, showInstallPreview, LL]);

  const saveEditor = useCallback(async (): Promise<void> => {
    if (!editor) return;
    const result = (await window.electronAPI.userscripts.updateSource(editor.scriptId, editor.source)) as
      | { ok: false; error: string }
      | { ok: true; script: InstalledUserscript };
    if (!result.ok) {
      setEditor((previous) => (previous ? { ...previous, error: result.error } : previous));
      return;
    }
    editorDirtyRef.current = false;
    await refresh();
    requestSection('installed', null);
    showNotice(LL.userscript.saveSuccess());
  }, [editor, refresh, requestSection, showNotice, LL]);

  const toggleEnabled = useCallback(async (script: InstalledUserscript): Promise<void> => {
    await window.electronAPI.userscripts.setEnabled(script.id, !script.enabled);
    await refresh();
  }, [refresh]);

  const removeScript = useCallback(async (script: InstalledUserscript): Promise<void> => {
    if (!window.confirm(LL.userscript.deleteConfirm({ name: script.metadata.name }))) return;
    await window.electronAPI.userscripts.uninstall(script.id);
    await refresh();
    showNotice(LL.userscript.deleteSuccess({ name: script.metadata.name }));
  }, [refresh, showNotice, LL]);

  const exportScript = useCallback(async (script: InstalledUserscript): Promise<void> => {
    const result = (await window.electronAPI.userscripts.exportSource(script.id, LL.userscript.exportDialogTitle())) as { ok: boolean; path?: string; error?: string };
    showNotice(result.ok && result.path
      ? LL.userscript.exported({ path: result.path })
      : LL.userscript.exportFailed({ error: result.error ?? 'unknown' }));
  }, [showNotice, LL]);

  // ---- GM 值管理 -----------------------------------------------------------
  const [valuesPanel, setValuesPanel] = useState<ValuesPanelState | null>(null);

  const openValuesPanel = useCallback(async (script: InstalledUserscript): Promise<void> => {
    try {
      const result = (await window.electronAPI.userscripts.listValues(script.id)) as { values: Record<string, unknown> };
      setValuesPanel({ scriptId: script.id, values: result.values ?? {}, dirty: null, draft: '', error: null });
    } catch {
      setValuesPanel({ scriptId: script.id, values: {}, dirty: null, draft: '', error: LL.userscript.values.loadFailed() });
    }
  }, [LL]);

  const refreshValues = useCallback(async (scriptId: string): Promise<void> => {
    const result = (await window.electronAPI.userscripts.listValues(scriptId)) as { values: Record<string, unknown> };
    setValuesPanel((previous) => (previous ? { ...previous, values: result.values ?? {}, error: null } : previous));
  }, []);

  const saveValue = useCallback(async (key: string): Promise<void> => {
    if (!valuesPanel) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(valuesPanel.draft);
    } catch {
      setValuesPanel({ ...valuesPanel, error: LL.userscript.values.invalid() });
      return;
    }
    const result = (await window.electronAPI.userscripts.setValueAdmin(valuesPanel.scriptId, key, parsed)) as { ok: boolean };
    if (!result.ok) {
      setValuesPanel({ ...valuesPanel, error: LL.userscript.values.saveFailed() });
      return;
    }
    setValuesPanel({ ...valuesPanel, dirty: null, draft: '', error: null });
    await refreshValues(valuesPanel.scriptId);
  }, [valuesPanel, refreshValues, LL]);

  const deleteValue = useCallback(async (key: string): Promise<void> => {
    if (!valuesPanel) return;
    await window.electronAPI.userscripts.deleteValueAdmin(valuesPanel.scriptId, key);
    await refreshValues(valuesPanel.scriptId);
  }, [valuesPanel, refreshValues]);

  // ---- Manual update check (@updateURL) --------------------------------------
  const checkForUpdates = useCallback(async (): Promise<void> => {
    setChecking(true);
    try {
      const result = (await window.electronAPI.userscripts.checkUpdates()) as {
        updates: Array<{ id: string; name: string; currentVersion: string; latestVersion: string; updateUrl: string }>;
      };
      const map = new Map(result.updates.map((u) => [u.id, u.latestVersion]));
      setUpdates(map);
      showNotice(map.size === 0 ? LL.userscript.update.none() : LL.userscript.update.found({ count: map.size }));
    } catch {
      setUpdates(new Map());
      showNotice(LL.userscript.update.failed({ error: 'ipc' }));
    } finally {
      setChecking(false);
    }
  }, [showNotice, LL]);

  const applyScriptUpdate = useCallback(async (script: InstalledUserscript): Promise<void> => {
    const latest = updates?.get(script.id);
    if (!latest) return;
    // No @connect → the update source is only validated by @match (weak path).
    if (script.metadata.connect.length === 0) {
      if (!window.confirm(LL.userscript.update.weakConfirm())) return;
    }
    const result = (await window.electronAPI.userscripts.applyUpdate(script.id)) as { ok: boolean; error?: string };
    if (result.ok) {
      showNotice(LL.userscript.update.success({ name: script.metadata.name, version: latest }));
      setUpdates((previous) => {
        const next = new Map(previous ?? []);
        next.delete(script.id);
        return next;
      });
      await refresh();
    } else {
      const message = result.error === 'concurrency-limit' || result.error === 'not-ready'
        ? LL.userscript.update.rateLimit()
        : LL.userscript.update.failed({ error: result.error ?? 'unknown' });
      showNotice(message);
    }
  }, [updates, showNotice, LL, refresh]);

  const filtered = useMemo(() => scripts.filter((script) => {
    if (filter === 'enabled' && !script.enabled) return false;
    if (filter === 'disabled' && script.enabled) return false;
    if (!search.trim()) return true;
    const needle = search.trim().toLowerCase();
    return script.metadata.name.toLowerCase().includes(needle)
      || (script.metadata.namespace ?? '').toLowerCase().includes(needle)
      || (script.metadata.match ?? []).some((m) => m.toLowerCase().includes(needle))
      || (script.metadata.include ?? []).some((m) => m.toLowerCase().includes(needle));
  }), [filter, scripts, search]);

  return {
    section,
    scripts,
    loaded,
    search,
    setSearch,
    filter,
    setFilter,
    addOpen,
    setAddOpen,
    installUrlInput,
    setInstallUrlInput,
    pasteSource,
    setPasteSource,
    editor,
    setEditor,
    install,
    notice,
    updates,
    checking,
    bgStatus,
    editorDirtyRef,
    requestSection,
    confirmInstall,
    pickFile,
    installFromUrl,
    confirmPaste,
    saveEditor,
    toggleEnabled,
    removeScript,
    exportScript,
    valuesPanel,
    setValuesPanel,
    openValuesPanel,
    saveValue,
    deleteValue,
    checkForUpdates,
    applyScriptUpdate,
    filtered,
    restartBackground,
    restartBackgroundScript,
  };
}

export type UserscriptsPageState = ReturnType<typeof useUserscriptsPage>;
