import type { AutomationCapabilityRegion, AutomationCapturedFrame, AutomationImageMask, AutomationVisionMatcher, ImageMatch } from './capability-contracts';

export type VisionLocateRequest = {
  readonly assets: readonly string[];
  readonly threshold: number;
  readonly scales: readonly number[];
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
  constructor(private readonly matcher: AutomationVisionMatcher) {}

  async locate(
    frame: AutomationCapturedFrame,
    request: VisionLocateRequest,
    signal: AbortSignal,
  ): Promise<ImageMatch | null> {
    const options = {
      threshold: request.threshold,
      region: request.region,
      // Templates are authored in logical/CSS pixels. capturePage can return a
      // device-density bitmap, so retain the 1.x density correction before
      // passing template scales to OpenCV.
      scales: captureDensityAdjustedScales(frame, request.scales),
      mask: request.mask,
    };
    let best: ImageMatch | null = null;
    if (this.matcher.findMany) {
      best = await this.matcher.findMany([...request.assets], frame, options, signal);
    } else {
      for (const asset of request.assets) {
        if (signal.aborted) throw new Error('automation cancelled');
        const match = await this.matcher.find(asset, frame, options, signal);
        if (match && (!best || match.score > best.score)) best = { ...match, asset };
      }
    }
    return best ? { ...best, frameGeometry: frame.geometry } : null;
  }

  stats(): Partial<ImageMatch> {
    return this.matcher.getStats?.() ?? {};
  }
}
