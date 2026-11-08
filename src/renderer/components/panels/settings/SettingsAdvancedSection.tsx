import React from 'react';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import type { MainConfigForm } from './settings-panel-types';
import type { SettingsPanelState } from './useSettingsPanel';

type Props = Pick<
  SettingsPanelState,
  | 'mainForm'
  | 'handleMainChange'
  | 'exportingDiagnostics'
  | 'handleExportDiagnostics'
  | 'handleOpenSwf'
  | 'cacheConfirming'
  | 'setCacheConfirming'
  | 'clearingCache'
  | 'handleClearCache'
>;

export function SettingsAdvancedSection({
  mainForm,
  handleMainChange,
  exportingDiagnostics,
  handleExportDiagnostics,
  handleOpenSwf,
  cacheConfirming,
  setCacheConfirming,
  clearingCache,
  handleClearCache,
}: Props): React.JSX.Element {
  const { LL } = useI18nContext();
  return (
    <>
      {MODULE_USERSCRIPTS && (
        <div className="panel-card settings-section-card">
          <div className="panel-card-title">{LL.settings.userscriptCapacity.title()}</div>
          <div className="field-hint" style={{ marginBottom: 8 }}>{LL.settings.userscriptCapacity.hint()}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
            {([
              ['userscriptMaxResponseMB', LL.settings.userscriptCapacity.maxResponseMB(), 1, 64],
              ['userscriptTimeoutSeconds', LL.settings.userscriptCapacity.timeoutSeconds(), 1, 120],
              ['userscriptMaxConcurrentPerScript', LL.settings.userscriptCapacity.concurrentPerScript(), 1, 16],
              ['userscriptMaxConcurrentGlobal', LL.settings.userscriptCapacity.concurrentGlobal(), 1, 64],
              ['userscriptDownloadMaxMB', LL.settings.userscriptCapacity.downloadMaxMB(), 1, 64],
              ['userscriptDownloadConcurrent', LL.settings.userscriptCapacity.downloadConcurrent(), 1, 16],
              ['userscriptMaxValueKB', LL.settings.userscriptCapacity.maxValueKB(), 1, 1024],
            ] as Array<[keyof MainConfigForm, string, number, number]>).map(([key, label, min, max]) => (
              <label key={key} style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12 }}>
                <span style={{ opacity: 0.7 }}>{label}</span>
                <input
                  type="number"
                  min={min}
                  max={max}
                  step={1}
                  value={String(mainForm[key] as number)}
                  onChange={(e) => handleMainChange(key, Number(e.target.value))}
                  style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
                />
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="panel-card settings-section-card">
        <div className="panel-card-title">{LL.settings.diagnostics()}</div>
        <button
          onClick={handleOpenSwf}
          style={{
            width: '100%', padding: 8, marginBottom: 8, borderRadius: 6, border: 'none',
            background: 'var(--accent)', color: '#fff', fontSize: 13, cursor: 'pointer',
          }}
        >
          {LL.settings.openLocalSwf()}
        </button>
        {MODULE_DIAGNOSTICS && (
          <>
            <div className="field-hint" style={{ marginBottom: 8 }}>{LL.settings.diagnosticsHint()}</div>
            <button
              disabled={exportingDiagnostics}
              onClick={handleExportDiagnostics}
              style={{
                width: '100%', padding: 8, borderRadius: 6, border: 'none',
                background: 'var(--bg-hover)', color: 'var(--text-primary)', fontSize: 13,
                cursor: exportingDiagnostics ? 'wait' : 'pointer', opacity: exportingDiagnostics ? 0.7 : 1,
              }}
            >
              {exportingDiagnostics ? LL.settings.diagnosticsExporting() : LL.settings.diagnosticsExport()}
            </button>
          </>
        )}
      </div>

      <div className="panel-card settings-section-card">
        <div className="panel-card-title">{LL.settings.cacheTitle()}</div>
        <div className="field-hint" style={{ marginBottom: 8 }}>{LL.settings.cacheHint()}</div>
        <button
          type="button"
          disabled={clearingCache}
          onClick={() => void handleClearCache()}
          onBlur={() => setCacheConfirming(false)}
          style={{
            width: '100%', padding: 8, borderRadius: 6, border: 'none',
            background: cacheConfirming ? '#e67e22' : 'var(--bg-hover)',
            color: cacheConfirming ? '#fff' : 'var(--text-primary)', fontSize: 13,
            cursor: clearingCache ? 'wait' : 'pointer', opacity: clearingCache ? 0.7 : 1,
          }}
        >
          {clearingCache ? LL.settings.cacheClearing() : cacheConfirming ? LL.settings.cacheConfirm() : LL.settings.cacheClear()}
        </button>
      </div>
    </>
  );
}
