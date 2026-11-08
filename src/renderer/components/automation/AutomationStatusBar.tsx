import React from 'react';
import { useI18nContext } from '../../i18n/i18n-react';
import type { AutomationWorkbench } from './useAutomationWorkbench';

type Props = Pick<AutomationWorkbench, 'notice' | 'detail' | 'dirty'>;

export function AutomationStatusBar({ notice, detail, dirty }: Props): React.JSX.Element {
  const { LL } = useI18nContext();
  const t = LL.automationWorkbench;
  return (
    <footer className="awb-status">
      <span className="ready">● {notice}</span>
      <span>
        {t.entryLabel()}
        {detail?.mainEntryId === 'workflow' ? t.blocklyWorkflow() : (detail?.mainEntryId ?? '-')}
      </span>
      <span>{t.assetCount()}{detail?.assets.length ?? 0}</span>
      <span>{dirty ? t.unsaved() : t.saved()}</span>
    </footer>
  );
}
