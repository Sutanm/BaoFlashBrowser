// Userscript management page (internal tab, stage 2), Tampermonkey-style
// layout: toolbar (title + search + add), filter tabs, script table with
// enable toggle / status badge / matches / actions, an editor, and a
// two-phase install flow with preview confirmation.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, Pencil, Upload, Link as LinkIcon, ClipboardPaste, RefreshCw, Download, Database } from 'lucide-react';
import type { InstalledUserscript, ParsedUserscriptMetadata } from '@shared/userscript-types';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import UserscriptEditor from './UserscriptEditor';

type Section = 'installed' | 'editor' | 'install';
type Filter = 'all' | 'enabled' | 'disabled';

interface EditorState {
  scriptId: string;
  source: string;
  initialSource: string;
  error: string | null;
}

interface InstallPreview {
  source: string;
  from: string;
  error: string | null;
  metadata: ParsedUserscriptMetadata | null;
}

interface ValuesPanelState {
  scriptId: string;
  values: Record<string, unknown>;
  dirty: string | null;   // 正在编辑的 key
  draft: string;          // 编辑草稿(JSON)
  error: string | null;
}

function useFilters(): Array<{ id: Filter; label: string }> {
  const { LL } = useI18nContext();
  return [
    { id: 'all', label: LL.userscript.filterAll() },
    { id: 'enabled', label: LL.userscript.filterEnabled() },
    { id: 'disabled', label: LL.userscript.filterDisabled() },
  ];
}

function StatusBadge({ enabled }: { enabled: boolean }): React.JSX.Element {
  const { LL } = useI18nContext();
  return (
    <span
      style={{
        fontSize: 11,
        padding: '2px 8px',
        borderRadius: 999,
        fontWeight: 600,
        color: enabled ? '#0e8345' : 'var(--text-secondary)',
        background: enabled ? 'rgba(14,131,69,0.12)' : 'var(--bg-tertiary)',
      }}
    >
      {enabled ? LL.userscript.statusRunning() : LL.userscript.statusDisabled()}
    </span>
  );
}

function MatchSummary({ metadata }: { metadata: ParsedUserscriptMetadata }): React.JSX.Element {
  const { LL } = useI18nContext();
  const matches = metadata.match.length > 0 ? metadata.match : metadata.include;
  const text = matches.length > 0 ? matches.join('  ') : (metadata.noframes ? LL.userscript.matchAllPages() : LL.userscript.matchNone());
  return <span style={{ fontSize: 12, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text}</span>;
}

function PermissionRows({ metadata }: { metadata: ParsedUserscriptMetadata }): React.JSX.Element {
  const { LL } = useI18nContext();
  const rows: Array<[string, string]> = [];
  if (metadata.grant.length > 0) rows.push([LL.userscript.permission(), metadata.grant.join(', ')]);
  if (metadata.connect.length > 0) rows.push([LL.userscript.permissionCrossOrigin(), metadata.connect.join(', ')]);
  if (metadata.require.length > 0) rows.push([LL.userscript.permissionExternalScript(), metadata.require.join(' ')]);
  if (metadata.resource.length > 0) rows.push([LL.userscript.permissionResources(), metadata.resource.map((r) => r.name ?? r.url).join(', ')]);
  if (rows.length === 0) return <div style={{ opacity: 0.5, fontSize: 12 }}>{LL.userscript.permissionNone()}</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12, opacity: 0.75 }}>
      {rows.map(([key, value]) => (
        <div key={key} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <span style={{ fontWeight: 600, marginRight: 6 }}>{key}</span>
          <span>{value}</span>
        </div>
      ))}
    </div>
  );
}

export default function UserscriptsPage(): React.JSX.Element {
  const { LL } = useI18nContext();
  const filters = useFilters();
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
  const [bgStatus, setBgStatus] = useState<{
    scripts: Array<{ scriptId: string; running: boolean; crashedCount: number; stopped: boolean }>;
    stopped: boolean;
  } | null>(null);
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
      const result = (await window.electronAPI.userscripts.backgroundStatus()) as {
        scripts: Array<{ scriptId: string; running: boolean; crashedCount: number; stopped: boolean }>;
        stopped: boolean;
      };
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

  // ---- Editor view ----------------------------------------------------------
  if (section === 'editor' && editor) {
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

  // ---- Install confirmation view --------------------------------------------
  if (section === 'install' && install) {
    return (
      <div style={{ flex: 1, overflow: 'auto', padding: 20, background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <button type="button" style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer' }} onClick={() => requestSection('installed', null)}>
            {LL.userscript.backToList()}
          </button>
          <h1 style={{ fontSize: 18, fontWeight: 700, flex: 1 }}>{LL.userscript.installConfirm()}</h1>
          {install.metadata ? (
            <button type="button" style={{ padding: '6px 16px', borderRadius: 6, background: 'var(--accent)', color: '#fff', cursor: 'pointer' }} onClick={() => void confirmInstall()}>
              {LL.userscript.install()}
            </button>
          ) : null}
        </div>
        <p style={{ opacity: 0.6, fontSize: 13, marginBottom: 12 }}>{LL.userscript.installSource({ from: install.from })}</p>
        {install.error ? (
          <p style={{ color: '#e5484d' }}>{install.error}</p>
        ) : install.metadata ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 720 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 18, fontWeight: 700 }}>{install.metadata.name}</span>
              {install.metadata.version ? <span style={{ opacity: 0.6, fontSize: 12 }}>v{install.metadata.version}</span> : null}
              <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, fontWeight: 600, color: 'var(--text-secondary)', background: 'var(--bg-tertiary)' }}>{LL.userscript.installBadge()}</span>
            </div>
            {install.metadata.namespace ? <div style={{ opacity: 0.6, fontSize: 12 }}>{install.metadata.namespace}</div> : null}
            {install.metadata.description ? <div style={{ fontSize: 13 }}>{install.metadata.description}</div> : null}
            <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div><span style={{ fontWeight: 600, marginRight: 8 }}>{LL.userscript.installMatchScope()}</span><MatchSummary metadata={install.metadata} /></div>
              <PermissionRows metadata={install.metadata} />
            </div>
            <p style={{ opacity: 0.5, fontSize: 12, marginTop: 8 }}>{LL.userscript.installWarning()}</p>
          </div>
        ) : null}
      </div>
    );
  }

  // ---- Installed list (Tampermonkey-style table) ----------------------------
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 20, background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
      {notice ? (
        <div style={{ position: 'sticky', top: 0, zIndex: 10, marginBottom: 12, padding: '8px 14px', borderRadius: 8, background: 'rgba(14,131,69,0.12)', color: '#0e8345', fontSize: 13, fontWeight: 600 }}>
          {notice}
        </div>
      ) : null}

      {/* Background runtime stopped banner */}
      {bgStatus && bgStatus.stopped && bgStatus.scripts.filter((s) => s.stopped).length > 0 ? (
        <div style={{ marginBottom: 12, padding: '8px 14px', borderRadius: 8, background: 'rgba(229,72,77,0.1)', color: '#e5484d', fontSize: 13, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {bgStatus.scripts.filter((s) => s.stopped).map((s) => (
            <div key={s.scriptId} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ flex: 1, fontWeight: 600 }}>
                {scripts.find((sc) => sc.id === s.scriptId)?.metadata.name ?? s.scriptId}
              </span>
              <button
                type="button"
                onClick={() => void restartBackgroundScript(s.scriptId)}
                style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid rgba(229,72,77,0.5)', background: 'transparent', color: '#e5484d', cursor: 'pointer', fontSize: 12 }}
              >
                {LL.userscript.background.restartScript()}
              </button>
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ flex: 1, opacity: 0.8 }}>{LL.userscript.background.restartAllHint()}</span>
            <button
              type="button"
              onClick={() => void restartBackground()}
              style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid rgba(229,72,77,0.5)', background: 'transparent', color: '#e5484d', cursor: 'pointer', fontSize: 12 }}
            >
              {LL.userscript.background.restart()}
            </button>
          </div>
        </div>
      ) : null}

      {/* GM values panel */}
      {valuesPanel ? (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, width: 540, maxHeight: '70vh', overflow: 'auto', color: 'var(--text-primary)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
              <span style={{ fontSize: 16, fontWeight: 700, flex: 1 }}>{LL.userscript.values.title()}</span>
              <button type="button" onClick={() => setValuesPanel(null)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 16 }}>×</button>
            </div>
            {valuesPanel.error ? <p style={{ color: '#e5484d', fontSize: 12, marginBottom: 8 }}>{valuesPanel.error}</p> : null}
            {Object.keys(valuesPanel.values).length === 0 ? (
              <p style={{ opacity: 0.5, fontSize: 13 }}>{LL.userscript.values.empty()}</p>
            ) : (
              Object.entries(valuesPanel.values).map(([key, value]) => (
                <div key={key} style={{ border: '1px solid var(--border-light)', borderRadius: 8, padding: 8, marginBottom: 8 }}>
                  {valuesPanel.dirty === key ? (
                    <>
                      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{key}</div>
                      <textarea
                        value={valuesPanel.draft}
                        onChange={(e) => setValuesPanel({ ...valuesPanel, draft: e.target.value })}
                        spellCheck={false}
                        style={{ width: '100%', height: 60, padding: 6, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontFamily: 'Consolas, monospace', fontSize: 12 }}
                      />
                      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                        <button type="button" onClick={() => void saveValue(key)} style={{ padding: '3px 10px', borderRadius: 6, background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontSize: 12, border: 'none' }}>
                          {LL.userscript.values.save()}
                        </button>
                        <button type="button" onClick={() => setValuesPanel({ ...valuesPanel, dirty: null, draft: '', error: null })} style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', fontSize: 12 }}>
                          {LL.userscript.values.cancel()}
                        </button>
                      </div>
                    </>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 600 }}>{key}</div>
                        <div style={{ fontSize: 12, opacity: 0.75, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'Consolas, monospace' }}>
                          {JSON.stringify(value)}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setValuesPanel({ ...valuesPanel, dirty: key, draft: JSON.stringify(value), error: null })}
                        style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--accent)', fontSize: 12, flexShrink: 0 }}
                      >
                        {LL.userscript.values.edit()}
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteValue(key)}
                        style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#e5484d', fontSize: 12, flexShrink: 0 }}
                      >
                        {LL.userscript.values.delete()}
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}

      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, flexShrink: 0 }}>{LL.userscript.title()}</h1>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={LL.userscript.searchPlaceholder()}
          style={{ flex: 1, maxWidth: 340, padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
        />
        <button
          type="button"
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', color: 'var(--text-primary)', fontWeight: 600 }}
          onClick={() => void checkForUpdates()}
          disabled={checking}
        >
          <RefreshCw className={`w-4 h-4 ${checking ? '' : ''}`} style={checking ? { animation: 'spin 1s linear infinite' } : undefined} />
          {checking ? LL.userscript.update.checking() : LL.userscript.update.checkButton()}
        </button>
        <button
          type="button"
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 6, background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontWeight: 600 }}
          onClick={() => setAddOpen((v) => !v)}
        >
          <Plus className="w-4 h-4" />
          {LL.userscript.addNew()}
        </button>
      </div>

      {/* Add-new panel */}
      {addOpen ? (
        <div style={{ marginBottom: 16, border: '1px solid var(--border)', borderRadius: 10, padding: 14, background: 'var(--bg-secondary)' }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <button type="button" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer' }} onClick={() => void pickFile()}>
              <Upload className="w-4 h-4" />
              {LL.userscript.installFromFile()}
            </button>
            <input
              value={installUrlInput}
              onChange={(event) => setInstallUrlInput(event.target.value)}
              placeholder={LL.userscript.urlPlaceholder()}
              onKeyDown={(event) => { if (event.key === 'Enter') void installFromUrl(); }}
              style={{ flex: 1, minWidth: 240, padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
            />
            <button type="button" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer' }} onClick={() => void installFromUrl()}>
              <LinkIcon className="w-4 h-4" />
              {LL.userscript.installFromUrl()}
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <textarea
              value={pasteSource}
              onChange={(event) => setPasteSource(event.target.value)}
              placeholder={LL.userscript.pastePlaceholder()}
              spellCheck={false}
              style={{ flex: 1, height: 120, padding: 10, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontFamily: 'Consolas, monospace', fontSize: 12, resize: 'vertical' }}
            />
            <button type="button" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', flexShrink: 0 }} onClick={() => void confirmPaste()}>
              <ClipboardPaste className="w-4 h-4" />
              {LL.userscript.parsePreview()}
            </button>
          </div>
        </div>
      ) : null}

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
        {filters.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setFilter(item.id)}
            style={{
              padding: '4px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
              border: 'none',
              background: filter === item.id ? 'var(--accent)' : 'transparent',
              color: filter === item.id ? '#fff' : 'var(--text-secondary)',
            }}
          >
            {item.label}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 12, opacity: 0.5, alignSelf: 'center' }}>{LL.userscript.scriptCount({ count: filtered.length })}</span>
      </div>

      {/* Script table */}
      {!loaded ? (
        <p>{LL.userscript.loading()}</p>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 0', opacity: 0.5 }}>
          {search || filter !== 'all' ? LL.userscript.noMatch() : LL.userscript.empty()}
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', opacity: 0.5, fontSize: 12 }}>
              <th style={{ padding: '6px 10px', fontWeight: 600 }}>{LL.userscript.colEnable()}</th>
              <th style={{ padding: '6px 10px', fontWeight: 600 }}>{LL.userscript.colScript()}</th>
              <th style={{ padding: '6px 10px', fontWeight: 600 }}>{LL.userscript.colStatus()}</th>
              <th style={{ padding: '6px 10px', fontWeight: 600 }}>{LL.userscript.colMatch()}</th>
              <th style={{ padding: '6px 10px', fontWeight: 600, textAlign: 'right' }}>{LL.userscript.colActions()}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((script) => (
              <tr key={script.id} style={{ borderTop: '1px solid var(--border-light)' }}>
                <td style={{ padding: '8px 10px' }}>
                  <input
                    type="checkbox"
                    checked={script.enabled}
                    onChange={() => void toggleEnabled(script)}
                    title={script.enabled ? LL.userscript.disable() : LL.userscript.enable()}
                    style={{ cursor: 'pointer', width: 15, height: 15 }}
                  />
                </td>
                <td style={{ padding: '8px 10px', minWidth: 200 }}>
                  <button
                    type="button"
                    onClick={() => requestSection('editor', script.id)}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0, color: 'var(--text-primary)' }}
                  >
                    <span style={{ fontWeight: 600, display: 'block' }}>
                      {script.metadata.name}
                      {script.edited ? (
                        <span style={{ marginLeft: 6, fontSize: 10, padding: '1px 6px', borderRadius: 999, color: '#c77d2f', background: 'rgba(199,125,47,0.14)', fontWeight: 600 }}>
                          {LL.userscript.update.edited()}
                        </span>
                      ) : null}
                    </span>
                    {script.metadata.namespace ? <span style={{ fontSize: 11, opacity: 0.5 }}>{script.metadata.namespace}</span> : null}
                    {script.metadata.updateUrl && script.metadata.connect.length === 0 ? (
                      <span style={{ display: 'block', fontSize: 10, opacity: 0.55, color: '#c77d2f' }}>{LL.userscript.update.weakSource()}</span>
                    ) : null}
                  </button>
                </td>
                <td style={{ padding: '8px 10px' }}><StatusBadge enabled={script.enabled} /></td>
                <td style={{ padding: '8px 10px', maxWidth: 280 }}><MatchSummary metadata={script.metadata} /></td>
                <td style={{ padding: '8px 10px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {updates?.get(script.id) ? (
                    <button
                      type="button"
                      title={LL.userscript.update.latest({ version: updates.get(script.id) ?? '' })}
                      onClick={() => void applyScriptUpdate(script)}
                      style={{ background: 'transparent', border: '1px solid var(--accent)', color: 'var(--accent)', borderRadius: 6, padding: '2px 8px', cursor: 'pointer', marginRight: 4, fontSize: 12 }}
                    >
                      {LL.userscript.update.latest({ version: updates.get(script.id) ?? '' })}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    title={LL.userscript.edit()}
                    onClick={() => requestSection('editor', script.id)}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 6px', color: 'var(--text-secondary)' }}
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    title={LL.userscript.values.open()}
                    onClick={() => void openValuesPanel(script)}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 6px', color: 'var(--text-secondary)' }}
                  >
                    <Database className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    title={LL.userscript.export()}
                    onClick={() => void exportScript(script)}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 6px', color: 'var(--text-secondary)' }}
                  >
                    <Download className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    title={LL.userscript.delete()}
                    onClick={() => void removeScript(script)}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 6px', color: 'var(--text-secondary)' }}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
