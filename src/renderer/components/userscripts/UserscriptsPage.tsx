// Userscript management page (internal tab, stage 2), Tampermonkey-style
// layout: toolbar (title + search + add), filter tabs, script table with
// enable toggle / status badge / matches / actions, an editor, and a
// two-phase install flow with preview confirmation.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Pencil, Upload, Link as LinkIcon, ClipboardPaste } from 'lucide-react';
import type { InstalledUserscript, ParsedUserscriptMetadata } from '@shared/userscript-types';
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

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'enabled', label: '已启用' },
  { id: 'disabled', label: '已禁用' },
];

function StatusBadge({ enabled }: { enabled: boolean }): React.JSX.Element {
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
      {enabled ? '运行中' : '已禁用'}
    </span>
  );
}

function MatchSummary({ metadata }: { metadata: ParsedUserscriptMetadata }): React.JSX.Element {
  const matches = metadata.match.length > 0 ? metadata.match : metadata.include;
  const text = matches.length > 0 ? matches.join('  ') : (metadata.noframes ? '全部页面' : '无匹配');
  return <span style={{ fontSize: 12, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text}</span>;
}

function PermissionRows({ metadata }: { metadata: ParsedUserscriptMetadata }): React.JSX.Element {
  const rows: Array<[string, string]> = [];
  if (metadata.grant.length > 0) rows.push(['授权', metadata.grant.join(', ')]);
  if (metadata.connect.length > 0) rows.push(['跨域', metadata.connect.join(', ')]);
  if (metadata.require.length > 0) rows.push(['外部脚本', metadata.require.join(' ')]);
  if (metadata.resource.length > 0) rows.push(['资源', metadata.resource.map((r) => r.name ?? r.url).join(', ')]);
  if (rows.length === 0) return <div style={{ opacity: 0.5, fontSize: 12 }}>无额外授权</div>;
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
      const proceed = window.confirm('脚本有未保存的修改，确定离开吗？');
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
  }, [section]);

  const showInstallPreview = useCallback(async (source: string, from: string): Promise<void> => {
    if (section === 'editor' && editorDirtyRef.current) {
      const proceed = window.confirm('脚本有未保存的修改，确定离开吗？');
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
  }, [section]);

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
    showNotice(`已安装「${result.script.metadata.name}」`);
  }, [install, refresh, requestSection, showNotice]);

  const pickFile = useCallback(async (): Promise<void> => {
    try {
      const result = (await window.electronAPI.userscripts.installFile()) as { ok: false; error: string } | { source: string };
      if (!('source' in result)) {
        if (result.error !== 'cancelled') showNotice(`读取文件失败：${result.error}`);
        return;
      }
      setAddOpen(false);
      await showInstallPreview(result.source, '本地文件');
    } catch (error) {
      showNotice(`读取文件失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [showInstallPreview, showNotice]);

  const installFromUrl = useCallback(async (): Promise<void> => {
    const url = installUrlInput.trim();
    if (!url) return;
    try {
      const result = (await window.electronAPI.userscripts.installUrl(url)) as { ok: false; error: string } | { source: string };
      if (!('source' in result)) {
        showNotice(`下载失败：${result.error}`);
        return;
      }
      setAddOpen(false);
      await showInstallPreview(result.source, `URL: ${url}`);
    } catch (error) {
      showNotice(`下载失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [installUrlInput, showInstallPreview, showNotice]);

  const confirmPaste = useCallback(async (): Promise<void> => {
    if (!pasteSource.trim()) return;
    await showInstallPreview(pasteSource, '粘贴源码');
  }, [pasteSource, showInstallPreview]);

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
    showNotice('已保存');
  }, [editor, refresh, requestSection, showNotice]);

  const toggleEnabled = useCallback(async (script: InstalledUserscript): Promise<void> => {
    await window.electronAPI.userscripts.setEnabled(script.id, !script.enabled);
    await refresh();
  }, [refresh]);

  const removeScript = useCallback(async (script: InstalledUserscript): Promise<void> => {
    if (!window.confirm(`删除脚本「${script.metadata.name}」？`)) return;
    await window.electronAPI.userscripts.uninstall(script.id);
    await refresh();
    showNotice(`已删除「${script.metadata.name}」`);
  }, [refresh, showNotice]);

  const filtered = scripts.filter((script) => {
    if (filter === 'enabled' && !script.enabled) return false;
    if (filter === 'disabled' && script.enabled) return false;
    if (!search.trim()) return true;
    const needle = search.trim().toLowerCase();
    return script.metadata.name.toLowerCase().includes(needle)
      || (script.metadata.namespace ?? '').toLowerCase().includes(needle)
      || (script.metadata.match ?? []).some((m) => m.toLowerCase().includes(needle))
      || (script.metadata.include ?? []).some((m) => m.toLowerCase().includes(needle));
  });

  // ---- Editor view ----------------------------------------------------------
  if (section === 'editor' && editor) {
    return (
      <div style={{ flex: 1, overflow: 'auto', padding: 20, background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <button type="button" style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer' }} onClick={() => requestSection('installed', null)}>
            ← 返回列表
          </button>
          <h1 style={{ fontSize: 18, fontWeight: 700, flex: 1 }}>编辑：{editor.scriptId}</h1>
          <button type="button" style={{ padding: '6px 16px', borderRadius: 6, background: 'var(--accent)', color: '#fff', cursor: 'pointer' }} onClick={() => void saveEditor()}>
            保存
          </button>
        </div>
        {editor.error ? <p style={{ color: '#e5484d', marginBottom: 8 }}>保存失败：{editor.error}</p> : null}
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
            ← 返回列表
          </button>
          <h1 style={{ fontSize: 18, fontWeight: 700, flex: 1 }}>安装确认</h1>
          {install.metadata ? (
            <button type="button" style={{ padding: '6px 16px', borderRadius: 6, background: 'var(--accent)', color: '#fff', cursor: 'pointer' }} onClick={() => void confirmInstall()}>
              安装
            </button>
          ) : null}
        </div>
        <p style={{ opacity: 0.6, fontSize: 13, marginBottom: 12 }}>来源：{install.from}</p>
        {install.error ? (
          <p style={{ color: '#e5484d' }}>{install.error}</p>
        ) : install.metadata ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 720 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 18, fontWeight: 700 }}>{install.metadata.name}</span>
              {install.metadata.version ? <span style={{ opacity: 0.6, fontSize: 12 }}>v{install.metadata.version}</span> : null}
              <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, fontWeight: 600, color: 'var(--text-secondary)', background: 'var(--bg-tertiary)' }}>待安装</span>
            </div>
            {install.metadata.namespace ? <div style={{ opacity: 0.6, fontSize: 12 }}>{install.metadata.namespace}</div> : null}
            {install.metadata.description ? <div style={{ fontSize: 13 }}>{install.metadata.description}</div> : null}
            <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div><span style={{ fontWeight: 600, marginRight: 8 }}>匹配范围</span><MatchSummary metadata={install.metadata} /></div>
              <PermissionRows metadata={install.metadata} />
            </div>
            <p style={{ opacity: 0.5, fontSize: 12, marginTop: 8 }}>安装后脚本将按上述匹配范围在所有标签页执行。请确认来源可信。</p>
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

      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, flexShrink: 0 }}>用户脚本</h1>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索名称 / 匹配 / 命名空间"
          style={{ flex: 1, maxWidth: 340, padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
        />
        <button
          type="button"
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 6, background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontWeight: 600 }}
          onClick={() => setAddOpen((v) => !v)}
        >
          <Plus className="w-4 h-4" />
          添加新脚本
        </button>
      </div>

      {/* Add-new panel */}
      {addOpen ? (
        <div style={{ marginBottom: 16, border: '1px solid var(--border)', borderRadius: 10, padding: 14, background: 'var(--bg-secondary)' }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <button type="button" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer' }} onClick={() => void pickFile()}>
              <Upload className="w-4 h-4" />
              从文件安装
            </button>
            <input
              value={installUrlInput}
              onChange={(event) => setInstallUrlInput(event.target.value)}
              placeholder="输入 .user.js 的 URL 后回车"
              onKeyDown={(event) => { if (event.key === 'Enter') void installFromUrl(); }}
              style={{ flex: 1, minWidth: 240, padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
            />
            <button type="button" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer' }} onClick={() => void installFromUrl()}>
              <LinkIcon className="w-4 h-4" />
              从 URL 安装
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <textarea
              value={pasteSource}
              onChange={(event) => setPasteSource(event.target.value)}
              placeholder="或在此粘贴脚本源码…"
              spellCheck={false}
              style={{ flex: 1, height: 120, padding: 10, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontFamily: 'Consolas, monospace', fontSize: 12, resize: 'vertical' }}
            />
            <button type="button" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', flexShrink: 0 }} onClick={() => void confirmPaste()}>
              <ClipboardPaste className="w-4 h-4" />
              解析预览
            </button>
          </div>
        </div>
      ) : null}

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
        {FILTERS.map((item) => (
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
        <span style={{ marginLeft: 'auto', fontSize: 12, opacity: 0.5, alignSelf: 'center' }}>{filtered.length} 个脚本</span>
      </div>

      {/* Script table */}
      {!loaded ? (
        <p>加载中…</p>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 0', opacity: 0.5 }}>
          {search || filter !== 'all' ? '没有匹配的脚本。' : '尚未安装任何脚本。点击右上角"添加新脚本"开始。'}
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', opacity: 0.5, fontSize: 12 }}>
              <th style={{ padding: '6px 10px', fontWeight: 600 }}>启用</th>
              <th style={{ padding: '6px 10px', fontWeight: 600 }}>脚本</th>
              <th style={{ padding: '6px 10px', fontWeight: 600 }}>状态</th>
              <th style={{ padding: '6px 10px', fontWeight: 600 }}>匹配</th>
              <th style={{ padding: '6px 10px', fontWeight: 600, textAlign: 'right' }}>操作</th>
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
                    title={script.enabled ? '禁用' : '启用'}
                    style={{ cursor: 'pointer', width: 15, height: 15 }}
                  />
                </td>
                <td style={{ padding: '8px 10px', minWidth: 200 }}>
                  <button
                    type="button"
                    onClick={() => requestSection('editor', script.id)}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0, color: 'var(--text-primary)' }}
                  >
                    <span style={{ fontWeight: 600, display: 'block' }}>{script.metadata.name}</span>
                    {script.metadata.namespace ? <span style={{ fontSize: 11, opacity: 0.5 }}>{script.metadata.namespace}</span> : null}
                  </button>
                </td>
                <td style={{ padding: '8px 10px' }}><StatusBadge enabled={script.enabled} /></td>
                <td style={{ padding: '8px 10px', maxWidth: 280 }}><MatchSummary metadata={script.metadata} /></td>
                <td style={{ padding: '8px 10px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button
                    type="button"
                    title="编辑"
                    onClick={() => requestSection('editor', script.id)}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 6px', color: 'var(--text-secondary)' }}
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    title="删除"
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
