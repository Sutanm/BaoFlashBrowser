import { parentPort } from 'worker_threads';
import {
  areColorPointMatchesSameObject,
  createColorPointSceneIndex,
  extractColorPointSignature,
  matchColorPointSignature,
  UnsupportedColorPointSignatureError,
  type BgraImage,
  type ColorPointSignature,
} from './color-point-matcher';
import { selectStructureProposals, verifyColorPointStructure } from './color-structure-verifier';
import { evaluateStructuredColorMatch, MINIMUM_COLOR_STRUCTURE_MARGIN } from './color-structure-policy';

type TemplatePayload = {
  readonly asset: string;
  readonly cacheKey: string;
  readonly width: number;
  readonly height: number;
  readonly bgra?: Uint8Array;
};

type MatchRequest = {
  readonly id: number;
  readonly type?: 'match';
  readonly scene: BgraImage & { readonly frameKey?: string; readonly reuse?: boolean };
  readonly templates: readonly TemplatePayload[];
  readonly options: {
    readonly threshold: number;
    readonly scales?: readonly number[];
    readonly maxCandidates?: number;
  };
};

type PreloadRequest = {
  readonly id: number;
  readonly type: 'preload';
  readonly templates: readonly TemplatePayload[];
};

type Request = MatchRequest | PreloadRequest;

const signatures = new Map<string, ColorPointSignature>();
const templateImages = new Map<string, BgraImage>();
const unsupportedSignatures = new Set<string>();
const MAX_SIGNATURES = 64;
let cachedScene: { readonly key: string; readonly scene: BgraImage; readonly index: ReturnType<typeof createColorPointSceneIndex> } | undefined;

function signatureFor(template: TemplatePayload): ColorPointSignature | undefined {
  const cached = signatures.get(template.cacheKey);
  if (cached) {
    signatures.delete(template.cacheKey);
    signatures.set(template.cacheKey, cached);
    const image = templateImages.get(template.cacheKey);
    if (image) { templateImages.delete(template.cacheKey); templateImages.set(template.cacheKey, image); }
    return cached;
  }
  if (unsupportedSignatures.has(template.cacheKey)) return undefined;
  if (!template.bgra) throw new Error(`color template cache miss: ${template.asset}`);
  let signature: ColorPointSignature;
  try {
    signature = extractColorPointSignature({ pixels: template.bgra, width: template.width, height: template.height });
  } catch (error) {
    if (!(error instanceof UnsupportedColorPointSignatureError)) throw error;
    unsupportedSignatures.add(template.cacheKey);
    while (unsupportedSignatures.size > MAX_SIGNATURES) unsupportedSignatures.delete(unsupportedSignatures.values().next().value!);
    return undefined;
  }
  signatures.set(template.cacheKey, signature);
  templateImages.set(template.cacheKey, { pixels: template.bgra, width: template.width, height: template.height });
  while (signatures.size > MAX_SIGNATURES) {
    const oldest = signatures.keys().next().value!;
    signatures.delete(oldest); templateImages.delete(oldest);
  }
  return signature;
}

if (!parentPort) throw new Error('color vision worker requires a parent port');
parentPort.on('message', (request: Request) => {
  try {
    const unsupportedAssets: string[] = [];
    if (request.type === 'preload') {
      for (const template of request.templates) {
        if (!signatureFor(template)) unsupportedAssets.push(template.asset);
      }
      parentPort!.postMessage({ type: 'result', id: request.id, matches: [], unsupportedAssets });
      return;
    }
    let scene: BgraImage;
    let sceneIndex: ReturnType<typeof createColorPointSceneIndex>;
    if (request.scene.reuse) {
      if (!request.scene.frameKey || cachedScene?.key !== request.scene.frameKey
        || cachedScene.scene.width !== request.scene.width || cachedScene.scene.height !== request.scene.height) {
        throw new Error('color scene cache miss');
      }
      scene = cachedScene.scene;
      sceneIndex = cachedScene.index;
    } else {
      scene = request.scene;
      sceneIndex = createColorPointSceneIndex(scene);
      cachedScene = request.scene.frameKey ? { key: request.scene.frameKey, scene, index: sceneIndex } : undefined;
    }
    const matches = request.templates.flatMap((template) => {
      const signature = signatureFor(template);
      if (!signature) { unsupportedAssets.push(template.asset); return []; }
      const templateImage = templateImages.get(template.cacheKey);
      if (!templateImage) throw new Error(`color template image cache miss: ${template.asset}`);
      // Preserve different scale hypotheses until the local structure pass.
      // Collapsing them here used to retain the colour-strongest scale even
      // when it had the wrong shape.
      const candidates = matchColorPointSignature(scene, signature, {
        threshold: .15,
        scales: request.options.scales,
        maxCandidates: 40,
        maxVerificationCandidates: 96,
        preserveScaleHypotheses: true,
        sceneIndex,
      });
      const ranked = selectStructureProposals(candidates).map((candidate) => ({
        candidate,
        verification: verifyColorPointStructure(scene, templateImage, candidate),
      })).sort((left, right) => right.verification.structureScore - left.verification.structureScore);
      const distinct = ranked.filter((entry, index) => !ranked.slice(0, index)
        .some((stronger) => areColorPointMatchesSameObject(stronger.candidate, entry.candidate)));
      const strongest = distinct[0];
      if (!strongest) return [];
      const structureMargin = strongest.verification.structureScore - (distinct[1]?.verification.structureScore ?? 0);
      const runnerUpColorScore = Math.max(.15, ...distinct.slice(1).map((entry) => entry.candidate.score));
      const colorMargin = Math.max(0, strongest.candidate.score - runnerUpColorScore);
      // A candidate that only just clears both structure gates starts at the
      // normal 90% product threshold. Raw evidence remains alongside this
      // calibrated value so production and authoring can apply the same gate.
      const structureConfidence = Math.min(1, .9 + Math.max(0, structureMargin - MINIMUM_COLOR_STRUCTURE_MARGIN) * 2);
      const confidence = Math.max(strongest.candidate.score, structureConfidence);
      const common = {
        ...strongest.candidate,
        x: strongest.candidate.x + strongest.verification.alignmentX,
        y: strongest.candidate.y + strongest.verification.alignmentY,
        colorRawScore: strongest.candidate.score,
        colorMargin,
        structureScore: strongest.verification.structureScore,
        structureMargin,
        structureVerifyMs: strongest.verification.verifyMs,
        asset: template.asset, algorithm: 'color-points' as const,
      };
      // Diagnostics return every evidence component. The authoring session
      // derives its threshold-compatible display score from those components.
      if (request.options.threshold < 0) return [{
        ...common,
        score: confidence,
      }];
      const decision = evaluateStructuredColorMatch({ ...common, score: confidence }, request.options.threshold);
      if (!decision.accepted) return [];
      return [{ ...common, score: decision.decisionScore }];
    });
    matches.sort((left, right) => right.score - left.score);
    parentPort!.postMessage({
      type: 'result', id: request.id,
      matches: matches.slice(0, request.options.maxCandidates ?? 1),
      unsupportedAssets,
    });
  } catch (error) {
    parentPort!.postMessage({ type: 'error', id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
});

parentPort.postMessage({ type: 'ready' });
