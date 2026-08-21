import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bug, Camera, Check, Clock3, Play, ScanSearch, Square, StepForward, Upload, Workflow, X } from 'lucide-react';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import { resolveAutomationMessage } from '../automation/automation-message';
import '../automation/automation.css';

type PackageSummary = { packageId: string; id: string; name: string; assets: string[] };

type Status = Awaited<ReturnType<Window['electronAPI']['automation']['status']>>;
type AssetMatch = Awaited<ReturnType<Window['electronAPI']['automation']['testAsset']>>;
type CapturedFrame = Awaited<ReturnType<Window['electronAPI']['automation']['captureAssetFrame']>>;
type SelectionRect = { x: number; y: number; width: number; height: number };

interface AutomationPanelProps {
  tabId: string | null;
  currentUrl: string;
  onOpenUrl: (url: string, newTab: boolean) => void;
}

export default function AutomationPanel({ tabId, currentUrl, onOpenUrl }: AutomationPanelProps): React.JSX.Element {
  const { LL } = useI18nContext();
  const api = window.electronAPI.automation;
  const [packages, setPackages] = useState<PackageSummary[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [status, setStatus] = useState<Status>({ enabled: false, state: 'idle' });
  const [busy, setBusy] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState('');
  const [threshold, setThreshold] = useState(0.88);
  const [assetMatch, setAssetMatch] = useState<AssetMatch>();
  const [assetTested, setAssetTested] = useState(false);
  const [capture, setCapture] = useState<CapturedFrame>();
  const [selection, setSelection] = useState<SelectionRect>();
  const [assetName, setAssetName] = useState('');
  const [history, setHistory] = useState<Awaited<ReturnType<typeof api.listRunHistory>>>([]);
  const captureRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ x: number; y: number }>();
  const isWebTarget = Boolean(tabId && /^https?:|^file:/i.test(currentUrl));
  const selected = packages.find((item) => item.packageId === selectedId);

  const refresh = useCallback(async () => {
    const [nextStatus, nextPackages] = await Promise.all([api.status(), api.listPackages()]);
    setStatus(nextStatus);
    setPackages(nextPackages);
    setSelectedId((current) => nextPackages.some((item) => item.packageId === current)
      ? current : nextPackages[0]?.packageId ?? '');
  }, [api]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { void api.listRunHistory(selectedId || undefined).then(setHistory); }, [api, selectedId, status.state]);
  useEffect(() => window.electronAPI.on('automation:status-changed', (payload) => setStatus(payload as Status)), []);
  useEffect(() => {
    setSelectedAsset((current) => selected?.assets.includes(current) ? current : selected?.assets[0] ?? '');
    setAssetMatch(undefined); setAssetTested(false);
  }, [selectedId, selected?.assets.join('\n')]);

  const importPackage = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await api.openPackage({
        title: LL.automation.ipc.openPackageTitle(),
        filterName: LL.automation.ipc.openPackageFilter(),
      });
      if (result.canceled) return;
      if (result.exists && !window.confirm(LL.automation.ipc.packageExistsMessage())) return;
      const installed = await api.installPackage(result.token, result.exists);
      setSelectedId(installed.packageId);
      await refresh();
    } finally { setBusy(false); }
  };

  const run = async (mode: 'check' | 'now' | 'countdown'): Promise<void> => {
    if (!selectedId || !tabId || !isWebTarget) return;
    setBusy(true);
    try {
      if (mode === 'check') await api.checkReady(selectedId, tabId);
      else await api.start(selectedId, tabId, mode === 'countdown' ? 3000 : 0);
    } catch (error) {
      setStatus((current) => ({ ...current, state: 'failed', message: { key: 'raw', params: { text: error instanceof Error ? error.message : String(error) } } }));
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const testAsset = async (): Promise<void> => {
    if (!selectedId || !selectedAsset || !tabId || !isWebTarget) return;
    setBusy(true); setAssetTested(false);
    try {
      const match = await api.testAsset(selectedId, tabId, selectedAsset, threshold, [1], 'auto');
      setAssetMatch(match); setAssetTested(true);
    } catch (error) {
      setAssetMatch(undefined); setAssetTested(true);
      setStatus((current) => ({ ...current, state: 'failed', message: { key: 'raw', params: { text: error instanceof Error ? error.message : String(error) } } }));
    } finally { setBusy(false); }
  };

  const startDebug = async (): Promise<void> => {
    if (!selectedId || !tabId || !isWebTarget) return;
    setBusy(true);
    try { await api.debugStart(selectedId, tabId); }
    catch (error) { setStatus((current) => ({ ...current, state: 'failed', message: { key: 'raw', params: { text: error instanceof Error ? error.message : String(error) } } })); }
    finally { setBusy(false); }
  };

  const continueDebug = async (): Promise<void> => {
    setBusy(true);
    try { await api.debugContinue(); }
    catch (error) { setStatus((current) => ({ ...current, state: 'failed', message: { key: 'raw', params: { text: error instanceof Error ? error.message : String(error) } } })); }
    finally { setBusy(false); }
  };

  const captureFrame = async (): Promise<void> => {
    if (!tabId || !selectedId || !isWebTarget) return;
    setBusy(true);
    try {
      const frame = await api.captureAssetFrame(tabId);
      setCapture(frame); setSelection(undefined); setAssetName(`captures/asset-${Date.now()}.png`);
    } catch (error) { setStatus((current) => ({ ...current, state: 'failed', message: { key: 'raw', params: { text: error instanceof Error ? error.message : String(error) } } })); }
    finally { setBusy(false); }
  };

  const selectionPoint = (event: React.PointerEvent<HTMLDivElement>): { x: number; y: number } | null => {
    if (!capture || !captureRef.current) return null;
    const rect = captureRef.current.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(capture.previewWidth, (event.clientX - rect.left) * capture.previewWidth / rect.width)),
      y: Math.max(0, Math.min(capture.previewHeight, (event.clientY - rect.top) * capture.previewHeight / rect.height)),
    };
  };

  const saveCapturedAsset = async (): Promise<void> => {
    if (!capture || !selection || !selectedId || !assetName.trim()) return;
    if (selected?.assets.includes(assetName.trim()) && !window.confirm(LL.automation.panel.replaceAssetConfirm({ asset: assetName.trim() }))) return;
    setBusy(true);
    try {
      const saved = await api.saveCapturedAsset(selectedId, capture.token, assetName.trim(), selection);
      await refresh(); setCapture(undefined); setSelection(undefined);
      setStatus((current) => ({ ...current, message: { key: 'raw', params: { text: LL.automation.panel.assetSaved({ asset: saved.asset, w: saved.width, h: saved.height }) } } }));
    } catch (error) { setStatus((current) => ({ ...current, state: 'failed', message: { key: 'raw', params: { text: error instanceof Error ? error.message : String(error) } } })); }
    finally { setBusy(false); }
  };

  const active = ['checking', 'ready', 'countdown', 'running'].includes(status.state);
  const executing = ['checking', 'countdown', 'running'].includes(status.state);

  return (
    <div className="automation-panel">
      <button type="button" className="automation-panel-manage" onClick={() => {
        void api.cancel().finally(() => onOpenUrl('about:automation', true));
      }}>
        <Workflow className="w-4 h-4" />{LL.automation.panel.openWorkbench()}
      </button>

      {!status.enabled && <div className="automation-panel-notice">{LL.automation.panel.notEnabled()}</div>}

      <div className="automation-panel-section">
        <div className="automation-panel-heading"><span>{LL.automation.panel.scripts()}</span><button type="button" onClick={() => void importPackage()} disabled={busy || !status.enabled}><Upload className="w-3.5 h-3.5" />{LL.automation.panel.import()}</button></div>
        {packages.length ? (
          <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)} disabled={active}>
            {packages.map((item) => <option value={item.packageId} key={item.packageId}>{item.name}</option>)}
          </select>
        ) : <div className="automation-panel-empty">{LL.automation.panel.emptyPackage()}</div>}
        {selected && <div className="automation-panel-meta">{LL.automation.panel.assetMeta({ count: selected.assets.length, id: selected.id })}</div>}
      </div>

      <div className={`automation-status-card is-${status.state}`}>
        <span className="automation-status-dot" />
        <div>
          <strong>{LL.automation.panel.status[status.state]()}</strong>
          <small>
            {status.currentStep
              ? LL.automation.panel.currentStep({ count: status.executedSteps ?? 0, step: resolveAutomationMessage(status.currentStep, LL) })
              : status.message
                ? resolveAutomationMessage(status.message, LL)
                : (isWebTarget ? LL.automation.panel.webTargetHint() : LL.automation.panel.switchTargetHint())}
          </small>
          {status.currentStep && status.message && <em>{resolveAutomationMessage(status.message, LL)}</em>}
        </div>
      </div>

      {selected && <button type="button" className="automation-capture-button" onClick={() => void captureFrame()} disabled={busy || active || !isWebTarget}><Camera className="w-3.5 h-3.5" />{LL.automation.panel.captureAsset()}</button>}

      {capture && <div className="automation-capture-editor">
        <div className="automation-panel-heading"><span>{LL.automation.panel.dragToSelect()}</span><button type="button" onClick={() => { setCapture(undefined); setSelection(undefined); }}><X className="w-3.5 h-3.5" /></button></div>
        <div
          ref={captureRef}
          className="automation-capture-canvas"
          onPointerDown={(event) => {
            const point = selectionPoint(event); if (!point) return;
            event.currentTarget.setPointerCapture(event.pointerId); dragStart.current = point; setSelection({ ...point, width: 0, height: 0 });
          }}
          onPointerMove={(event) => {
            if (!dragStart.current) return; const point = selectionPoint(event); if (!point) return;
            setSelection({ x: Math.min(dragStart.current.x, point.x), y: Math.min(dragStart.current.y, point.y), width: Math.abs(point.x - dragStart.current.x), height: Math.abs(point.y - dragStart.current.y) });
          }}
          onPointerUp={(event) => { event.currentTarget.releasePointerCapture(event.pointerId); dragStart.current = undefined; }}
        >
          <img src={capture.dataUrl} alt={LL.automation.panel.captureAlt()} draggable={false} />
          {selection && <span className="automation-capture-selection" style={{ left: `${selection.x / capture.previewWidth * 100}%`, top: `${selection.y / capture.previewHeight * 100}%`, width: `${selection.width / capture.previewWidth * 100}%`, height: `${selection.height / capture.previewHeight * 100}%` }} />}
        </div>
        <small>{capture.sourceWidth} × {capture.sourceHeight}{selection
          ? ` · ${LL.automation.panel.selectedRect({ w: Math.round(selection.width), h: Math.round(selection.height) })}`
          : ` · ${LL.automation.panel.dragHint()}`}</small>
        <input value={assetName} onChange={(event) => setAssetName(event.target.value)} placeholder={LL.automation.panel.assetNamePlaceholder()} />
        <button type="button" onClick={() => void saveCapturedAsset()} disabled={busy || !selection || selection.width < 2 || selection.height < 2 || !assetName.trim()}><Check className="w-3.5 h-3.5" />{LL.automation.panel.saveAsAsset()}</button>
      </div>}

      {selected?.assets.length ? <div className="automation-asset-test">
        <div className="automation-panel-heading"><span>{LL.automation.panel.assetTestTitle()}</span><strong>{Math.round(threshold * 100)}%</strong></div>
        <select value={selectedAsset} onChange={(event) => { setSelectedAsset(event.target.value); setAssetTested(false); }} disabled={busy || active}>
          {selected.assets.map((asset) => <option value={asset} key={asset}>{asset}</option>)}
        </select>
        <input type="range" min="0.5" max="1" step="0.01" value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} disabled={busy || active} aria-label={LL.automation.panel.thresholdAria()} />
        <button type="button" onClick={() => void testAsset()} disabled={busy || active || !isWebTarget}><ScanSearch className="w-3.5 h-3.5" />{LL.automation.panel.testOnPage()}</button>
        {assetTested && <div className={`automation-asset-test-result ${assetMatch ? 'matched' : 'missed'}`}>
          {assetMatch
            ? LL.automation.panel.matchResult({ score: (assetMatch.score * 100).toFixed(1), x: Math.round(assetMatch.x), y: Math.round(assetMatch.y), w: Math.round(assetMatch.width), h: Math.round(assetMatch.height), ms: assetMatch.matchMs === undefined ? '' : LL.automation.panel.matchResultMs({ ms: assetMatch.matchMs.toFixed(0) }) })
            : LL.automation.panel.matchFail()}
        </div>}
      </div> : null}

      <div className="automation-debug-controls">
        <button type="button" onClick={() => void startDebug()} disabled={busy || active || !selected || !isWebTarget}><Bug className="w-3.5 h-3.5" />{LL.automation.panel.debugStart()}</button>
        <button type="button" className={status.debugPaused ? 'primary' : ''} onClick={() => void continueDebug()} disabled={busy || !status.debugPaused}><StepForward className="w-3.5 h-3.5" />{LL.automation.panel.debugNext()}</button>
      </div>

      <details className="automation-run-log" open={status.state === 'failed'}>
        <summary><span>{LL.automation.panel.runLog()}</span><strong>{status.logs?.length ?? 0}</strong></summary>
        <div>
          {status.logs?.length ? [...status.logs].reverse().map((entry) => <div className={`level-${entry.level}`} key={entry.id}>
            <time>{new Date(entry.timestamp).toLocaleTimeString([], { hour12: false })}</time>
            <span>{entry.step ? `#${entry.step}` : '·'}</span>
            <p>{resolveAutomationMessage(entry.message, LL)}</p>
          </div>) : <p className="automation-run-log-empty">{LL.automation.panel.logEmpty()}</p>}
        </div>
      </details>

      <details className="automation-run-log automation-run-history">
        <summary><span>{LL.automation.panel.runHistory()}</span><strong>{history.length}</strong></summary>
        <div>
          {history.length ? [...history].reverse().slice(0, 10).map((record) => <div className={`level-${record.state === 'completed' ? 'success' : record.state === 'failed' ? 'error' : 'warning'}`} key={record.id}>
            <time>{new Date(record.finishedAt).toLocaleString([], { hour12: false })}</time><span>{record.mode === 'debug' ? LL.automation.panel.historyDebug() : LL.automation.panel.historyRun()}</span>
            <p>{LL.automation.panel.historyRecord({ state: LL.automation.panel.status[record.state](), steps: record.executedSteps, seconds: ((record.finishedAt - record.startedAt) / 1000).toFixed(1) })}</p>
          </div>) : <p className="automation-run-log-empty">{LL.automation.panel.historyEmpty()}</p>}
          {history.length > 0 && <button type="button" onClick={() => void api.clearRunHistory(selectedId).then(() => setHistory([]))}>{LL.automation.panel.clearHistory()}</button>}
        </div>
      </details>

      <div className="automation-panel-actions">
        <button type="button" onClick={() => void run('check')} disabled={busy || active || !selected || !isWebTarget}>{LL.automation.panel.checkReady()}</button>
        <button type="button" onClick={() => void run('countdown')} disabled={busy || executing || !selected || !isWebTarget}><Clock3 className="w-3.5 h-3.5" />{LL.automation.panel.countdownStart()}</button>
        <button type="button" className="primary" onClick={() => void run('now')} disabled={busy || executing || !selected || !isWebTarget}><Play className="w-3.5 h-3.5" />{LL.automation.panel.startNow()}</button>
        <button type="button" className="danger" onClick={() => void api.cancel()} disabled={!active}><Square className="w-3.5 h-3.5" />{LL.automation.panel.stop()}</button>
      </div>
    </div>
  );
}
