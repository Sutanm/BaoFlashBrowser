import { DEFAULT_IMAGE_MATCH_THRESHOLD } from '../shared/automation/vision-policy';

export function createAutomationAssistantApi(invoke: (operation: string, payload: Record<string, unknown>) => Promise<unknown>, scriptId: string) {
  let automationPackages: Array<{ packageId: string; name: string; mainEntryId: string; assets: string[]; profiles: string[]; frontends: Array<{ id: string; kind: 'blockly' | 'javascript'; name: string }> }> = [];
  let automationPackageId = '';
  let automationCandidates: Array<{ id: string; [key: string]: unknown }> = [];
  let automationBoundSurface: { id: string; [key: string]: unknown } | null = null;
  const baoAutomation = {
    listPackages: async (): Promise<Array<{ packageId: string; name: string; mainEntryId: string; assets: string[]; profiles: string[]; frontends: Array<{ id: string; kind: 'blockly' | 'javascript'; name: string }> }>> => {
      const result = await invoke('list', { scriptId: scriptId });
      automationPackages = Array.isArray(result) ? result as typeof automationPackages : [];
      if (!automationPackages.some((item) => item.packageId === automationPackageId)) automationPackageId = automationPackages[0]?.packageId ?? '';
      return automationPackages;
    },
    status: async (): Promise<unknown> => invoke('status', { scriptId: scriptId }),
    /** 一次性提示：走主进程 → 渲染层，显示在地址栏提示条里，不覆盖网页画面。 */
    toast: (message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info'): Promise<unknown> => invoke('toast', { scriptId: scriptId, message: String(message).slice(0, 500), type }),
    start: async (packageId: string, _countdownMs = 0): Promise<unknown> => {
      automationPackageId = packageId;
      if (!automationPackages.length) await baoAutomation.listPackages();
      const selected = automationPackages.find((item) => item.packageId === packageId);
      const frontendId = selected?.mainEntryId;
      if (!frontendId) throw new Error('当前包没有可运行的 Frontend');
      return invoke('start', { scriptId: scriptId, packageId, frontendId });
    },
    cancel: (): Promise<unknown> => invoke('cancel', { scriptId: scriptId }),
    assetPreview: (packageId: string, asset: string): Promise<unknown> => invoke('asset-preview', { scriptId: scriptId, packageId, asset }),
    captureFrame: (region?: { x: number; y: number; width: number; height: number; viewportWidth?: number; viewportHeight?: number }, referenceKind?: 'viewport' | 'region' | 'surface'): Promise<unknown> => {
      if (!automationPackageId) throw new Error('请先选择自动化包');
      return invoke('capture', { scriptId: scriptId, packageId: automationPackageId, region, referenceKind });
    },
    saveCapture: (packageId: string, token: string, assetName: string, rect: { x: number; y: number; width: number; height: number }, overwrite = false): Promise<unknown> => invoke('save-capture', { scriptId: scriptId, packageId, token, assetName, rect, overwrite }),
    match: (packageId: string, asset: string, options: { threshold?: number; scales?: number[]; mask?: 'auto' | 'none' | 'alpha'; region?: { x: number; y: number; width: number; height: number; viewportWidth?: number; viewportHeight?: number } } = {}): Promise<unknown> => {
      automationPackageId = packageId;
      return invoke('match', { scriptId: scriptId, packageId, asset, threshold: options.threshold ?? DEFAULT_IMAGE_MATCH_THRESHOLD, scales: options.scales, mask: options.mask, region: options.region });
    },
    ocrTest: (text: string, options: { match?: 'contains' | 'exact'; minScore?: number; region?: { x: number; y: number; width: number; height: number; viewportWidth?: number; viewportHeight?: number } } = {}): Promise<unknown> => {
      if (!automationPackageId) throw new Error('请先选择自动化包');
      return invoke('ocr', { scriptId: scriptId, packageId: automationPackageId, text, match: options.match ?? 'contains', minConfidence: options.minScore ?? .5, region: options.region });
    },
    detectGameSurfaces: async (): Promise<unknown> => {
      const result = await invoke('surfaces', { scriptId: scriptId });
      automationCandidates = Array.isArray(result) ? result as typeof automationCandidates : [];
      if (automationBoundSurface) {
        const fingerprint = automationBoundSurface.fingerprint;
        automationBoundSurface = automationCandidates.find((item) =>
          (fingerprint && item.fingerprint === fingerprint) || item.id === automationBoundSurface?.id,
        ) ?? null;
      }
      return { candidates: automationCandidates, bound: automationBoundSurface };
    },
    bindGameSurface: async (candidateId: string): Promise<unknown> => {
      automationBoundSurface = automationCandidates.find((item) => item.id === candidateId) ?? null;
      if (!automationBoundSurface) throw new Error('游戏画面候选已经失效');
      return { bound: automationBoundSurface };
    },
    clearGameSurface: async (): Promise<unknown> => { automationBoundSurface = null; return { cleared: true }; },
    beginCoordinatePick: async (): Promise<unknown> => ({ ready: true, viewport: { width: 1280, height: 720 } }),
    endCoordinatePick: async (): Promise<unknown> => ({ released: true }),
    warmup: async (packageId: string, asset?: string): Promise<unknown> => {
      automationPackageId = packageId;
      const tasks: Promise<unknown>[] = [invoke('warm', { scriptId: scriptId, packageId })];
      if (asset) tasks.push(baoAutomation.assetPreview(packageId, asset));
      await Promise.all(tasks);
      return { warm: true };
    },
    warmAuthoring: async (): Promise<unknown> => {
      if (!automationPackageId) await baoAutomation.listPackages();
      if (!automationPackageId) return { warm: false };
      return invoke('warm', { scriptId: scriptId, packageId: automationPackageId });
    },
    listAutomationLogs: (filter?: { packageId?: string; packageName?: string }): Promise<Array<{ name: string; sizeLabel: string; scriptName: string; startedAt: number; packageId?: string }>> => invoke('logs-list', {
      scriptId: scriptId,
      packageId: filter?.packageId,
      packageName: filter?.packageName,
    }) as Promise<Array<{ name: string; sizeLabel: string; scriptName: string; startedAt: number; packageId?: string }>>,
    readAutomationLogs: (name: string): Promise<unknown> => invoke('logs-read', { scriptId: scriptId, name }),
    openAutomationLog: (name: string): Promise<unknown> => invoke('logs-open', { scriptId: scriptId, name }),
  };

  return baoAutomation;
}
