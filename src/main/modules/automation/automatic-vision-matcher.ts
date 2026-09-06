import type {
  AutomationCapabilityRegion,
  AutomationCapturedFrame,
  AutomationImageMask,
  AutomationVisionMatcher,
  ImageMatch,
} from './capability-contracts';
import type { ColorPointWorkerMatcher } from './color-vision-worker-matcher';
import { visionSchedulerFor } from './vision-scheduler';

type MatchOptions = {
  readonly threshold: number;
  readonly region?: AutomationCapabilityRegion;
  readonly scales?: number[];
  readonly mask?: AutomationImageMask;
  readonly maxCandidates?: number;
};

/**
 * Safety-first internal router. Assets with a usable colour signature are
 * accepted only by the colour matcher's uniqueness gate. OpenCV is used only
 * for assets that cannot form a colour signature: falling back after a colour
 * miss would turn OpenCV's high-scoring false positives into real actions.
 */
export class AutomaticVisionMatcher implements AutomationVisionMatcher {
  private lastStats: Partial<ImageMatch> = {};

  constructor(
    private readonly templateMatcher: AutomationVisionMatcher,
    private readonly colorMatcher: ColorPointWorkerMatcher,
  ) {}

  async find(asset: string, frame: AutomationCapturedFrame, options: MatchOptions, signal: AbortSignal) {
    return (await this.findCandidates(asset, frame, options, signal))[0] ?? null;
  }

  async findCandidates(asset: string, frame: AutomationCapturedFrame, options: MatchOptions, signal: AbortSignal) {
    return this.findManyCandidates([asset], frame, options, signal);
  }

  async findMany(assets: string[], frame: AutomationCapturedFrame, options: MatchOptions, signal: AbortSignal) {
    return (await this.findManyCandidates(assets, frame, options, signal))[0] ?? null;
  }

  async findManyCandidates(
    assets: string[],
    frame: AutomationCapturedFrame,
    options: MatchOptions,
    signal: AbortSignal,
  ): Promise<readonly ImageMatch[]> {
    const uniqueAssets = [...new Set(assets)];
    if (uniqueAssets.length === 0) throw new Error('at least one automation image asset is required');
    const colorScheduled = await visionSchedulerFor(this.colorMatcher).schedule(signal, () => (
      this.colorMatcher.findManyCandidatesWithSupport(uniqueAssets, frame, options, signal)
    ));
    const colorResult = colorScheduled.value;
    const maximum = options.maxCandidates ?? 1;
    let templateMatches: readonly ImageMatch[] = [];
    let templateQueueWaitMs = 0;
    if (colorResult.unsupportedAssets.length > 0 && colorResult.matches.length < maximum) {
      const templateScheduled = await visionSchedulerFor(this.templateMatcher).schedule(signal, () => (
        this.findTemplateCandidates(
          [...colorResult.unsupportedAssets],
          frame,
          { ...options, maxCandidates: maximum - colorResult.matches.length },
          signal,
        )
      ));
      templateMatches = templateScheduled.value;
      templateQueueWaitMs = templateScheduled.queueWaitMs;
    }
    this.lastStats = {
      ...this.colorMatcher.getStats?.(),
      ...(templateMatches.length > 0 ? this.templateMatcher.getStats?.() : {}),
      queueWaitMs: colorScheduled.queueWaitMs + templateQueueWaitMs,
      queueDepthAtSubmit: Math.max(colorScheduled.queueDepthAtSubmit, 0),
    };
    return this.limitVisually([...colorResult.matches, ...templateMatches], maximum);
  }

  getStats(): Partial<ImageMatch> { return { ...this.lastStats }; }

  private async findTemplateCandidates(assets: string[], frame: AutomationCapturedFrame, options: MatchOptions, signal: AbortSignal) {
    if (this.templateMatcher.findManyCandidates) {
      return this.templateMatcher.findManyCandidates(assets, frame, options, signal);
    }
    const matches: ImageMatch[] = [];
    for (const asset of assets) {
      if (this.templateMatcher.findCandidates) {
        matches.push(...await this.templateMatcher.findCandidates(asset, frame, options, signal));
      } else {
        const match = await this.templateMatcher.find(asset, frame, options, signal);
        if (match) matches.push({ ...match, asset: match.asset ?? asset });
      }
    }
    return matches;
  }

  private limitVisually(matches: ImageMatch[], maximum: number): ImageMatch[] {
    return matches
      .filter((match) => Number.isFinite(match.score))
      .sort((left, right) => right.score - left.score)
      .slice(0, maximum)
      .sort((left, right) => left.y - right.y || left.x - right.x || right.score - left.score);
  }

}
