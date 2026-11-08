import React from 'react';
import { FolderPlus, Image, Trash2 } from 'lucide-react';
import { useI18nContext } from '../../i18n/i18n-react';
import { AssetPreview } from './AutomationAssetPreview';
import { shortAsset, type AutomationDetail } from './automation-workbench-types';
import type { AutomationWorkbench } from './useAutomationWorkbench';

type Props = Pick<
  AutomationWorkbench,
  | 'detail'
  | 'selectedAsset'
  | 'setSelectedAsset'
  | 'setMode'
  | 'importAssets'
  | 'importAssetFolder'
  | 'deleteAsset'
> & { detail: AutomationDetail };

export function AutomationAssetsView({
  detail,
  selectedAsset,
  setSelectedAsset,
  setMode,
  importAssets,
  importAssetFolder,
  deleteAsset,
}: Props): React.JSX.Element {
  const { LL } = useI18nContext();
  const t = LL.automationWorkbench;
  return (
    <section className="awb-page">
      <div className="awb-page-head">
        <div>
          <h2>{t.assets()}</h2>
          <p>{t.blocklyAndJsTsSharePackageAssets()}</p>
        </div>
        <div>
          <button onClick={() => void importAssets()}>
            <Image />
            {t.importImages()}
          </button>
          <button className="primary" onClick={() => void importAssetFolder()}>
            <FolderPlus />
            {t.importImageGroupFolder()}
          </button>
        </div>
      </div>
      <div className="awb-assets-layout">
        <div className="awb-asset-grid">
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
          {!detail.assets.length && (
            <div className="awb-empty">
              <Image />
              <b>{t.noAssets()}</b>
              <span>{t.importPngJpgWebpOrBmpImages()}</span>
            </div>
          )}
        </div>
        <aside className="awb-preview">
          <h3>{selectedAsset ? shortAsset(selectedAsset) : t.selectAnAsset()}</h3>
          {selectedAsset && (
            <>
              <div className="large-preview">
                <AssetPreview packageId={detail.packageId} asset={selectedAsset} />
              </div>
              <button onClick={() => setMode('test')}>{t.testInScene()}</button>
              <button className="danger" onClick={() => void deleteAsset()}>
                <Trash2 />
                {t.deleteAssetLabel()}
              </button>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}
