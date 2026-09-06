import type { ImageMatch } from './capability-contracts';

// Normal path: preserve the thresholds used by the dynamic-hook regression.
export const MINIMUM_COLOR_STRUCTURE_SCORE = .30;
export const MINIMUM_COLOR_STRUCTURE_MARGIN = .05;
export const COLOR_RAW_SCORE_THRESHOLD_RATIO = .45;

// Small transparent sprites lose silhouette/edge evidence when Chromium
// resamples them over a changing game background. Allow a narrowly-scoped
// recovery path only when absolute colour evidence is materially stronger.
// This keeps low-colour hook/tree impostors out without weakening the normal
// path used by moving targets.
export const RESAMPLED_STRUCTURE_SCORE = .25;
export const RESAMPLED_STRUCTURE_MARGIN = .04;
export const RESAMPLED_RAW_SCORE_THRESHOLD_RATIO = .60;

export type StructuredColorDecision = {
  readonly accepted: boolean;
  /** A threshold-compatible score suitable for authoring UI. */
  readonly decisionScore: number;
  readonly reason?: 'structure' | 'ambiguous' | 'color-evidence' | 'threshold';
};

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

/**
 * Applies the production colour + structure policy and derives a score with
 * the same semantics as the user threshold. This prevents a margin-calibrated
 * 100% diagnostic candidate from being described as "below 90%" when the
 * hidden raw-colour evidence gate was what actually rejected it.
 */
export function evaluateStructuredColorMatch(
  match: Pick<ImageMatch, 'score' | 'colorRawScore' | 'structureScore' | 'structureMargin'>,
  threshold: number,
): StructuredColorDecision {
  const required = clampUnit(threshold);
  const structureScore = clampUnit(match.structureScore ?? 0);
  const structureMargin = clampUnit(match.structureMargin ?? 0);
  const rawScore = clampUnit(match.colorRawScore ?? 0);
  const calibratedScore = clampUnit(match.score);

  const standardStructure = structureScore >= MINIMUM_COLOR_STRUCTURE_SCORE
    && structureMargin >= MINIMUM_COLOR_STRUCTURE_MARGIN;
  const resampledRawEvidenceScore = clampUnit(rawScore / RESAMPLED_RAW_SCORE_THRESHOLD_RATIO);
  const resampledStructure = structureScore >= RESAMPLED_STRUCTURE_SCORE
    && structureMargin >= RESAMPLED_STRUCTURE_MARGIN;
  const resampledRecovery = resampledStructure && resampledRawEvidenceScore >= required;

  if (!standardStructure && !resampledRecovery) {
    if (structureScore < RESAMPLED_STRUCTURE_SCORE) {
      return { accepted: false, decisionScore: structureScore, reason: 'structure' };
    }
    if (structureMargin < RESAMPLED_STRUCTURE_MARGIN) {
      return { accepted: false, decisionScore: structureScore, reason: 'ambiguous' };
    }
    if (resampledStructure && resampledRawEvidenceScore < required) {
      return {
        accepted: false,
        decisionScore: Math.min(calibratedScore, resampledRawEvidenceScore),
        reason: 'color-evidence',
      };
    }
    return { accepted: false, decisionScore: structureScore, reason: 'ambiguous' };
  }

  // raw >= threshold * ratio is equivalent to raw / ratio >= threshold.
  // Expressing it as a score makes the slider and displayed percentage agree.
  const rawEvidenceScore = clampUnit(rawScore / COLOR_RAW_SCORE_THRESHOLD_RATIO);
  const decisionScore = Math.min(calibratedScore, rawEvidenceScore);
  if (rawEvidenceScore < required) {
    return { accepted: false, decisionScore, reason: 'color-evidence' };
  }
  if (calibratedScore < required) {
    return { accepted: false, decisionScore, reason: 'threshold' };
  }
  return { accepted: true, decisionScore };
}
