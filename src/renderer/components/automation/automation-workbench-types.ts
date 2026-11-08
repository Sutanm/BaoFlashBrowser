import type { JavaScriptAutomationCapability } from '@shared/automation/javascript-api';

export type AutomationSummary = Awaited<
  ReturnType<Window['electronAPI']['automationV3']['listPackages']>
>[number];
export type AutomationDetail = Awaited<
  ReturnType<Window['electronAPI']['automationV3']['getPackage']>
>;
export type AutomationMode = 'blocks' | 'assets' | 'test' | 'script' | 'docs';
export type ScriptLanguage = 'javascript' | 'typescript';
export type AutomationDialog = {
  kind: 'package' | 'script' | 'main';
  id: string;
  name: string;
  language: ScriptLanguage;
};

export const AUTOMATION_CAPABILITIES: readonly JavaScriptAutomationCapability[] = [
  'input',
  'vision',
  'ocr',
  'page.read',
  'page.navigate',
  'notify',
  'log',
];

export function shortAsset(asset: string): string {
  return asset.replace(/^assets\//u, '');
}
