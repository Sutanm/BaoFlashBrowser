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
  const bgColor = isRuffle ? '#6246ea' : '#c62828';

  return (
    <button
      onClick={onToggle}
      className="no-drag"
      title={
        isRuffle
          ? `${LL.ruffle.switchToFlash()} (${ruffleSource === 'cdn' ? 'CDN' : LL.settings.bundled()})`
          : LL.ruffle.switchToRuffle()
      }
      style={{
        display: 'flex', alignItems: 'center', gap: 5,
        height: 26, padding: '0 10px', borderRadius: 13,
        border: 'none', cursor: 'pointer',
        background: bgColor, color: '#fff',
        fontSize: 11, fontWeight: 600,
        letterSpacing: '0.5px',
        transition: 'background 0.25s',
        flexShrink: 0,
      }}
    >
      <span style={{
        display: 'inline-block', width: 10, height: 10, borderRadius: '50%',
        background: '#fff', opacity: 0.35,
        transition: 'margin-left 0.25s',
        marginLeft: isRuffle ? 0 : 0,
        order: isRuffle ? 1 : 0,
      }} />
      <span>{isRuffle ? 'Ruffle' : 'Flash'}</span>
      {isRuffle && ruffleSource === 'cdn' && (
        <span style={{ fontSize: 8, opacity: 0.7, fontWeight: 400 }}>CDN</span>
      )}
    </button>
  );
};

export default RuffleToggle;
