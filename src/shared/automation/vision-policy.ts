export const DEFAULT_IMAGE_MATCH_THRESHOLD = 0.9;
export const DEFAULT_IMAGE_MATCH_SCALES = Object.freeze([0.75, 1, 1.25] as const);
export const DEFAULT_IMAGE_MATCH_MASK = 'auto' as const;

/** Returns a mutable request copy while keeping the product defaults immutable. */
export function imageMatchScales(scales?: readonly number[]): number[] {
  return [...(scales ?? DEFAULT_IMAGE_MATCH_SCALES)];
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
