export const DEFAULT_IMAGE_MATCH_THRESHOLD = 0.9;
export const DEFAULT_IMAGE_MATCH_SCALES = Object.freeze([0.75, 1, 1.25] as const);
// External screenshots are commonly captured in Windows physical pixels while
// BrowserView frames are normalized to logical pixels. These inverse DPI
// factors are a miss-only fallback, not part of the normal fast pass.
export const DEFAULT_IMAGE_MATCH_DPI_FALLBACK_SCALES = Object.freeze([
  0.5, 1 / 1.75, 1 / 1.5, 0.8,
] as const);
export const DEFAULT_IMAGE_MATCH_MASK = 'auto' as const;

/** Returns a mutable request copy while keeping the product defaults immutable. */
export function imageMatchScales(scales?: readonly number[]): number[] {
  return [...(scales ?? DEFAULT_IMAGE_MATCH_SCALES)];
}

/**
 * Returns the ordinary-user scales that were not already covered by a fast
 * predicted attempt. Near-equal values are treated as the same scale so a
 * Surface prediction such as 1.249 does not trigger a redundant 1.25 pass.
 */
export function imageMatchFallbackScales(attempted: readonly number[]): number[] {
  const candidates = [...DEFAULT_IMAGE_MATCH_SCALES, ...DEFAULT_IMAGE_MATCH_DPI_FALLBACK_SCALES];
  return candidates.filter((candidate) => !attempted.some((value) => (
    Number.isFinite(value) && Math.abs(candidate - value) / Math.max(candidate, Math.abs(value), 1e-6) <= 0.01
  )));
}

export type SurfaceImageScaleReference = {
  readonly width: number;
  readonly height: number;
};

/**
 * Predicts one isotropic scale only when every image was captured against the
 * same trusted Surface size. Undefined means the caller must retain the broad
 * default scale fallback.
 */
export function surfaceReferenceImageScales(
  references: readonly SurfaceImageScaleReference[],
  current: SurfaceImageScaleReference,
): number[] | undefined {
  if (references.length === 0 || ![current.width, current.height].every((value) => Number.isFinite(value) && value > 0)) return undefined;
  const scales: number[] = [];
  for (const reference of references) {
    if (![reference.width, reference.height].every((value) => Number.isFinite(value) && value > 0)) return undefined;
    const widthScale = current.width / reference.width;
    const heightScale = current.height / reference.height;
    const relativeSkew = Math.abs(widthScale - heightScale) / Math.max(widthScale, heightScale);
    if (relativeSkew > 0.03) return undefined;
    scales.push(Math.sqrt(widthScale * heightScale));
  }
  const minimum = Math.min(...scales); const maximum = Math.max(...scales);
  if (minimum < 0.25 || maximum > 4 || (maximum - minimum) / maximum > 0.02) return undefined;
  return [scales.reduce((sum, value) => sum + value, 0) / scales.length];
}
