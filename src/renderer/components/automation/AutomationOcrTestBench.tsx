import React, { useEffect, useRef, useState } from 'react';
import { FileText, Maximize2, Minimize2, ScanSearch, ZoomIn, ZoomOut } from 'lucide-react';
import { useI18nContext } from '@renderer/i18n/i18n-react';

type Scene = { token: string; name: string; dataUrl: string; previewWidth: number; previewHeight: number; sourceWidth: number; sourceHeight: number };
type Result = Awaited<ReturnType<Window['electronAPI']['automation']['testTextOnScene']>>;

export default function AutomationOcrTestBench(): React.JSX.Element {
  const api = window.electronAPI.automation;
  const { LL } = useI18nContext();
  const t = LL.automation.ocrTestBench;
  const [scene, setScene] = useState<Scene>();
  const [text, setText] = useState('');
  const [match, setMatch] = useState<'contains' | 'exact'>('contains');
  const [minScore, setMinScore] = useState(.5);
  const [result, setResult] = useState<Result>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const sceneHostRef = useRef<HTMLDivElement>(null);
  const [sceneDisplay, setSceneDisplay] = useState<{ width: number; height: number }>();
  const [sceneZoom, setSceneZoom] = useState(1);
  const [focusScene, setFocusScene] = useState(false);

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
      const opened = await api.openTestScene({ title: t.openSceneTitle(), filterName: t.imageFilter() });
      if (!opened.canceled && opened.token && opened.dataUrl && opened.name && opened.previewWidth && opened.previewHeight && opened.sourceWidth && opened.sourceHeight) {
        setScene(opened as Scene); setSceneZoom(1); setResult(undefined); setMessage('');
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const recognize = async (): Promise<void> => {
    const trimmed = text.trim();
    if (!scene || !trimmed) return;
    setBusy(true); setMessage('');
    try {
      setResult(await api.testTextOnScene(scene.token, trimmed, match, minScore));
    } catch (error) { setResult(undefined); setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const matched = (result?.candidates ?? []).filter((candidate) => candidate.matched);
  const displayed = (result?.candidates ?? []).filter((candidate) => candidate.matched);
  const candidateCount = matched.length;
  return <div className={`automation-test-bench${focusScene ? ' focus-scene' : ''}`}>
    <div className="automation-test-bench-toolbar">
      <div><strong>{t.title()}</strong><small>{t.subtitle()}</small></div>
      <label className="automation-ocr-text-label">{t.text()}<input type="text" maxLength={200} value={text} placeholder={t.textPlaceholder()} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void recognize(); } }} /></label>
      <label className="automation-ocr-match-label">{t.matchMode()}<select value={match} onChange={(event) => setMatch(event.target.value as 'contains' | 'exact')}>
        <option value="contains">{t.matchContains()}</option>
        <option value="exact">{t.matchExact()}</option>
      </select></label>
      <label className="automation-ocr-score-label">{t.minScore()}<input type="number" min="0" max="1" step="0.01" value={minScore} onChange={(event) => setMinScore(Math.max(0, Math.min(1, Number(event.target.value) || 0)))} /></label>
      <button type="button" className="primary" disabled={busy || !scene || !text.trim()} onClick={() => void recognize()}><ScanSearch />{busy ? t.recognizing() : t.recognize()}</button>
    </div>
    <div ref={sceneHostRef} className="automation-test-scene">
      {scene ? <div className="automation-test-scene-scroll"><div className="automation-test-scene-image" style={sceneDisplay}>
          <img src={scene.dataUrl} alt={scene.name} />
          {displayed.map((candidate) => <div key={`${candidate.x}:${candidate.y}:${candidate.text}`} className={`automation-match-highlight ${candidate.matched ? 'matched' : 'candidate'}`} style={{ left: `${candidate.x / scene.sourceWidth * 100}%`, top: `${candidate.y / scene.sourceHeight * 100}%`, width: `${candidate.width / scene.sourceWidth * 100}%`, height: `${candidate.height / scene.sourceHeight * 100}%` }}><span>{(candidate.score * 100).toFixed(1)}%</span></div>)}
        </div></div> : <button type="button" className="automation-test-scene-empty" onClick={() => void openScene()} disabled={busy}><FileText /><strong>{t.importScene()}</strong><small>{t.importSceneHint()}</small></button>}
      {scene && <button type="button" className="automation-test-scene-replace" onClick={() => void openScene()} disabled={busy}><FileText />{t.replaceScene()}</button>}
      {scene && <div className="automation-test-scene-zoom">
        <button type="button" onClick={() => setSceneZoom((value) => Math.max(.5, value - .25))} title={t.zoomOut()}><ZoomOut /></button>
        <button type="button" onClick={() => setSceneZoom(1)} title={t.fitScene()}>{Math.round(sceneZoom * 100)}%</button>
        <button type="button" onClick={() => setSceneZoom((value) => Math.min(4, value + .25))} title={t.zoomIn()}><ZoomIn /></button>
        <button type="button" onClick={() => setFocusScene((value) => !value)} title={focusScene ? t.exitFocus() : t.focusScene()}>{focusScene ? <Minimize2 /> : <Maximize2 />}</button>
      </div>}
    </div>
    <div className={`automation-test-result ${result ? result.matched ? 'matched' : 'candidate' : ''}`}>
      {result && result.matched ? <><strong>{t.hits({ count: candidateCount })}</strong><span>{t.timing({ text: (result.candidates ?? []).filter((candidate) => candidate.matched).map((candidate) => candidate.text).join(' · ') || '', ms: result.ocrMs ?? 0 })}</span></>
        : <span>{result ? (result.candidates?.length ? t.noHit({ text: text.trim() }) : t.noText()) : message || t.waiting()}</span>}
    </div>
  </div>;
}
