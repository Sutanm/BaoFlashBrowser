import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Check, Download, ExternalLink, Play, RefreshCw, ScanSearch, Square, Workflow, X } from 'lucide-react';
import { DEFAULT_IMAGE_MATCH_MASK, DEFAULT_IMAGE_MATCH_THRESHOLD, imageMatchScales } from '@shared/automation/vision-policy';
import '../automation/automation.css';
import { useI18nContext } from '../../i18n/i18n-react';
import { useDataStore } from '../../store/useDataStore';

interface AutomationPanelProps {
  tabId: string | null;
  currentUrl: string;
  onOpenUrl: (url: string, newTab: boolean) => void;
}

type SelectionRect = { x: number; y: number; width: number; height: number };

export default function AutomationPanel({ tabId, currentUrl, onOpenUrl }: AutomationPanelProps): React.JSX.Element {
  const { LL } = useI18nContext();
  const t = LL.automationPanel;
  const api = window.electronAPI.automationV3;
  const [packages, setPackages] = useState<Awaited<ReturnType<typeof api.listPackages>>>([]);
  const [packageId, setPackageId] = useState('');
  const [frontendId, setFrontendId] = useState('');
  const [profilePath, setProfilePath] = useState('');
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.status>>>({ state: 'idle', executedSteps: 0, logs: [] });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Automation 2.0');
  const [selectedAsset, setSelectedAsset] = useState('');
  const [threshold, setThreshold] = useState(DEFAULT_IMAGE_MATCH_THRESHOLD);
  const [capture, setCapture] = useState<Awaited<ReturnType<typeof api.captureAssetFrame>>>();
  const [selection, setSelection] = useState<SelectionRect>();
  const [assetName, setAssetName] = useState('');
  const [ocrText, setOcrText] = useState('');
  const captureRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ x: number; y: number }>();
  const selected = packages.find((entry) => entry.packageId === packageId);
  const runActive = ['preparing', 'running', 'cancelling'].includes(status.state);
  const canRun = Boolean(tabId && /^(https?|file):/iu.test(currentUrl) && selected && frontendId && !runActive);

  const refresh = useCallback(async () => {
    const [nextPackages, nextStatus] = await Promise.all([api.listPackages(), api.status()]);
    setPackages(nextPackages); setStatus(nextStatus);
    setPackageId((current) => nextPackages.some((entry) => entry.packageId === current) ? current : nextPackages[0]?.packageId ?? '');
  }, [api]);

  useEffect(() => { void refresh(); const timer = window.setInterval(() => void api.status().then(setStatus), 1000); return () => window.clearInterval(timer); }, [refresh, api]);
  // 与工作台共享同一份数据视图：主进程在包/脚本/素材变更后广播，收到即重新查询
  // （与用户脚本侧边栏的 userscripts.onChanged 同构）。
  useEffect(() => {
    const off = api.onChanged(() => void refresh());
    return off;
  }, [refresh, api]);
  useEffect(() => { setFrontendId((current) => selected?.frontends.some((entry) => entry.id === current) ? current : selected?.mainEntryId ?? selected?.frontends[0]?.id ?? ''); }, [selected?.packageId, selected?.mainEntryId]);
  useEffect(() => { setSelectedAsset((current) => selected?.assets.includes(current) ? current : selected?.assets[0] ?? ''); }, [selected?.packageId, selected?.assets.join('\n')]);

  const run = async (): Promise<void> => {
    if (!canRun || !tabId) return; setBusy(true);
    try { const result = await api.start(packageId, frontendId, tabId, profilePath || undefined); setMessage(t.runStarted({ id: result.runId })); await refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const cancel = async (): Promise<void> => { setBusy(true); try { await api.cancel(); await refresh(); setMessage(t.cancelled()); } finally { setBusy(false); } };

  const importPackage = async (): Promise<void> => {
    setBusy(true);
    try {
      const opened = await api.openPackage({ title: t.importTitle(), filterName: 'Bao Automation' }); if (opened.canceled) return;
      const approvals: Record<string, string[]> = {};
      for (const script of opened.scripts) {
        if (script.permissions.length && window.confirm(t.permission({ name: script.name, permissions: script.permissions.join('\n') }))) approvals[script.id] = [...script.permissions];
      }
      await api.installPackage(opened.token, opened.exists, approvals); await refresh(); setMessage(t.imported({ name: opened.name }));
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const captureFrame = async (): Promise<void> => {
    if (!tabId || !packageId) return; setBusy(true);
    try { setCapture(await api.captureAssetFrame(packageId, tabId)); setSelection(undefined); setAssetName(`capture-${Date.now()}`); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const selectionPoint = (event: React.PointerEvent<HTMLDivElement>): { x: number; y: number } | null => {
    if (!captureRef.current || !capture) return null; const bounds = captureRef.current.getBoundingClientRect();
    return { x: Math.max(0, Math.min(capture.previewWidth, (event.clientX - bounds.left) / bounds.width * capture.previewWidth)), y: Math.max(0, Math.min(capture.previewHeight, (event.clientY - bounds.top) / bounds.height * capture.previewHeight)) };
  };

  const saveCapture = async (): Promise<void> => {
    if (!capture || !selection || !assetName.trim()) return; setBusy(true);
    try { await api.saveCapturedAsset(packageId, capture.token, assetName, selection); setCapture(undefined); setSelection(undefined); await refresh(); setMessage(t.saved({ name: assetName })); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const testAsset = async (): Promise<void> => {
    if (!tabId || !selectedAsset) return; setBusy(true);
    try { const result = await api.testAsset(packageId, tabId, selectedAsset, threshold, imageMatchScales(), DEFAULT_IMAGE_MATCH_MASK); setMessage(result ? t.imageMatch({ score: (result.score * 100).toFixed(1), x: Math.round(result.bounds.x), y: Math.round(result.bounds.y) }) : t.noImage()); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const testText = async (): Promise<void> => {
    if (!tabId || !ocrText.trim()) return; setBusy(true);
    try { const result = await api.testText(packageId, tabId, ocrText.trim(), 'contains', .5); setMessage(result ? t.textMatch({ score: (result.score * 100).toFixed(1), x: Math.round(result.bounds.x), y: Math.round(result.bounds.y) }) : t.noText({ text: ocrText.trim() })); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  return <div className="automation-panel">
    <button type="button" className="automation-panel-manage" title={t.assistantHint()} disabled={!tabId || !/^(https?|file):/iu.test(currentUrl)} onClick={() => {
      if (!tabId) return;
      void api.showAssistant(tabId).then(() => useDataStore.getState().setActivePanel(null)).catch((error: unknown) => setMessage(error instanceof Error ? error.message : String(error)));
    }}><ExternalLink className="w-4 h-4" />{t.assistant()}</button>
    <button type="button" className="automation-panel-manage" onClick={() => onOpenUrl('about:automation', true)}>
      <Workflow className="w-4 h-4" />{t.workbench()}
    </button>

    <div className="automation-panel-section">
      <div className="automation-panel-heading"><span>{t.scripts()}</span><button type="button" onClick={() => void importPackage()} disabled={busy}><Download className="w-3.5 h-3.5" />{t.import()}</button></div>
      {packages.length ? <select value={packageId} onChange={(event) => setPackageId(event.target.value)} disabled={runActive}>
        {packages.map((entry) => <option key={entry.packageId} value={entry.packageId}>{entry.name}</option>)}
      </select> : <div className="automation-panel-notice"><Download className="w-4 h-4" />{t.empty()}</div>}
      {selected && <select value={frontendId} onChange={(event) => setFrontendId(event.target.value)} disabled={runActive}>
        {selected.frontends.map((entry) => <option key={entry.id} value={entry.id}>{entry.kind === 'blockly' ? 'Blockly' : 'JavaScript'} · {entry.name}</option>)}
      </select>}
      {selected?.profiles.length ? <select value={profilePath} onChange={(event) => setProfilePath(event.target.value)} disabled={runActive}>
        <option value="">{t.defaultProfile()}</option>{selected.profiles.map((profile) => <option key={profile} value={profile}>{profile}</option>)}
      </select> : null}
    </div>

    {selected && <div className="automation-panel-section automation-asset-test">
      <div className="automation-panel-heading"><span>{t.recognition()}</span><button type="button" onClick={() => void refresh()} disabled={busy}><RefreshCw className="w-3.5 h-3.5" />{t.refresh()}</button></div>
      <button type="button" className="automation-capture-button" onClick={() => void captureFrame()} disabled={busy || runActive || !canRun}><Camera className="w-3.5 h-3.5" />{t.capture()}</button>
      {selected.assets.length ? <><select value={selectedAsset} onChange={(event) => setSelectedAsset(event.target.value)}>{selected.assets.map((asset) => <option key={asset} value={asset}>{asset}</option>)}</select><input type="range" min=".5" max="1" step=".01" value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} /><button type="button" onClick={() => void testAsset()} disabled={busy || !canRun}><ScanSearch className="w-3.5 h-3.5" />{t.testImage()} · {Math.round(threshold * 100)}%</button></> : null}
      <input value={ocrText} onChange={(event) => setOcrText(event.target.value)} placeholder={t.textPlaceholder()} /><button type="button" onClick={() => void testText()} disabled={busy || !canRun || !ocrText.trim()}><ScanSearch className="w-3.5 h-3.5" />{t.testText()}</button>
    </div>}

    {capture && <div className="automation-capture-editor"><div className="automation-panel-heading"><span>{t.selectRegion()}</span><button type="button" aria-label={t.close()} title={t.close()} onClick={() => setCapture(undefined)}><X className="w-3.5 h-3.5" /></button></div><div ref={captureRef} className="automation-capture-canvas" onPointerDown={(event) => { const value = selectionPoint(event); if (!value) return; dragStart.current = value; event.currentTarget.setPointerCapture(event.pointerId); setSelection({ ...value, width: 0, height: 0 }); }} onPointerMove={(event) => { if (!dragStart.current) return; const value = selectionPoint(event); if (!value) return; setSelection({ x: Math.min(dragStart.current.x, value.x), y: Math.min(dragStart.current.y, value.y), width: Math.abs(value.x - dragStart.current.x), height: Math.abs(value.y - dragStart.current.y) }); }} onPointerUp={(event) => { event.currentTarget.releasePointerCapture(event.pointerId); dragStart.current = undefined; }}><img src={capture.dataUrl} alt={t.selectRegion()} draggable={false} />{selection && <span className="automation-capture-selection" style={{ left: `${selection.x / capture.previewWidth * 100}%`, top: `${selection.y / capture.previewHeight * 100}%`, width: `${selection.width / capture.previewWidth * 100}%`, height: `${selection.height / capture.previewHeight * 100}%` }} />}</div><input value={assetName} onChange={(event) => setAssetName(event.target.value)} placeholder={t.assetName()} /><button onClick={() => void saveCapture()} disabled={busy || !selection || selection.width < 2 || selection.height < 2 || !assetName.trim()}><Check className="w-3.5 h-3.5" />{t.saveAsset()}</button></div>}

    <div className="automation-panel-section">
      <div className={`automation-status-card is-${status.state}`}><span className="automation-status-dot" /><div><strong>{runActive ? (status.state === 'cancelling' ? t.stopping() : t.running()) : status.state === 'failed' ? t.failed() : status.state === 'completed' ? t.completed() : t.ready()}</strong><small>{runActive ? (status.currentStep ?? `${status.packageId} / ${status.frontendId}`) : (status.message ?? message)}</small></div></div>
      <div className="automation-panel-actions">
        <button className="primary" onClick={() => void run()} disabled={busy || !canRun}><Play />{t.run()}</button>
        <button className="danger" onClick={() => void cancel()} disabled={busy || !runActive}><Square />{t.stop()}</button>
      </div>
      {!tabId || !/^(https?|file):/iu.test(currentUrl) ? <div className="automation-panel-notice">{t.pageRequired()}</div> : null}
    </div>
  </div>;
}
