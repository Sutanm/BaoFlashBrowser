export interface RestartSensitiveMainConfig {
  flashVersion: string;
  lowEndMode: boolean;
  userscriptMaxValueKB: number;
}

export function requiresMainConfigRestart(
  previous: RestartSensitiveMainConfig,
  next: RestartSensitiveMainConfig,
): boolean {
  return previous.flashVersion !== next.flashVersion
    || previous.lowEndMode !== next.lowEndMode
    || previous.userscriptMaxValueKB !== next.userscriptMaxValueKB;
}
