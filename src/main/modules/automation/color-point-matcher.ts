import { performance } from 'perf_hooks';

export type BgraImage = {
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
};

export type ColorPointMatchOptions = {
  readonly scales?: readonly number[];
  readonly tolerance?: number;
  readonly threshold?: number;
  readonly maxCandidates?: number;
  readonly mirror?: boolean;
  readonly maxVerificationCandidates?: number;
  /** Keep overlapping scale hypotheses for a downstream structure verifier. */
  readonly preserveScaleHypotheses?: boolean;
  readonly region?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
};

export type ColorPointMatch = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly mirrored: boolean;
  readonly score: number;
  readonly featureCount: number;
  readonly matchedFeatures: number;
  readonly matchMs: number;
};

type Color = readonly [number, number, number]; // BGR
type Feature = { readonly x: number; readonly y: number; readonly color: Color; readonly bucket: number };
type ColorPoint = { readonly x: number; readonly y: number };
type ColorGroup = { readonly color: Color; readonly points: readonly ColorPoint[] };

export type ColorPointSignature = {
  /** Full authored asset size, including transparent/dominant-background border. */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /** Foreground bounds inside the authored asset. */
  readonly offsetX: number;
  readonly offsetY: number;
  readonly width: number;
  readonly height: number;
  readonly features: readonly Feature[];
  readonly colorGroups: readonly ColorGroup[];
  /** Transparent/background samples immediately outside the foreground shape. */
  readonly negativePoints: readonly ColorPoint[];
};

export class UnsupportedColorPointSignatureError extends Error {
  readonly code = 'COLOR_SIGNATURE_UNSUPPORTED';

  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedColorPointSignatureError';
  }
}

const colorDistance = (pixels: Uint8Array, offset: number, color: Color): number => (
  Math.abs(pixels[offset] - color[0])
  + Math.abs(pixels[offset + 1] - color[1])
  + Math.abs(pixels[offset + 2] - color[2])
);

function quantizedKey(pixels: Uint8Array, offset: number): number {
  return (pixels[offset] >> 4) | ((pixels[offset + 1] >> 4) << 4) | ((pixels[offset + 2] >> 4) << 8);
}

function quantizedColorDistance(key: number, color: Color): number {
  const blue = ((key & 0xf) << 4) + 8;
  const green = (((key >> 4) & 0xf) << 4) + 8;
  const red = (((key >> 8) & 0xf) << 4) + 8;
  return Math.abs(blue - color[0]) + Math.abs(green - color[1]) + Math.abs(red - color[2]);
}

function validateImage(image: BgraImage, label: string): void {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width <= 0 || image.height <= 0) {
    throw new Error(`${label} dimensions must be positive integers`);
  }
  if (image.pixels.byteLength !== image.width * image.height * 4) {
    throw new Error(`${label} BGRA byte length does not match dimensions`);
  }
}

function selectSpread(points: readonly Feature[], limit: number): Feature[] {
  if (points.length <= limit) return [...points];
  const selected = [points[Math.floor(points.length / 2)]];
  while (selected.length < limit) {
    let best: Feature | undefined; let bestDistance = -1;
    for (const point of points) {
      const nearest = Math.min(...selected.map((chosen) => (
        (point.x - chosen.x) ** 2 + (point.y - chosen.y) ** 2
      )));
      if (nearest > bestDistance) { best = point; bestDistance = nearest; }
    }
    if (!best || selected.includes(best)) break;
    selected.push(best);
  }
  return selected;
}

function sampleSpread(points: readonly ColorPoint[], limit: number): ColorPoint[] {
  if (points.length <= limit) return [...points];
  const step = points.length / limit;
  return Array.from({ length: limit }, (_, index) => points[Math.floor((index + .5) * step)]);
}

export function extractColorPointSignature(template: BgraImage, maximumFeatures = 36): ColorPointSignature {
  validateImage(template, 'template');
  const { pixels, width, height } = template;
  const border = new Map<number, number>(); let opaqueBorder = 0;
  const addBorder = (x: number, y: number) => {
    const offset = (y * width + x) * 4;
    if (pixels[offset + 3] < 128) return;
    const key = quantizedKey(pixels, offset);
    border.set(key, (border.get(key) ?? 0) + 1); opaqueBorder += 1;
  };
  for (let x = 0; x < width; x += 1) { addBorder(x, 0); if (height > 1) addBorder(x, height - 1); }
  for (let y = 1; y + 1 < height; y += 1) { addBorder(0, y); if (width > 1) addBorder(width - 1, y); }
  const dominantBorder = [...border.entries()].sort((left, right) => right[1] - left[1])[0];
  const backgroundKey = dominantBorder && dominantBorder[1] / Math.max(1, opaqueBorder) >= .45
    ? dominantBorder[0]
    : undefined;

  const buckets = new Map<number, Feature[]>(); const body: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      if (pixels[offset + 3] < 128) continue;
      const key = quantizedKey(pixels, offset);
      if (key === backgroundKey) continue;
      const entries = buckets.get(key) ?? [];
      entries.push({ x, y, color: [pixels[offset], pixels[offset + 1], pixels[offset + 2]], bucket: key });
      buckets.set(key, entries);
      body.push({ x, y });
    }
  }
  const foregroundCount = [...buckets.values()].reduce((sum, entries) => sum + entries.length, 0);
  if (foregroundCount < 8) throw new UnsupportedColorPointSignatureError('template has too few foreground color pixels');
  const minimumX = Math.min(...body.map((point) => point.x)); const minimumY = Math.min(...body.map((point) => point.y));
  const maximumX = Math.max(...body.map((point) => point.x)); const maximumY = Math.max(...body.map((point) => point.y));
  const useful = [...buckets.values()]
    .filter((entries) => entries.length >= Math.max(2, Math.floor(foregroundCount * .004)))
    .sort((left, right) => right.length - left.length)
    .slice(0, 8);
  if (useful.length < 2) throw new UnsupportedColorPointSignatureError('template does not contain enough distinct foreground colors');
  const perBucket = Math.max(2, Math.floor(maximumFeatures / useful.length));
  const majors = useful.map((entries) => {
    const totals = entries.reduce((sum, entry) => [sum[0] + entry.color[0], sum[1] + entry.color[1], sum[2] + entry.color[2]], [0, 0, 0]);
    return totals.map((value) => Math.round(value / entries.length)) as unknown as Color;
  });
  if (!majors.some((color) => Math.max(...color) - Math.min(...color) >= 24)) {
    throw new UnsupportedColorPointSignatureError('template does not contain discriminating chromatic colors');
  }
  const features = useful.flatMap((entries, bucket) => selectSpread(entries, perBucket).map((entry) => ({
    ...entry, x: entry.x - minimumX, y: entry.y - minimumY, color: majors[bucket],
  }))).slice(0, maximumFeatures);
  // Positive colour points alone are ambiguous for tiny sprites: unrelated UI
  // text or foliage can contain the same handful of colours. Preserve a thin
  // ring of authored background around the foreground so verification can
  // reject candidates whose matching colours continue outside the silhouette.
  const foreground = new Set(body.map((point) => `${point.x}:${point.y}`));
  const negative: ColorPoint[] = [];
  for (let y = Math.max(0, minimumY - 2); y <= Math.min(height - 1, maximumY + 2); y += 1) {
    for (let x = Math.max(0, minimumX - 2); x <= Math.min(width - 1, maximumX + 2); x += 1) {
      if (foreground.has(`${x}:${y}`)) continue;
      const offset = (y * width + x) * 4;
      const isBackground = pixels[offset + 3] < 128 || quantizedKey(pixels, offset) === backgroundKey;
      if (!isBackground) continue;
      let nextToForeground = false;
      for (let dy = -2; dy <= 2 && !nextToForeground; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
        if (foreground.has(`${x + dx}:${y + dy}`)) { nextToForeground = true; break; }
      }
      if (nextToForeground) negative.push({ x: x - minimumX, y: y - minimumY });
    }
  }
  return {
    sourceWidth: width,
    sourceHeight: height,
    offsetX: minimumX,
    offsetY: minimumY,
    width: maximumX - minimumX + 1,
    height: maximumY - minimumY + 1,
    features,
    colorGroups: useful.map((entries, index) => ({
      color: majors[index],
      points: sampleSpread(entries.map((point) => ({ x: point.x - minimumX, y: point.y - minimumY })), 96),
    })),
    negativePoints: sampleSpread(negative, 96),
  };
}

function regionBounds(scene: BgraImage, region: ColorPointMatchOptions['region']) {
  const x = Math.max(0, Math.floor(region?.x ?? 0));
  const y = Math.max(0, Math.floor(region?.y ?? 0));
  const right = Math.min(scene.width, Math.ceil((region?.x ?? 0) + (region?.width ?? scene.width)));
  const bottom = Math.min(scene.height, Math.ceil((region?.y ?? 0) + (region?.height ?? scene.height)));
  if (right <= x || bottom <= y) throw new Error('color search region is outside the scene');
  return { x, y, right, bottom };
}

function matchQualityNear(
  scene: BgraImage,
  x: number,
  y: number,
  color: Color,
  tolerance: number,
  bounds: ReturnType<typeof regionBounds>,
): number {
  let best = 0;
  for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
    const sx = x + dx; const sy = y + dy;
    if (sx < bounds.x || sy < bounds.y || sx >= bounds.right || sy >= bounds.bottom) continue;
    const distance = colorDistance(scene.pixels, (sy * scene.width + sx) * 4, color);
    if (distance > tolerance) continue;
    const colorQuality = tolerance === 0 ? 1 : 1 - distance / (tolerance + 1);
    const spatialQuality = dx === 0 && dy === 0 ? 1 : .85;
    best = Math.max(best, colorQuality * spatialQuality);
  }
  return best;
}

function matchQualityAt(
  scene: BgraImage,
  x: number,
  y: number,
  color: Color,
  tolerance: number,
  bounds: ReturnType<typeof regionBounds>,
): number {
  if (x < bounds.x || y < bounds.y || x >= bounds.right || y >= bounds.bottom) return 0;
  const distance = colorDistance(scene.pixels, (y * scene.width + x) * 4, color);
  if (distance > tolerance) return 0;
  return tolerance === 0 ? 1 : 1 - distance / (tolerance + 1);
}

function overlaps(left: ColorPointMatch, right: ColorPointMatch): boolean {
  const intersectionWidth = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const intersectionHeight = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  const intersection = intersectionWidth * intersectionHeight;
  return intersection / Math.max(1, Math.min(left.width * left.height, right.width * right.height)) >= .5;
}

export function areColorPointMatchesSameObject(left: ColorPointMatch, right: ColorPointMatch): boolean {
  if (overlaps(left, right)) return true;
  const leftCenterX = left.x + left.width / 2; const leftCenterY = left.y + left.height / 2;
  const rightCenterX = right.x + right.width / 2; const rightCenterY = right.y + right.height / 2;
  // Small animated sprites often yield two hypotheses for adjacent scale
  // factors and mirrored fits. Their boxes can be displaced by roughly one
  // and a half target dimensions even
  // though both describe the same object (the fishing hook is a representative
  // case). Do not count that scale jitter as an independent runner-up: the
  // uniqueness gate must compare against a genuinely separate screen region.
  return Math.abs(leftCenterX - rightCenterX) <= Math.max(left.width, right.width) * 1.6
    && Math.abs(leftCenterY - rightCenterY) <= Math.max(left.height, right.height) * 1.6;
}

type ScaledColorGroup = { readonly color: Color; readonly points: readonly ColorPoint[] };

function scaleColorGroups(signature: ColorPointSignature, scale: number, mirrored: boolean): ScaledColorGroup[] {
  return signature.colorGroups.map((group) => {
    const unique = new Map<string, ColorPoint>();
    for (const point of group.points) {
      const sourceX = mirrored ? signature.width - 1 - point.x : point.x;
      const scaled = { x: Math.round(sourceX * scale), y: Math.round(point.y * scale) };
      unique.set(`${scaled.x}:${scaled.y}`, scaled);
    }
    return { color: group.color, points: [...unique.values()] };
  }).filter((group) => group.points.length > 0);
}

function scalePoints(points: readonly ColorPoint[], width: number, scale: number, mirrored: boolean): ColorPoint[] {
  const unique = new Map<string, ColorPoint>();
  for (const point of points) {
    const sourceX = mirrored ? width - 1 - point.x : point.x;
    const scaled = { x: Math.round(sourceX * scale), y: Math.round(point.y * scale) };
    unique.set(`${scaled.x}:${scaled.y}`, scaled);
  }
  return [...unique.values()];
}

export function matchColorPointSignature(
  scene: BgraImage,
  signature: ColorPointSignature,
  options: ColorPointMatchOptions = {},
): ColorPointMatch[] {
  validateImage(scene, 'scene');
  const startedAt = performance.now();
  // BrowserView captures may contain bilinear/cubic resampling even for pixel
  // art. A 70-point RGB Manhattan tolerance preserves the authored colour
  // families after that interpolation; the spatial uniqueness gate remains the
  // protection against common scene colours.
  const tolerance = Math.max(0, options.tolerance ?? 70);
  const threshold = Math.min(1, Math.max(0, options.threshold ?? .8));
  const bounds = regionBounds(scene, options.region);
  const scales = [...new Set(options.scales ?? [1])].filter((scale) => Number.isFinite(scale) && scale > 0);
  // Image locators describe the authored pixels. Mirroring them implicitly
  // changes their meaning (and can confuse left/right character directions or
  // turn nearby scene colours into a competing hook candidate). Only search a
  // mirrored variant when the caller explicitly opts in.
  const mirrorModes = options.mirror === true ? [false, true] : [false];

  const featuresByBucket = new Map<number, Feature[]>();
  for (const feature of signature.features) {
    const entries = featuresByBucket.get(feature.bucket) ?? [];
    entries.push(feature); featuresByBucket.set(feature.bucket, entries);
  }
  const sceneBuckets = new Map<number, number>();
  for (let y = bounds.y; y < bounds.bottom; y += 1) for (let x = bounds.x; x < bounds.right; x += 1) {
    const offset = (y * scene.width + x) * 4;
    const key = quantizedKey(scene.pixels, offset);
    sceneBuckets.set(key, (sceneBuckets.get(key) ?? 0) + 1);
  }
  const anchorCandidates = [...featuresByBucket.values()]
    .map((entries) => {
      const feature = entries[0]; let approximateHits = 0;
      for (const [key, count] of sceneBuckets) {
        // Quantization can add at most 24 Manhattan-distance units. Including
        // that error keeps the estimate conservative while avoiding a full
        // scene scan for every template color.
        if (quantizedColorDistance(key, feature.color) <= tolerance + 24) approximateHits += count;
      }
      return { feature, approximateHits };
    })
    .filter((candidate) => candidate.approximateHits > 0)
    .sort((left, right) => left.approximateHits - right.approximateHits);
  let anchorChoice: { feature: Feature; positions: Array<readonly [number, number]> } | undefined;
  for (const candidate of anchorCandidates) {
    const positions: Array<readonly [number, number]> = [];
    for (let y = bounds.y; y < bounds.bottom; y += 1) for (let x = bounds.x; x < bounds.right; x += 1) {
      if (colorDistance(scene.pixels, (y * scene.width + x) * 4, candidate.feature.color) <= tolerance) positions.push([x, y]);
    }
    if (positions.length > 0) { anchorChoice = { feature: candidate.feature, positions }; break; }
  }
  const searchedPixels = (bounds.right - bounds.x) * (bounds.bottom - bounds.y);
  if (!anchorChoice || anchorChoice.positions.length > searchedPixels * .15) return [];
  const anchor = anchorChoice.feature;

  const raw: ColorPointMatch[] = [];
  for (const scale of scales) for (const mirrored of mirrorModes) {
    const sourceWidth = Math.max(1, Math.round(signature.sourceWidth * scale));
    const sourceHeight = Math.max(1, Math.round(signature.sourceHeight * scale));
    const sourceOffsetX = Math.round((mirrored
      ? signature.sourceWidth - signature.offsetX - signature.width
      : signature.offsetX) * scale);
    const sourceOffsetY = Math.round(signature.offsetY * scale);
    const anchorX = Math.round((mirrored ? signature.width - 1 - anchor.x : anchor.x) * scale);
    const anchorY = Math.round(anchor.y * scale);
    const scaledFeatureGroups = new Map<string, { x: number; y: number; colors: Color[] }>();
    for (const feature of signature.features) {
      const featureX = mirrored ? signature.width - 1 - feature.x : feature.x;
      const x = Math.round(featureX * scale); const y = Math.round(feature.y * scale);
      const key = `${x}:${y}`; const group = scaledFeatureGroups.get(key) ?? { x, y, colors: [] };
      group.colors.push(feature.color); scaledFeatureGroups.set(key, group);
    }
    const scaledColorGroups = scaleColorGroups(signature, scale, mirrored);
    const scaledNegativePoints = scalePoints(signature.negativePoints, signature.width, scale, mirrored);
    const origins = new Set<string>();
    for (const [sx, sy] of anchorChoice.positions) {
      const x = sx - anchorX; const y = sy - anchorY;
      const sourceX = x - sourceOffsetX; const sourceY = y - sourceOffsetY;
      if (sourceX < bounds.x || sourceY < bounds.y
        || sourceX + sourceWidth > bounds.right || sourceY + sourceHeight > bounds.bottom) continue;
      origins.add(`${x}:${y}`);
    }
    const verifiedOrigins: Array<{
      readonly x: number;
      readonly y: number;
      readonly matchedFeatures: number;
      readonly geometryScore: number;
    }> = [];
    for (const origin of origins) {
      const separator = origin.indexOf(':');
      const x = Number(origin.slice(0, separator)); const y = Number(origin.slice(separator + 1));
      let matchedFeatures = 0; let qualitySum = 0;
      for (const feature of scaledFeatureGroups.values()) {
        let quality = 0;
        for (const color of feature.colors) quality = Math.max(quality, matchQualityNear(scene, x + feature.x, y + feature.y, color, tolerance, bounds));
        if (quality > 0) matchedFeatures += 1;
        qualitySum += quality;
      }
      const geometryScore = qualitySum / scaledFeatureGroups.size;
      verifiedOrigins.push({ x, y, matchedFeatures, geometryScore });
    }
    verifiedOrigins.sort((left, right) => right.geometryScore - left.geometryScore);
    const verificationLimit = Math.max(1, Math.floor(options.maxVerificationCandidates ?? 48));
    for (const { x, y, matchedFeatures, geometryScore } of verifiedOrigins.slice(0, verificationLimit)) {
      let coverageScore = 0;
      for (const group of scaledColorGroups) {
        let groupQuality = 0;
        for (const point of group.points) groupQuality += matchQualityNear(scene, x + point.x, y + point.y, group.color, tolerance, bounds);
        coverageScore += groupQuality / group.points.length;
      }
      coverageScore /= scaledColorGroups.length;
      // Interpolated browser scaling changes exact RGB distances even when the
      // target geometry remains intact. Keep continuous color quality as the
      // majority signal, but add binary feature recall so confidence does not
      // collapse solely because pixels were resampled between authored and
      // captured sizes.
      const featureRecall = matchedFeatures / scaledFeatureGroups.size;
      const positiveScore = geometryScore * .25 + coverageScore * .35 + featureRecall * .4;
      let negativeIntrusion = 0;
      if (scaledNegativePoints.length > 0) {
        const foregroundColors = scaledColorGroups.map((group) => group.color);
        for (const point of scaledNegativePoints) {
          let intrusion = 0;
          for (const color of foregroundColors) {
            intrusion = Math.max(intrusion, matchQualityAt(scene, x + point.x, y + point.y, color, tolerance, bounds));
          }
          negativeIntrusion += intrusion;
        }
        negativeIntrusion /= scaledNegativePoints.length;
      }
      // Negative evidence only lowers confidence. A clean silhouette keeps its
      // original score, while a same-colour patch extending through the
      // authored transparent ring is demoted before the uniqueness gate.
      const score = positiveScore * (1 - negativeIntrusion * .35);
      if (score >= threshold) raw.push({
        x: x - sourceOffsetX,
        y: y - sourceOffsetY,
        width: sourceWidth,
        height: sourceHeight,
        scale, mirrored, score,
        featureCount: scaledFeatureGroups.size, matchedFeatures, matchMs: 0,
      });
    }
  }
  raw.sort((left, right) => right.score - left.score || left.y - right.y || left.x - right.x);
  const selected: ColorPointMatch[] = [];
  for (const match of raw) {
    if (!options.preserveScaleHypotheses
      && selected.some((existing) => areColorPointMatchesSameObject(existing, match))) continue;
    selected.push({ ...match, matchMs: performance.now() - startedAt });
    if (selected.length >= (options.maxCandidates ?? 5)) break;
  }
  return selected;
}

export function matchColorPoints(
  scene: BgraImage,
  template: BgraImage,
  options: ColorPointMatchOptions = {},
): ColorPointMatch[] {
  validateImage(template, 'template');
  const signature = extractColorPointSignature(template);
  return matchColorPointSignature(scene, signature, options);
}
