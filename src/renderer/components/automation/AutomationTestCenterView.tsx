import React from 'react';
import { ImagePlus, ScanSearch } from 'lucide-react';
import { useI18nContext } from '../../i18n/i18n-react';
import { AssetPreview } from './AutomationAssetPreview';
import { shortAsset, type AutomationDetail } from './automation-workbench-types';
import type { AutomationWorkbench } from './useAutomationWorkbench';

type Props = Pick<
  AutomationWorkbench,
  | 'detail'
  | 'selectedAsset'
  | 'setSelectedAsset'
  | 'assetChoices'
  | 'selectedImageGroup'
  | 'selectedPreviewAsset'
  | 'testKind'
  | 'setTestKind'
  | 'setTestResult'
  | 'threshold'
  | 'setThreshold'
  | 'testText'
  | 'setTestText'
  | 'testScene'
  | 'testResult'
  | 'busy'
  | 'runTest'
  | 'openTestScene'
> & { detail: AutomationDetail };

export function AutomationTestCenterView({
  detail,
  selectedAsset,
  setSelectedAsset,
  assetChoices,
  selectedImageGroup,
  selectedPreviewAsset,
  testKind,
  setTestKind,
  setTestResult,
  threshold,
  setThreshold,
  testText,
  setTestText,
  testScene,
  testResult,
  busy,
  runTest,
  openTestScene,
}: Props): React.JSX.Element {
  const { LL } = useI18nContext();
  const t = LL.automationWorkbench;
  return (
    <section className="awb-page">
      <div className="awb-page-head">
        <div>
          <h2>{t.testCenter()}</h2>
          <p>{t.importAScreenshotToTestImagesImage()}</p>
        </div>
        <div className="awb-segment">
          <button
            className={testKind === 'image' ? 'active' : ''}
            onClick={() => {
              setTestKind('image');
              setTestResult(undefined);
            }}
          >
            {t.imageMatching()}
          </button>
          <button
            className={testKind === 'ocr' ? 'active' : ''}
            onClick={() => {
              setTestKind('ocr');
              setTestResult(undefined);
            }}
          >
            {t.textRecognitionOcr()}
          </button>
        </div>
      </div>
      <div className="awb-test-layout">
        <aside className="awb-test-controls">
          {testKind === 'image' ? (
            <>
              <label>
                {t.selectImageOrImageGroup()}
                <select
                  value={selectedAsset}
                  onChange={(event) => {
                    setSelectedAsset(event.target.value);
                    setTestResult(undefined);
                  }}
                >
                  {assetChoices.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t.similarity()}{Math.round(threshold * 100)}%
                <input
                  type="range"
                  min="10"
                  max="100"
                  value={threshold * 100}
                  onChange={(event) => setThreshold(Number(event.target.value) / 100)}
                />
              </label>
              {selectedPreviewAsset && (
                <div className="awb-test-target-preview">
                  <div>
                    <AssetPreview
                      packageId={detail.packageId}
                      asset={selectedPreviewAsset}
                    />
                  </div>
                  <strong>
                    {selectedImageGroup
                      ? t.groupCount({ count: selectedImageGroup.length })
                      : t.currentMatchingAsset()}
                  </strong>
                  <span>
                    {selectedImageGroup
                      ? shortAsset(selectedImageGroup[0])
                      : shortAsset(selectedPreviewAsset)}
                  </span>
                </div>
              )}
            </>
          ) : (
            <>
              <label>
                {t.textToRecognize()}
                <input
                  value={testText}
                  onChange={(event) => setTestText(event.target.value)}
                />
              </label>
              <div className="awb-test-target-preview text">
                <ScanSearch />
                <strong>{t.ocrText()}</strong>
                <span>{testText || t.noTextEntered()}</span>
              </div>
            </>
          )}
          <button
            className="primary"
            onClick={() => void runTest()}
            disabled={busy || !testScene}
          >
            {t.startTest()}
          </button>
          {testResult && (
            <div className={testResult.matched ? 'result good' : 'result bad'}>
              <b>
                {testResult.matched
                  ? t.matchFound()
                  : testResult.candidate
                    ? testResult.rejectionReason === 'automatic-policy'
                      ? t.bestCandidateFailedAutomaticValidation()
                      : t.bestCandidateBelowThreshold()
                    : t.noCandidatesFound()}
              </b>
              {testResult.candidate && (
                <span>
                  {testResult.candidate.text
                    ? `“${testResult.candidate.text}” · `
                    : ''}
                  {t.position()}{Math.round(testResult.candidate.x)},
                  {Math.round(testResult.candidate.y)} ·{' '}
                  {Math.round((testResult.candidate.score ?? 0) * 100)}%
                </span>
              )}
            </div>
          )}
        </aside>
        <div className="awb-scene">
          {testScene ? (
            <>
              <svg
                className="awb-scene-frame"
                viewBox={`0 0 ${testScene.sourceWidth} ${testScene.sourceHeight}`}
                preserveAspectRatio="xMidYMid meet"
                role="img"
                aria-label={testScene.name}
              >
                <image
                  href={testScene.dataUrl}
                  x="0"
                  y="0"
                  width={testScene.sourceWidth}
                  height={testScene.sourceHeight}
                />
                {testResult?.candidate && (
                  <rect
                    className={testResult.matched ? 'matched' : 'candidate'}
                    x={testResult.candidate.x}
                    y={testResult.candidate.y}
                    width={testResult.candidate.width}
                    height={testResult.candidate.height}
                    vectorEffect="non-scaling-stroke"
                  />
                )}
              </svg>
              <span className="automation-test-scene-size">
                {t.original()}{testScene.sourceWidth} × {testScene.sourceHeight}{t.fit()}
              </span>
              <button
                className="automation-test-scene-replace"
                onClick={() => void openTestScene()}
                disabled={busy}
              >
                <ImagePlus />
                {t.changeTestScreenshot()}
              </button>
            </>
          ) : (
            <button
              className="automation-test-scene-empty"
              onClick={() => void openTestScene()}
              disabled={busy}
            >
              <ImagePlus />
              <strong>{t.importTestScreenshot()}</strong>
              <small>{t.selectAFullScreenshotForLocalOffline()}</small>
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
