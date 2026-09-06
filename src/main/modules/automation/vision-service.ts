import type { AutomationCapabilityRegion, AutomationCapturedFrame, AutomationImageMask, AutomationVisionMatcher, ImageMatch } from './capability-contracts';
import { DEFAULT_IMAGE_MATCH_MASK, imageMatchScales } from '../../../shared/automation/vision-policy';
import { visionSchedulerFor } from './vision-scheduler';

export type VisionLocateRequest = {
  readonly assets: readonly string[];
  readonly method?: 'template' | 'color' | 'auto';
  readonly threshold: number;
  readonly scales?: readonly number[];
  readonly mask?: AutomationImageMask;
  readonly region?: AutomationCapabilityRegion;
};

// Authoring tools need the strongest usable candidate even when it does not
// satisfy the user's execution threshold, so the UI can draw its yellow
// diagnostic box. Runtime locator calls continue to pass their real threshold.
export const AUTHORING_BEST_CANDIDATE_THRESHOLD = -1;

export function captureDensityAdjustedScales(
  frame: AutomationCapturedFrame,
  scales: readonly number[],
): number[] {
  const widthDensity = frame.cssSize.width > 0 ? frame.deviceSize.width / frame.cssSize.width : 1;
  const heightDensity = frame.cssSize.height > 0 ? frame.deviceSize.height / frame.cssSize.height : 1;
  const density = Math.sqrt(widthDensity * heightDensity);
  return scales.map((scale) => scale * (Number.isFinite(density) && density > 0 ? density : 1));
}

/** Browser-independent image recognition orchestration. */
export class AutomationVisionService {
  private lastStats: Partial<ImageMatch> = {};

  constructor(
    private readonly matcher: AutomationVisionMatcher,
    private readonly colorMatcher?: AutomationVisionMatcher,
    private readonly automaticMatcher?: AutomationVisionMatcher,
  ) {}

  async locate(
    frame: AutomationCapturedFrame,
    request: VisionLocateRequest,
    signal: AbortSignal,
  ): Promise<ImageMatch | null> {
    return (await this.locateCandidates(frame, request, signal, 1))[0] ?? null;
  }

  async locateCandidates(
    frame: AutomationCapturedFrame,
    request: VisionLocateRequest,
    signal: AbortSignal,
    maxCandidates = 100,
  ): Promise<readonly ImageMatch[]> {
    if (request.method !== undefined && request.method !== 'template' && request.method !== 'color' && request.method !== 'auto') {
      throw new Error(`unsupported image recognition method: ${String(request.method)}`);
    }
    if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 100) {
      throw new Error(`vision candidate budget is invalid: ${maxCandidates}`);
    }
    const options = {
      threshold: request.threshold,
      region: request.region,
      // Templates are authored in logical/CSS pixels. capturePage can return a
      // device-density bitmap, so retain the 1.x density correction before
      // passing template scales to OpenCV.
      scales: captureDensityAdjustedScales(frame, imageMatchScales(request.scales)),
      mask: request.mask ?? DEFAULT_IMAGE_MATCH_MASK,
      maxCandidates,
    };
    const selectedMatcher = request.method === 'color'
      ? this.colorMatcher
      : request.method === 'auto' ? this.automaticMatcher : this.matcher;
    if (!selectedMatcher) throw new Error(`${request.method === 'auto' ? 'automatic' : 'color'} image recognition is unavailable`);
    const scheduler = visionSchedulerFor(selectedMatcher);
    const scheduled = await scheduler.schedule(signal, async () => {
      const matches: ImageMatch[] = [];
      if (selectedMatcher.findManyCandidates) {
        matches.push(...await selectedMatcher.findManyCandidates([...request.assets], frame, options, signal));
      } else if (selectedMatcher.findMany) {
        const match = await selectedMatcher.findMany([...request.assets], frame, options, signal);
        if (match) matches.push(match);
      } else {
        for (const asset of request.assets) {
          if (signal.aborted) throw new Error('automation cancelled');
          if (selectedMatcher.findCandidates) {
            matches.push(...(await selectedMatcher.findCandidates(asset, frame, options, signal)).map((match) => ({ ...match, asset: match.asset ?? asset })));
          } else {
            const match = await selectedMatcher.find(asset, frame, options, signal);
            if (match) matches.push({ ...match, asset: match.asset ?? asset });
          }
        }
      }
      return matches;
    });
    this.lastStats = {
      ...selectedMatcher.getStats?.(),
      queueWaitMs: scheduled.queueWaitMs,
      queueDepthAtSubmit: scheduled.queueDepthAtSubmit,
    };
    return scheduled.value
      .filter((match) => Number.isFinite(match.score))
      .sort((left, right) => right.score - left.score)
      .slice(0, maxCandidates)
      .sort((left, right) => left.y - right.y || left.x - right.x || right.score - left.score)
      .map((match) => ({
        ...match,
        frameGeometry: frame.geometry,
        queueWaitMs: scheduled.queueWaitMs,
        queueDepthAtSubmit: scheduled.queueDepthAtSubmit,
      }));
  }

  stats(): Partial<ImageMatch> {
    return { ...this.lastStats };
  }

}
