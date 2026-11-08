import React, { lazy, Suspense } from 'react';
import { ChevronLeft, ChevronRight, FolderPlus } from 'lucide-react';
import { useI18nContext } from '../../i18n/i18n-react';
import { AssetPreview } from './AutomationAssetPreview';
import { shortAsset, type AutomationDetail } from './automation-workbench-types';
import type { AutomationWorkbench } from './useAutomationWorkbench';

const AutomationBlocklyV2Editor = lazy(() => import('./AutomationBlocklyV2Editor'));

type Props = Pick<
  AutomationWorkbench,
  | 'detail'
  | 'scripts'
  | 'editor'
  | 'contextOpen'
  | 'setContextOpen'
  | 'selectedAsset'
  | 'setSelectedAsset'
  | 'importAssets'
  | 'setDirty'
> & {
  detail: AutomationDetail;
  workflow: NonNullable<AutomationDetail['workflow']>;
};

export function AutomationBlocksWorkspace({
  detail,
  workflow,
  scripts,
  editor,
  contextOpen,
  setContextOpen,
  selectedAsset,
  setSelectedAsset,
  importAssets,
  setDirty,
}: Props): React.JSX.Element {
  const { LL } = useI18nContext();
  const t = LL.automationWorkbench;
  return (
    <div className={`awb-blocks ${contextOpen ? '' : 'context-closed'}`}>
      <Suspense fallback={<div role="status">{t.loadingEditor()}</div>}>
        <AutomationBlocklyV2Editor
          ref={editor}
          key={`${detail.packageId}:${scripts.map((entry) => entry.id).join(',')}`}
          packageId={detail.packageId}
          workflowId={workflow.id}
          workflowName={workflow.name}
          initialDocument={workflow}
          assets={detail.assets.map(shortAsset)}
          scripts={scripts.map((entry) => entry.id)}
          onDirtyChange={setDirty}
        />
      </Suspense>
      <aside className="awb-context">
        <button className="collapse" onClick={() => setContextOpen((value) => !value)}>
          {contextOpen ? <ChevronRight /> : <ChevronLeft />}
        </button>
        {contextOpen && (
          <>
            <div className="context-head">
              <strong>{t.assetTray()}</strong>
              <button onClick={() => void importAssets()}>
                <FolderPlus />
                {t.import()}
              </button>
              <small>{t.clickAnAssetToUseItIn()}</small>
            </div>
            <div className="awb-asset-grid compact">
              {detail.assets.map((asset) => (
                <button
                  key={asset}
                  className={selectedAsset === asset ? 'selected' : ''}
                  onClick={() => setSelectedAsset(asset)}
                >
                  <AssetPreview packageId={detail.packageId} asset={asset} />
                  <b>{shortAsset(asset)}</b>
                </button>
              ))}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
