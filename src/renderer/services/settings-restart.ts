export interface RestartSensitiveMainConfig {
  flashVersion: string;
  flashPluginChannel: 'stable' | 'experimental';
  lowEndMode: boolean;
  userscriptMaxValueKB?: number;
  automationVisionWarmStart?: boolean;
  automationOcrWarmStart?: boolean;
}

export function requiresMainConfigRestart(
  previous: RestartSensitiveMainConfig,
  next: RestartSensitiveMainConfig,
): boolean {
  return previous.flashVersion !== next.flashVersion
    || previous.flashPluginChannel !== next.flashPluginChannel
    || previous.lowEndMode !== next.lowEndMode
    || (MODULE_USERSCRIPTS && previous.userscriptMaxValueKB !== next.userscriptMaxValueKB)
    || (MODULE_AUTOMATION && previous.automationVisionWarmStart !== next.automationVisionWarmStart)
    || (MODULE_AUTOMATION && previous.automationOcrWarmStart !== next.automationOcrWarmStart);
}
