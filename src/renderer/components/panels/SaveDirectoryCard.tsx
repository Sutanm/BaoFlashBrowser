import React from 'react';

export default function SaveDirectoryCard({ title, path, buttonLabel, hint, onSelect }: {
  title: string;
  path: string;
  buttonLabel: string;
  hint: string;
  onSelect: () => void;
}) {
  return (
    <section className="panel-card settings-section-card" aria-label={title}>
      <div className="panel-card-title">{title}</div>
      <div className="field">
        <div title={path} style={{ fontSize: 12, color: 'var(--text-secondary)', overflowWrap: 'anywhere', userSelect: 'text', marginBottom: 8 }}>{path}</div>
        <button type="button" className="btn-secondary" onClick={onSelect}>{buttonLabel}</button>
        <div className="field-hint">{hint}</div>
      </div>
    </section>
  );
}
