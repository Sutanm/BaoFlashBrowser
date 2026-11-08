import React from 'react';
import { Workflow } from 'lucide-react';
import { useI18nContext } from '../../i18n/i18n-react';
import { useAutomationWorkbench } from './useAutomationWorkbench';
import { AutomationHeader } from './AutomationHeader';
import { AutomationSidebar } from './AutomationSidebar';
import { AutomationBlocksWorkspace } from './AutomationBlocksWorkspace';
import { AutomationAssetsView } from './AutomationAssetsView';
import { AutomationTestCenterView } from './AutomationTestCenterView';
import { AutomationScriptView } from './AutomationScriptView';
import { AutomationDocsView } from './AutomationDocsView';
import { AutomationStatusBar } from './AutomationStatusBar';
import { AutomationDialogModal } from './AutomationDialogModal';
import './automation.css';

export default function AutomationPage(): React.JSX.Element {
  const workbench = useAutomationWorkbench();
  const { LL } = useI18nContext();
  const t = LL.automationWorkbench;
  const { detail, mode } = workbench;
  return (
    <div className="automation-workbench-v3">
      <AutomationHeader {...workbench} />
      <div className="awb-body">
        <AutomationSidebar {...workbench} />
        <main className="awb-main">
          {detail && mode === 'blocks' && detail.workflow && (
            <AutomationBlocksWorkspace {...workbench} detail={detail} workflow={detail.workflow} />
          )}
          {detail && mode === 'assets' && (
            <AutomationAssetsView {...workbench} detail={detail} />
          )}
          {detail && mode === 'test' && (
            <AutomationTestCenterView {...workbench} detail={detail} />
          )}
          {detail && mode === 'script' && (
            <AutomationScriptView {...workbench} detail={detail} />
          )}
          {mode === 'docs' && (
            <AutomationDocsView
              docSection={workbench.docSection}
              setDocSection={workbench.setDocSection}
            />
          )}
          {!detail && (
            <div className="awb-empty full">
              <Workflow />
              <h2>{t.createOrImportAnAutomationPackage()}</h2>
              <button onClick={workbench.createPackageDraft}>{t.createAutomation()}</button>
            </div>
          )}
        </main>
      </div>
      <AutomationStatusBar {...workbench} />
      {workbench.dialog && <AutomationDialogModal {...workbench} />}
    </div>
  );
}
