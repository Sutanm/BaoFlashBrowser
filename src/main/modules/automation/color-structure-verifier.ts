import { performance } from 'perf_hooks';
import { areColorPointMatchesSameObject, type BgraImage, type ColorPointMatch } from './color-point-matcher';

export type ColorStructureVerification = {
  readonly colorCoverage: number;
  readonly silhouettePrecision: number;
  readonly silhouetteIou: number;
  readonly chromaCorrelation: number;
  readonly edgeSimilarity: number;
  readonly structureScore: number;
  readonly verifyMs: number;
  readonly foregroundPixels: number;
  readonly alignmentX: number;
  readonly alignmentY: number;
};

type Color = readonly [number, number, number];

/** Retain one position per object and scale; structure still gets to compare scales. */
export function selectStructureProposals(candidates: readonly ColorPointMatch[], maximum = 16): ColorPointMatch[] {
  const selected: ColorPointMatch[] = [];
  for (const candidate of candidates) {
    if (selected.some((existing) => existing.scale === candidate.scale
      && existing.mirrored === candidate.mirrored
      && areColorPointMatchesSameObject(existing, candidate))) continue;
    selected.push(candidate);
    if (selected.length >= maximum) break;
  }
  return selected;
}

function validateImage(image: BgraImage, label: string): void {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width <= 0 || image.height <= 0) {
    throw new Error(`${label} dimensions must be positive integers`);
  }
  if (image.pixels.byteLength !== image.width * image.height * 4) {
    throw new Error(`${label} BGRA byte length does not match dimensions`);
  }
}

function quantizedKey(pixels: Uint8Array, offset: number): number {
  return (pixels[offset] >> 4) | ((pixels[offset + 1] >> 4) << 4) | ((pixels[offset + 2] >> 4) << 8);
}

function inferForeground(template: BgraImage): Uint8Array {
  const { pixels, width, height } = template;
  const border = new Map<number, number>(); let opaqueBorder = 0;
  const add = (x: number, y: number) => {
    const offset = (y * width + x) * 4;
    if (pixels[offset + 3] < 128) return;
    const key = quantizedKey(pixels, offset);
    border.set(key, (border.get(key) ?? 0) + 1); opaqueBorder += 1;
  };
  for (let x = 0; x < width; x += 1) { add(x, 0); if (height > 1) add(x, height - 1); }
  for (let y = 1; y + 1 < height; y += 1) { add(0, y); if (width > 1) add(width - 1, y); }
  const dominant = [...border.entries()].sort((left, right) => right[1] - left[1])[0];
  const backgroundKey = dominant && dominant[1] / Math.max(1, opaqueBorder) >= .45 ? dominant[0] : undefined;
  const mask = new Uint8Array(width * height);
  for (let index = 0; index < mask.length; index += 1) {
    const offset = index * 4;
    if (pixels[offset + 3] >= 128 && quantizedKey(pixels, offset) !== backgroundKey) mask[index] = 1;
  }
  return mask;
}

function colorDistance(left: Uint8Array, leftOffset: number, right: Uint8Array, rightOffset: number): number {
  return Math.abs(left[leftOffset] - right[rightOffset])
    + Math.abs(left[leftOffset + 1] - right[rightOffset + 1])
    + Math.abs(left[leftOffset + 2] - right[rightOffset + 2]);
}

function paletteDistance(pixels: Uint8Array, offset: number, palette: readonly Color[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const color of palette) {
    best = Math.min(best, Math.abs(pixels[offset] - color[0])
      + Math.abs(pixels[offset + 1] - color[1])
      + Math.abs(pixels[offset + 2] - color[2]));
  }
  return best;
}

function correlation(left: readonly number[], right: readonly number[]): number {
  if (left.length < 2 || left.length !== right.length) return 0;
  let leftMean = 0; let rightMean = 0;
  for (let index = 0; index < left.length; index += 1) { leftMean += left[index]; rightMean += right[index]; }
  leftMean /= left.length; rightMean /= right.length;
  let numerator = 0; let leftVariance = 0; let rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index] - leftMean; const rightDelta = right[index] - rightMean;
    numerator += leftDelta * rightDelta; leftVariance += leftDelta ** 2; rightVariance += rightDelta ** 2;
  }
  if (leftVariance < 1e-6 || rightVariance < 1e-6) return 0;
  return Math.max(0, Math.min(1, numerator / Math.sqrt(leftVariance * rightVariance)));
}

/**
 * Verifies a fast colour proposal against every pixel in the authored asset.
 * The colour matcher proposes location/scale; this verifier measures whether
 * the local colour layout and silhouette still describe the same object.
 */
function verifyExactStructure(
  scene: BgraImage,
  template: BgraImage,
  candidate: Pick<ColorPointMatch, 'x' | 'y' | 'width' | 'height' | 'mirrored'>,
  tolerance = 70,
): ColorStructureVerification {
  validateImage(scene, 'scene'); validateImage(template, 'template');
  const startedAt = performance.now();
  if (candidate.width <= 0 || candidate.height <= 0
    || candidate.x < 0 || candidate.y < 0
    || candidate.x + candidate.width > scene.width || candidate.y + candidate.height > scene.height) {
    throw new Error('candidate bounds are outside the scene');
  }
  const foreground = inferForeground(template);
  const paletteMap = new Map<number, Color>();
  for (let index = 0; index < foreground.length; index += 1) {
    if (!foreground[index]) continue;
    const offset = index * 4; const key = quantizedKey(template.pixels, offset);
    if (!paletteMap.has(key)) paletteMap.set(key, [template.pixels[offset], template.pixels[offset + 1], template.pixels[offset + 2]]);
  }
  const palette = [...paletteMap.values()];
  if (palette.length === 0) throw new Error('template has no foreground pixels');

  let expected = 0; let observed = 0; let intersection = 0; let quality = 0;
  const templateChroma: number[] = []; const sceneChroma: number[] = [];
  const templateEdges: number[] = []; const sceneEdges: number[] = [];
  const sourceAt = (outputX: number, outputY: number) => {
    const mappedX = Math.min(template.width - 1, Math.floor((outputX + .5) * template.width / candidate.width));
    const mappedY = Math.min(template.height - 1, Math.floor((outputY + .5) * template.height / candidate.height));
    return { x: candidate.mirrored ? template.width - 1 - mappedX : mappedX, y: mappedY };
  };
  const luminance = (pixels: Uint8Array, offset: number) => pixels[offset] * .114 + pixels[offset + 1] * .587 + pixels[offset + 2] * .299;
  for (let outputY = 0; outputY < candidate.height; outputY += 1) for (let outputX = 0; outputX < candidate.width; outputX += 1) {
    const source = sourceAt(outputX, outputY);
    const sourceIndex = source.y * template.width + source.x;
    const templateOffset = sourceIndex * 4;
    const sceneOffset = ((candidate.y + outputY) * scene.width + candidate.x + outputX) * 4;
    const isExpected = foreground[sourceIndex] === 1;
    const isObserved = paletteDistance(scene.pixels, sceneOffset, palette) <= tolerance;
    if (isExpected) expected += 1;
    if (isObserved) observed += 1;
    if (isExpected && isObserved) intersection += 1;
    if (!isExpected) continue;
    quality += Math.max(0, 1 - colorDistance(template.pixels, templateOffset, scene.pixels, sceneOffset) / (tolerance + 1));
    // B-G and R-G remove most brightness changes while preserving authored
    // colour arrangement. Both channels participate in one local correlation.
    templateChroma.push(template.pixels[templateOffset] - template.pixels[templateOffset + 1]);
    templateChroma.push(template.pixels[templateOffset + 2] - template.pixels[templateOffset + 1]);
    sceneChroma.push(scene.pixels[sceneOffset] - scene.pixels[sceneOffset + 1]);
    sceneChroma.push(scene.pixels[sceneOffset + 2] - scene.pixels[sceneOffset + 1]);
    if (source.x > 0 && source.y > 0 && source.x + 1 < template.width && source.y + 1 < template.height
      && outputX > 0 && outputY > 0 && outputX + 1 < candidate.width && outputY + 1 < candidate.height) {
      const templateLeft = (source.y * template.width + source.x - 1) * 4;
      const templateRight = (source.y * template.width + source.x + 1) * 4;
      const templateTop = ((source.y - 1) * template.width + source.x) * 4;
      const templateBottom = ((source.y + 1) * template.width + source.x) * 4;
      const sceneLeft = (sceneOffset - 4); const sceneRight = sceneOffset + 4;
      const sceneTop = sceneOffset - scene.width * 4; const sceneBottom = sceneOffset + scene.width * 4;
      templateEdges.push(luminance(template.pixels, templateRight) - luminance(template.pixels, templateLeft));
      templateEdges.push(luminance(template.pixels, templateBottom) - luminance(template.pixels, templateTop));
      sceneEdges.push(luminance(scene.pixels, sceneRight) - luminance(scene.pixels, sceneLeft));
      sceneEdges.push(luminance(scene.pixels, sceneBottom) - luminance(scene.pixels, sceneTop));
    }
  }
  const union = expected + observed - intersection;
  const colorCoverage = expected > 0 ? quality / expected : 0;
  const silhouettePrecision = observed > 0 ? intersection / observed : 0;
  const silhouetteIou = union > 0 ? intersection / union : 0;
  const chromaCorrelation = correlation(templateChroma, sceneChroma);
  const edgeSimilarity = correlation(templateEdges, sceneEdges);
  // A false colour patch must not compensate for bad shape with one perfect
  // component. The geometric mean makes every independent cue matter.
  const structureScore = Math.pow(
    Math.max(0, colorCoverage)
      * Math.max(0, silhouettePrecision)
      * Math.max(0, silhouetteIou)
      * Math.max(0, chromaCorrelation)
      * Math.max(.05, edgeSimilarity),
    1 / 5,
  );
  return {
    colorCoverage, silhouettePrecision, silhouetteIou, chromaCorrelation, edgeSimilarity,
    structureScore, verifyMs: performance.now() - startedAt, foregroundPixels: expected,
    alignmentX: 0, alignmentY: 0,
  };
}

export function verifyColorPointStructure(
  scene: BgraImage,
  template: BgraImage,
  candidate: Pick<ColorPointMatch, 'x' | 'y' | 'width' | 'height' | 'mirrored'>,
  tolerance = 70,
  alignmentRadius = 4,
): ColorStructureVerification {
  const startedAt = performance.now();
  let best: ColorStructureVerification | undefined;
  const radius = Math.max(0, Math.floor(alignmentRadius));
  for (let alignmentY = -radius; alignmentY <= radius; alignmentY += 1) {
    for (let alignmentX = -radius; alignmentX <= radius; alignmentX += 1) {
      const shifted = { ...candidate, x: candidate.x + alignmentX, y: candidate.y + alignmentY };
      if (shifted.x < 0 || shifted.y < 0
        || shifted.x + shifted.width > scene.width || shifted.y + shifted.height > scene.height) continue;
      const result = verifyExactStructure(scene, template, shifted, tolerance);
      if (!best || result.structureScore > best.structureScore) best = { ...result, alignmentX, alignmentY };
    }
  }
  if (!best) throw new Error('candidate bounds are outside the scene');
  return { ...best, verifyMs: performance.now() - startedAt };
}
