export interface RestartSensitiveMainConfig {
  flashVersion: string;
  flashPluginChannel: 'stable' | 'experimental';
  lowEndMode: boolean;
  userscriptMaxValueKB: number;
  automationVisionWarmStart: boolean;
  automationOcrWarmStart: boolean;
}

export function requiresMainConfigRestart(
  previous: RestartSensitiveMainConfig,
  next: RestartSensitiveMainConfig,
): boolean {
  return previous.flashVersion !== next.flashVersion
    || previous.flashPluginChannel !== next.flashPluginChannel
    || previous.lowEndMode !== next.lowEndMode
    || previous.userscriptMaxValueKB !== next.userscriptMaxValueKB
    || previous.automationVisionWarmStart !== next.automationVisionWarmStart
    || previous.automationOcrWarmStart !== next.automationOcrWarmStart;
}
