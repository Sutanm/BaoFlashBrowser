import { AUTOMATION_ASSISTANT_SCRIPT_ID, getUserscriptManager } from '../modules/userscripts';
import { registerAutomationAssistantBridge } from './automation-assistant-bridge';

function automationAssistantAllowed(wcId: number, scriptId: string): boolean {
  const manager = getUserscriptManager();
  const registration = manager?.getRegistration(wcId);
  const installed = manager?.getScriptMetadata(scriptId);
  return Boolean(
    scriptId === AUTOMATION_ASSISTANT_SCRIPT_ID
    && registration
    && installed?.enabled
    && installed.metadata.grant.includes('GM_baoAutomation'),
  );
}

export function registerAutomationUserscriptBridge(): void {
  registerAutomationAssistantBridge('userscript:automation-v3-', automationAssistantAllowed);
}
