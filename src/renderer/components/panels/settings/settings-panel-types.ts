import type { DownloadEngine } from '@shared/types/downloads';
import type { FlashPluginChannel } from '@shared/types/flash';
import { DEFAULT_PROXY, type ProxySettings } from '@shared/types/proxy';

export interface SettingsPanelProps {
  onOpenUrl: (url: string, newTab: boolean) => void;
}

export type SettingsSection =
  | 'general'
  | 'engine'
  | 'downloads'
  | 'privacy'
  | 'automation'
  | 'advanced'
  | 'network';

export interface MainConfigForm {
  proxy: ProxySettings;
  flashVersion: string;
  flashPluginChannel: FlashPluginChannel;
  lowEndMode: boolean;
  downloadEngine: DownloadEngine;
  screenshotDir: string;
  updateCheckMode: 'auto' | 'manual';
  userscriptMaxResponseMB: number;
  userscriptTimeoutSeconds: number;
  userscriptMaxConcurrentPerScript: number;
  userscriptMaxConcurrentGlobal: number;
  userscriptDownloadMaxMB: number;
  userscriptDownloadConcurrent: number;
  userscriptMaxValueKB: number;
  automationVisionWarmStart: boolean;
  automationOcrWarmStart: boolean;
}

export const DEFAULT_MAIN_CONFIG = {
  proxy: { ...DEFAULT_PROXY },
  flashVersion: '34.0.0.330',
  flashPluginChannel: 'stable',
  lowEndMode: false,
  screenshotDir: '',
  updateCheckMode: 'auto',
  ...(MODULE_DOWNLOAD ? { downloadEngine: 'aria2' as DownloadEngine } : {}),
  ...(MODULE_USERSCRIPTS ? {
    userscriptMaxResponseMB: 2,
    userscriptTimeoutSeconds: 15,
    userscriptMaxConcurrentPerScript: 4,
    userscriptMaxConcurrentGlobal: 16,
    userscriptDownloadMaxMB: 8,
    userscriptDownloadConcurrent: 4,
    userscriptMaxValueKB: 16,
  } : {}),
  ...(MODULE_AUTOMATION ? {
    automationVisionWarmStart: true,
    automationOcrWarmStart: true,
  } : {}),
} as MainConfigForm;
