import React from 'react';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import type { FlashEngineMode } from '@shared/types/settings';

interface RuffleToggleProps {
  engineMode: FlashEngineMode;
  ruffleSource: 'bundled' | 'cdn';
  onToggle: () => void;
}

const RuffleToggle: React.FC<RuffleToggleProps> = ({ engineMode, ruffleSource, onToggle }) => {
  const { LL } = useI18nContext();
  const isRuffle = engineMode === 'prefer-ruffle';

  return (
    <button
      onClick={onToggle}
      className={`engine-toggle no-drag ${isRuffle ? 'ruffle' : 'flash'}`}
      role="switch"
      aria-checked={isRuffle}
      title={
        isRuffle
          ? `${LL.ruffle.switchToFlash()} (${ruffleSource === 'cdn' ? 'CDN' : LL.settings.bundled()})`
          : LL.ruffle.switchToRuffle()
      }
    >
      <span className="engine-toggle-dot" />
      <span className="engine-toggle-label">{isRuffle ? 'Ruffle' : 'Flash'}</span>
    </button>
  );
};

export default RuffleToggle;
