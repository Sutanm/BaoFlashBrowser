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
  readonly viewportTransform?: {
    readonly scaleX: number;
    readonly scaleY: number;
  };
};

export type CapturedImageScaleReference = SurfaceImageScaleReference & {
  readonly kind: 'viewport' | 'region' | 'surface';
};

export type CapturedImageScaleContext = {
  readonly viewport: SurfaceImageScaleReference;
  readonly surface?: SurfaceImageScaleReference;
};

/**
 * Predicts one isotropic scale only when every image was captured against the
 * same trusted Surface size and capture transform. The logical-size ratio
 * handles a resized Surface; authoring/runtime transform ratio handles page
 * zoom and display scaling. Undefined keeps legacy assets on broad fallback.
 */
export function surfaceReferenceImageScales(
  references: readonly SurfaceImageScaleReference[],
  current: SurfaceImageScaleReference,
): number[] | undefined {
  if (references.length === 0 || !validReference(current)) return undefined;
  const scales: number[] = [];
  for (const reference of references) {
    if (!validReference(reference)) return undefined;
    const widthScale = current.width / reference.width * reference.viewportTransform.scaleX / current.viewportTransform.scaleX;
    const heightScale = current.height / reference.height * reference.viewportTransform.scaleY / current.viewportTransform.scaleY;
    const relativeSkew = Math.abs(widthScale - heightScale) / Math.max(widthScale, heightScale);
    if (relativeSkew > 0.03) return undefined;
    scales.push(Math.sqrt(widthScale * heightScale));
  }
  const minimum = Math.min(...scales); const maximum = Math.max(...scales);
  if (minimum < 0.25 || maximum > 4 || (maximum - minimum) / maximum > 0.02) return undefined;
  return [scales.reduce((sum, value) => sum + value, 0) / scales.length];
}

/**
 * Predicts scales for every kind of in-app capture. Viewport and arbitrary
 * region crops share the page's pixel density, so their logical ratio is the
 * viewport ratio or 1 respectively. A Surface additionally follows responsive
 * changes in that Surface's logical bounds.
 */
export function capturedReferenceImageScales(
  references: readonly CapturedImageScaleReference[],
  current: CapturedImageScaleContext,
): number[] | undefined {
  if (references.length === 0 || !validReference(current.viewport)) return undefined;
  const scales: number[] = [];
  for (const reference of references) {
    const logicalCurrent = reference.kind === 'surface'
      ? current.surface
      : reference.kind === 'viewport'
        ? current.viewport
        : { width: reference.width, height: reference.height, viewportTransform: current.viewport.viewportTransform };
    if (!logicalCurrent) return undefined;
    const predicted = surfaceReferenceImageScales([reference], logicalCurrent)?.[0];
    if (predicted === undefined) return undefined;
    scales.push(predicted);
  }
  const minimum = Math.min(...scales); const maximum = Math.max(...scales);
  if ((maximum - minimum) / maximum > 0.02) return undefined;
  return [scales.reduce((sum, value) => sum + value, 0) / scales.length];
}

function validReference(value: SurfaceImageScaleReference): value is SurfaceImageScaleReference & { readonly viewportTransform: { readonly scaleX: number; readonly scaleY: number } } {
  return [value.width, value.height, value.viewportTransform?.scaleX, value.viewportTransform?.scaleY]
    .every((item) => typeof item === 'number' && Number.isFinite(item) && item > 0);
}
