import React, { useEffect, useRef, useState } from 'react';
import { ImagePlus, Maximize2, Minimize2, ScanSearch, ZoomIn, ZoomOut } from 'lucide-react';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import type { AutomationImageMask } from '@shared/automation/types';

type Scene = { token: string; name: string; dataUrl: string; previewWidth: number; previewHeight: number; sourceWidth: number; sourceHeight: number };
type Result = Awaited<ReturnType<Window['electronAPI']['automation']['testAssetOnScene']>>;

function scaleRange(minimum: number, maximum: number, step: number): number[] {
  const min = Math.max(.25, Math.min(4, minimum));
  const max = Math.max(min, Math.min(4, maximum));
  const increment = Math.max(.01, step);
  const values: number[] = [];
  for (let value = min; value <= max + 1e-6 && values.length < 16; value += increment) values.push(Number(value.toFixed(3)));
  if (values.length < 16 && values[values.length - 1] !== max) values.push(max);
  return values;
}

function AssetThumb({ packageId, asset, selected, onSelect }: { packageId: string; asset: string; selected: boolean; onSelect(): void }): React.JSX.Element {
  const [src, setSrc] = useState('');
  const [visible, setVisible] = useState(false);
  const hostRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const host = hostRef.current; if (!host) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: '160px' });
    observer.observe(host); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let live = true;
    void window.electronAPI.automation.getAssetPreview(packageId, asset).then((preview) => { if (live) setSrc(preview.dataUrl); }).catch(() => {});
    return () => { live = false; };
  }, [packageId, asset, visible]);
  return <button ref={hostRef} type="button" className={selected ? 'selected' : ''} onClick={onSelect} title={asset}>
    {src ? <img src={src} alt="" /> : <span />}
    <small>{asset}</small>
  </button>;
}

export default function AutomationAssetTestBench({ packageId, assets, onAssetsChanged }: { packageId: string; assets: string[]; onAssetsChanged(assets: string[]): void }): React.JSX.Element {
  const api = window.electronAPI.automation;
  const { LL } = useI18nContext();
  const t = LL.automation.testBench;
  const [scene, setScene] = useState<Scene>();
  const [asset, setAsset] = useState(assets[0] ?? '');
  const [threshold, setThreshold] = useState(.9);
  const [multiScale, setMultiScale] = useState(true);
  const [scaleMin, setScaleMin] = useState(.75);
  const [scaleMax, setScaleMax] = useState(1.25);
  const [scaleStep, setScaleStep] = useState(.25);
  const [maskMode, setMaskMode] = useState<AutomationImageMask>('auto');
  const [result, setResult] = useState<Result>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const sceneHostRef = useRef<HTMLDivElement>(null);
  const [sceneDisplay, setSceneDisplay] = useState<{ width: number; height: number }>();
  const [sceneZoom, setSceneZoom] = useState(1);
  const [focusScene, setFocusScene] = useState(false);

  useEffect(() => { if (!assets.includes(asset)) setAsset(assets[0] ?? ''); }, [assets, asset]);
  useEffect(() => { void api.warmupVision(packageId).catch(() => {}); }, [api, packageId]);
  useEffect(() => {
    const host = sceneHostRef.current;
    if (!host || !scene) { setSceneDisplay(undefined); return; }
    const update = (): void => {
      const availableWidth = Math.max(1, host.clientWidth);
      const availableHeight = Math.max(1, host.clientHeight);
      const scale = Math.min(availableWidth / scene.sourceWidth, availableHeight / scene.sourceHeight) * sceneZoom;
      setSceneDisplay({ width: Math.max(1, Math.floor(scene.sourceWidth * scale)), height: Math.max(1, Math.floor(scene.sourceHeight * scale)) });
    };
    update();
    const observer = new ResizeObserver(update); observer.observe(host);
    return () => observer.disconnect();
  }, [scene, sceneZoom, focusScene]);

  const openScene = async (): Promise<void> => {
    setBusy(true);
    try {
      const [opened] = await Promise.all([
        api.openTestScene({ title: t.openSceneTitle(), filterName: t.imageFilter() }),
        api.warmupVision(packageId).catch(() => ({ ready: false })),
      ]);
      if (!opened.canceled && opened.token && opened.dataUrl && opened.name && opened.previewWidth && opened.previewHeight && opened.sourceWidth && opened.sourceHeight) {
        setScene(opened as Scene); setSceneZoom(1); setResult(undefined); setMessage('');
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const importAssets = async (): Promise<void> => {
    setBusy(true);
    try {
      const imported = await api.importAssetFiles(packageId, { title: t.importAssetsTitle(), filterName: t.imageFilter() });
      if (!imported.canceled && imported.assets) { onAssetsChanged(imported.assets); setMessage(t.imported({ count: imported.assets.length })); }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const compare = async (nextAsset = asset): Promise<void> => {
    if (!scene || !nextAsset) return;
    setBusy(true); setMessage('');
    try {
      setResult(await api.testAssetOnScene(packageId, scene.token, nextAsset, threshold, multiScale ? scaleRange(scaleMin, scaleMax, scaleStep) : [1], maskMode));
    } catch (error) { setResult(undefined); setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const candidate = result?.candidate;
  return <div className={`automation-test-bench${focusScene ? ' focus-scene' : ''}`}>
    <div className="automation-test-bench-toolbar">
      <div><strong>{t.title()}</strong><small>{t.subtitle()}</small></div>
      <label>{t.threshold({ value: Math.round(threshold * 100) })}<input type="range" min="10" max="100" value={Math.round(threshold * 100)} onChange={(event) => setThreshold(Number(event.target.value) / 100)} /></label>
      <label className="check"><input type="checkbox" checked={multiScale} onChange={(event) => setMultiScale(event.target.checked)} />{t.multiScale()}</label>
      {multiScale && <div className="automation-scale-range">
        <label>{t.scaleMin()}<input type="number" min="0.25" max="4" step="0.05" value={scaleMin} onChange={(event) => setScaleMin(Number(event.target.value))} /></label>
        <label>{t.scaleMax()}<input type="number" min="0.25" max="4" step="0.05" value={scaleMax} onChange={(event) => setScaleMax(Number(event.target.value))} /></label>
        <label>{t.scaleStep()}<input type="number" min="0.01" max="1" step="0.01" value={scaleStep} onChange={(event) => setScaleStep(Number(event.target.value))} /></label>
      </div>}
      <label className="automation-mask-mode">{t.maskMode()}<select value={maskMode} onChange={(event) => setMaskMode(event.target.value as AutomationImageMask)}>
        <option value="auto">{t.maskAuto()}</option>
        <option value="alpha">{t.alphaMask()}</option>
        <option value="none">{t.maskFull()}</option>
      </select></label>
      <button type="button" className="primary" disabled={busy || !scene || !asset} onClick={() => void compare()}><ScanSearch />{busy ? t.comparing() : t.compare()}</button>
    </div>
    <div ref={sceneHostRef} className="automation-test-scene">
      {scene ? <div className="automation-test-scene-scroll"><div className="automation-test-scene-image" style={sceneDisplay}>
          <img src={scene.dataUrl} alt={scene.name} />
          {candidate && <div className={`automation-match-highlight ${result?.matched ? 'matched' : 'candidate'}`} style={{ left: `${candidate.x / scene.sourceWidth * 100}%`, top: `${candidate.y / scene.sourceHeight * 100}%`, width: `${candidate.width / scene.sourceWidth * 100}%`, height: `${candidate.height / scene.sourceHeight * 100}%` }}><span>{(candidate.score * 100).toFixed(1)}%</span></div>}
        </div></div> : <button type="button" className="automation-test-scene-empty" onClick={() => void openScene()} disabled={busy}><ImagePlus /><strong>{t.importScene()}</strong><small>{t.importSceneHint()}</small></button>}
      {scene && <button type="button" className="automation-test-scene-replace" onClick={() => void openScene()} disabled={busy}><ImagePlus />{t.replaceScene()}</button>}
      {scene && <div className="automation-test-scene-zoom">
        <button type="button" onClick={() => setSceneZoom((value) => Math.max(.5, value - .25))} title={t.zoomOut()}><ZoomOut /></button>
        <button type="button" onClick={() => setSceneZoom(1)} title={t.fitScene()}>{Math.round(sceneZoom * 100)}%</button>
        <button type="button" onClick={() => setSceneZoom((value) => Math.min(4, value + .25))} title={t.zoomIn()}><ZoomIn /></button>
        <button type="button" onClick={() => setFocusScene((value) => !value)} title={focusScene ? t.exitFocus() : t.focusScene()}>{focusScene ? <Minimize2 /> : <Maximize2 />}</button>
      </div>}
    </div>
    <div className={`automation-test-result ${result ? result.matched ? 'matched' : 'candidate' : ''}`}>
      {candidate ? <><strong>{result?.matched ? t.matched() : t.belowThreshold()}</strong><span>{t.metrics({ score: (candidate.score * 100).toFixed(1), x: candidate.x, y: candidate.y, width: candidate.width, height: candidate.height, scale: (candidate.scale ?? 1).toFixed(2), ms: candidate.matchMs ?? 0 })}</span>{candidate.lowVariance && <em>{t.lowVariance({ value: (candidate.templateStdDev ?? 0).toFixed(1) })}</em>}</> : <span>{result ? t.noCandidate() : message || t.waiting()}</span>}
    </div>
    <div className="automation-test-assets">
      <div><strong>{t.assetStrip()}</strong><small>{t.assetStripHint()}</small><button type="button" onClick={() => void importAssets()} disabled={busy}><ImagePlus />{t.importAssets()}</button></div>
      <div className="automation-test-assets-strip">
        {assets.map((item) => <AssetThumb key={item} packageId={packageId} asset={item} selected={asset === item} onSelect={() => { setAsset(item); setResult(undefined); if (scene) void compare(item); }} />)}
        {assets.length === 0 && <p>{t.noAssets()}</p>}
      </div>
    </div>
  </div>;
}
