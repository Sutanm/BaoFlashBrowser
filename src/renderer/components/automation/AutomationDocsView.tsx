import React from 'react';
import { useI18nContext } from '../../i18n/i18n-react';
import { englishDocSections } from './automation-docs-en';
import { docSections } from './automation-docs-data';

type Props = {
  docSection: number;
  setDocSection: (index: number) => void;
};

export function AutomationDocsView({ docSection, setDocSection }: Props): React.JSX.Element {
  const { locale } = useI18nContext();
  const sections = locale === 'en' ? englishDocSections : docSections;
  return (
    <section className="awb-docs">
      <aside>
        {sections.map((section, index) => (
          <button key={section.id} className={docSection === index ? 'active' : ''} onClick={() => setDocSection(index)}>{section.title}</button>
        ))}
      </aside>
      <article>
        {sections[docSection]?.content}
      </article>
    </section>
  );
}
