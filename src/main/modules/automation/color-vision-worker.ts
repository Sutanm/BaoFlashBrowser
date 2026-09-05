import { parentPort } from 'worker_threads';
import {
  extractColorPointSignature,
  matchColorPointSignature,
  type BgraImage,
  type ColorPointSignature,
} from './color-point-matcher';
import { evaluateColorPointMatches } from './color-point-tracker';

type TemplatePayload = {
  readonly asset: string;
  readonly cacheKey: string;
  readonly width: number;
  readonly height: number;
  readonly bgra?: Uint8Array;
};

type Request = {
  readonly id: number;
  readonly scene: BgraImage;
  readonly templates: readonly TemplatePayload[];
  readonly options: {
    readonly threshold: number;
    readonly scales?: readonly number[];
    readonly maxCandidates?: number;
  };
};

const signatures = new Map<string, ColorPointSignature>();
const MAX_SIGNATURES = 64;

function signatureFor(template: TemplatePayload): ColorPointSignature {
  const cached = signatures.get(template.cacheKey);
  if (cached) {
    signatures.delete(template.cacheKey);
    signatures.set(template.cacheKey, cached);
    return cached;
  }
  if (!template.bgra) throw new Error(`color template cache miss: ${template.asset}`);
  const signature = extractColorPointSignature({ pixels: template.bgra, width: template.width, height: template.height });
  signatures.set(template.cacheKey, signature);
  while (signatures.size > MAX_SIGNATURES) signatures.delete(signatures.keys().next().value!);
  return signature;
}

if (!parentPort) throw new Error('color vision worker requires a parent port');
parentPort.on('message', (request: Request) => {
  try {
    const matches = request.templates.flatMap((template) => {
      // Color composition is intentionally used only for a spatially unique
      // target. Always retain a second independent candidate for the margin
      // check, even when the caller only asks for the strongest match.
      const candidates = matchColorPointSignature(request.scene, signatureFor(template), {
        threshold: request.options.threshold,
        scales: request.options.scales,
        maxCandidates: Math.max(2, request.options.maxCandidates ?? 1),
      });
      const evaluated = evaluateColorPointMatches(candidates, {
        minimumScore: request.options.threshold,
        minimumMargin: .08,
      });
      if (!evaluated.accepted) return [];
      return candidates.map((match) => ({ ...match, asset: template.asset, algorithm: 'color-points' as const }));
    });
    matches.sort((left, right) => right.score - left.score);
    parentPort!.postMessage({ type: 'result', id: request.id, matches: matches.slice(0, request.options.maxCandidates ?? 1) });
  } catch (error) {
    parentPort!.postMessage({ type: 'error', id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
});

parentPort.postMessage({ type: 'ready' });
