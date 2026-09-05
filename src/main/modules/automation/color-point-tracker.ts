import {
  matchColorPointSignature,
  type BgraImage,
  type ColorPointMatch,
  type ColorPointMatchOptions,
  type ColorPointSignature,
} from './color-point-matcher';

export type ColorPointAcceptance = {
  readonly minimumScore?: number;
  readonly minimumMargin?: number;
};

export type ColorPointTrackerOptions = ColorPointMatchOptions & ColorPointAcceptance & {
  /** Search area used before the first match and during reacquisition. */
  readonly initialRegion?: ColorPointMatchOptions['region'];
  /** Extra pixels around the previous match for the next frame. */
  readonly trackingPadding?: number;
  /** Number of local misses before retrying the initial region. */
  readonly reacquireAfterMisses?: number;
};

export type ColorPointTrackingResult = {
  readonly accepted: boolean;
  readonly best?: ColorPointMatch;
  readonly margin: number;
  readonly searchedRegion?: ColorPointMatchOptions['region'];
  readonly tracking: boolean;
  readonly reacquired: boolean;
  readonly consecutiveMisses: number;
};

export type ColorPointConfidence = {
  readonly rawScore: number;
  readonly margin: number;
  readonly confidence: number;
};

function clampUnit(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

/**
 * Converts matcher-internal color quality into a locator confidence. A target
 * that is clearly separated from every independent spatial candidate remains
 * trustworthy after browser interpolation lowers exact RGB quality; a common
 * color patch with a near-equal runner-up does not receive that boost.
 */
export function calibrateColorPointConfidence(
  matches: readonly ColorPointMatch[],
  candidateFloor = .2,
): ColorPointConfidence {
  const rawScore = matches[0]?.score ?? 0;
  // A missing runner-up only proves it was below the candidate collection
  // floor; treating it as zero would overstate uniqueness for weak matches.
  const runnerUp = matches[1]?.score ?? Math.min(rawScore, Math.max(0, candidateFloor));
  const margin = matches[0] ? Math.max(0, rawScore - runnerUp) : 0;
  return { rawScore, margin, confidence: Math.min(1, Math.max(0, rawScore + margin * 2)) };
}

export function evaluateColorPointMatches(
  matches: readonly ColorPointMatch[],
  acceptance: ColorPointAcceptance = {},
): { readonly accepted: boolean; readonly best?: ColorPointMatch; readonly margin: number } {
  const best = matches[0];
  const { margin } = calibrateColorPointConfidence(matches);
  const minimumScore = clampUnit(acceptance.minimumScore ?? .55, .55);
  const minimumMargin = clampUnit(acceptance.minimumMargin ?? .08, .08);
  return { accepted: Boolean(best && best.score >= minimumScore && margin >= minimumMargin), best, margin };
}

function trackingRegion(match: ColorPointMatch, padding: number): NonNullable<ColorPointMatchOptions['region']> {
  return {
    x: match.x - padding,
    y: match.y - padding,
    width: match.width + padding * 2,
    height: match.height + padding * 2,
  };
}

/**
 * Stateful matcher for animation frames. It starts inside a caller supplied ROI,
 * follows an accepted object in a much smaller ROI, and only performs a wider
 * reacquisition after a bounded number of misses.
 */
export class ColorPointTracker {
  private previous?: ColorPointMatch;
  private misses = 0;

  constructor(
    private readonly signature: ColorPointSignature,
    private readonly options: ColorPointTrackerOptions = {},
  ) {}

  reset(): void {
    this.previous = undefined;
    this.misses = 0;
  }

  get lastMatch(): ColorPointMatch | undefined {
    return this.previous;
  }

  match(frame: BgraImage): ColorPointTrackingResult {
    const padding = positiveInteger(this.options.trackingPadding ?? 18, 18);
    const reacquireAfter = positiveInteger(this.options.reacquireAfterMisses ?? 2, 2);
    const shouldReacquire = Boolean(this.previous && this.misses >= reacquireAfter);
    const localRegion = this.previous ? trackingRegion(this.previous, padding) : undefined;
    const region = shouldReacquire ? this.options.initialRegion : (localRegion ?? this.options.initialRegion);
    const tracking = Boolean(localRegion && !shouldReacquire);
    const matches = matchColorPointSignature(frame, this.signature, {
      ...this.options,
      region,
      maxCandidates: Math.max(2, this.options.maxCandidates ?? 3),
    });
    const evaluated = evaluateColorPointMatches(matches, this.options);
    if (evaluated.accepted && evaluated.best) {
      this.previous = evaluated.best;
      this.misses = 0;
    } else {
      this.misses += 1;
    }
    return {
      ...evaluated,
      searchedRegion: region,
      tracking,
      reacquired: shouldReacquire && evaluated.accepted,
      consecutiveMisses: this.misses,
    };
  }
}
