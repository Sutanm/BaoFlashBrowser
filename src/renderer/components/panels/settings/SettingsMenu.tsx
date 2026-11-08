import React from 'react';
import { ChevronRight } from 'lucide-react';
import type { SettingsSection } from './settings-panel-types';

export type SettingsSectionEntry = {
  id: SettingsSection;
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
};

type Props = {
  categoryLabel: string;
  sections: readonly SettingsSectionEntry[];
  onSelect: (id: SettingsSection) => void;
};

export function SettingsMenu({ categoryLabel, sections, onSelect }: Props): React.JSX.Element {
  return (
    <div className="settings-panel settings-menu-panel">
      <div className="settings-category-label">{categoryLabel}</div>
      <div className="settings-category-list">
        {sections.map(({ id, title, description, icon: Icon }) => (
          <button key={id} type="button" className="settings-category-row" onClick={() => onSelect(id)}>
            <span className="settings-category-icon"><Icon className="w-4 h-4" /></span>
            <span className="settings-category-copy"><strong>{title}</strong><small>{description}</small></span>
            <ChevronRight className="w-4 h-4" />
          </button>
        ))}
      </div>
    </div>
  );
}
