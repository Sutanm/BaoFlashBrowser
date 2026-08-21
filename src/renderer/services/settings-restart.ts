export interface RestartSensitiveMainConfig {
  flashVersion: string;
  flashPluginChannel: 'stable' | 'experimental';
  lowEndMode: boolean;
  userscriptMaxValueKB: number;
}

export function requiresMainConfigRestart(
  previous: RestartSensitiveMainConfig,
  next: RestartSensitiveMainConfig,
): boolean {
  return previous.flashVersion !== next.flashVersion
    || previous.flashPluginChannel !== next.flashPluginChannel
    || previous.lowEndMode !== next.lowEndMode
    || previous.userscriptMaxValueKB !== next.userscriptMaxValueKB;
}
