import React from 'react';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import type { DownloadEngine } from '@shared/types/downloads';
import SaveDirectoryCard from '../SaveDirectoryCard';
import type { SettingsPanelState } from './useSettingsPanel';

type Props = Pick<
  SettingsPanelState,
  | 'mainForm'
  | 'handleMainChange'
  | 'downloadDir'
  | 'screenshotDir'
  | 'handleSelectDownloadDir'
  | 'handleSelectScreenshotDir'
>;

export function SettingsDownloadsSection({
  mainForm,
  handleMainChange,
  downloadDir,
  screenshotDir,
  handleSelectDownloadDir,
  handleSelectScreenshotDir,
}: Props): React.JSX.Element {
  const { LL } = useI18nContext();
  return (
    <>
      {MODULE_DOWNLOAD && (
        <div className="panel-card settings-section-card">
          <div className="panel-card-title">{LL.settings.download()}</div>
          <div className="field">
            <div className="field-label">{LL.settings.downloadEngine()}</div>
            <select
              className="input-text" style={{ width: '100%' }}
              value={mainForm.downloadEngine}
              onChange={(e) => handleMainChange('downloadEngine', e.target.value as DownloadEngine)}
            >
              <option value="aria2">{LL.settings.aria2()}</option>
              <option value="chromium">{LL.settings.chromium()}</option>
            </select>
          </div>
        </div>
      )}
      {MODULE_DOWNLOAD && (
        <SaveDirectoryCard
          title={LL.settings.downloadDirectory()}
          path={downloadDir || LL.loading()}
          buttonLabel={LL.settings.screenshot.selectDir()}
          hint={LL.settings.directoryImmediate()}
          onSelect={() => void handleSelectDownloadDir()}
        />
      )}
      <SaveDirectoryCard
        title={LL.settings.screenshot.dir()}
        path={screenshotDir || mainForm.screenshotDir || LL.loading()}
        buttonLabel={LL.settings.screenshot.selectDir()}
        hint={LL.settings.directoryImmediate()}
        onSelect={() => void handleSelectScreenshotDir()}
      />
    </>
  );
}
