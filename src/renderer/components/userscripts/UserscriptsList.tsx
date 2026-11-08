import React from 'react';
import { Download, Database, Link as LinkIcon, Pencil, Plus, RefreshCw, Trash2, Upload, ClipboardPaste } from 'lucide-react';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import { MatchSummary, StatusBadge } from './UserscriptsMetadata';
import type { Filter } from './userscripts-page-types';
import type { UserscriptsPageState } from './useUserscriptsPage';

type Props = Pick<
  UserscriptsPageState,
  | 'notice'
  | 'bgStatus'
  | 'scripts'
  | 'restartBackgroundScript'
  | 'restartBackground'
  | 'search'
  | 'setSearch'
  | 'checkForUpdates'
  | 'checking'
  | 'addOpen'
  | 'setAddOpen'
  | 'pickFile'
  | 'installUrlInput'
  | 'setInstallUrlInput'
  | 'installFromUrl'
  | 'pasteSource'
  | 'setPasteSource'
  | 'confirmPaste'
  | 'filter'
  | 'setFilter'
  | 'filtered'
  | 'loaded'
  | 'updates'
  | 'applyScriptUpdate'
  | 'requestSection'
  | 'openValuesPanel'
  | 'exportScript'
  | 'removeScript'
  | 'toggleEnabled'
>;

function useFilters(): Array<{ id: Filter; label: string }> {
  const { LL } = useI18nContext();
  return [
    { id: 'all', label: LL.userscript.filterAll() },
    { id: 'enabled', label: LL.userscript.filterEnabled() },
    { id: 'disabled', label: LL.userscript.filterDisabled() },
  ];
}

export function UserscriptsList({
  notice,
  bgStatus,
  scripts,
  restartBackgroundScript,
  restartBackground,
  search,
  setSearch,
  checkForUpdates,
  checking,
  addOpen,
  setAddOpen,
  pickFile,
  installUrlInput,
  setInstallUrlInput,
  installFromUrl,
  pasteSource,
  setPasteSource,
  confirmPaste,
  filter,
  setFilter,
  filtered,
  loaded,
  updates,
  applyScriptUpdate,
  requestSection,
  openValuesPanel,
  exportScript,
  removeScript,
  toggleEnabled,
}: Props): React.JSX.Element {
  const { LL } = useI18nContext();
  const filters = useFilters();
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
