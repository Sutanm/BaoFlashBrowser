import { createAutomationAbortController } from '../../../shared/automation/abort-controller';

export type OcrBenchmarkSample<Frame> = {
  readonly id: string;
  readonly frame: Frame;
  readonly expectedText?: string;
  readonly expectedNumber?: number;
};

export type OcrBenchmarkRecognizer<Frame> = {
  readonly name: string;
  recognize(frame: Frame, signal: AbortSignal): Promise<string>;
  memoryBytes?(): number | undefined;
};

export type OcrBenchmarkResult = {
  readonly recognizer: string;
  readonly samples: number;
  readonly exactTextAccuracy: number | null;
  readonly normalizedEditSimilarity: number | null;
  readonly numberAccuracy: number | null;
  readonly latencyMs: { readonly p50: number; readonly p95: number; readonly mean: number };
  readonly peakMemoryBytes: number | null;
  readonly failures: ReadonlyArray<{ readonly sampleId: string; readonly message: string }>;
};

function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase();
}

function editDistance(first: string, second: string): number {
  const previous = Array.from({ length: second.length + 1 }, (_, index) => index);
  for (let i = 1; i <= first.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= second.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (first[i - 1] === second[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[second.length];
}

function parseNumber(value: string): number | null {
  const candidate = value.replace(/[,，\s]/g, '').match(/[-+]?\d+(?:\.\d+)?/u)?.[0];
  if (!candidate) return null;
  const parsed = Number(candidate);
  return Number.isFinite(parsed) ? parsed : null;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

/** Provider-neutral harness used before any OCR default/model switch. */
export async function benchmarkOcr<Frame>(
  recognizer: OcrBenchmarkRecognizer<Frame>,
  samples: readonly OcrBenchmarkSample<Frame>[],
  options: { readonly now?: () => number; readonly signal?: AbortSignal } = {},
): Promise<OcrBenchmarkResult> {
  const now = options.now ?? Date.now;
  const signal = options.signal ?? createAutomationAbortController().signal;
  const latencies: number[] = [];
  const exactScores: number[] = [];
  const similarities: number[] = [];
  const numberScores: number[] = [];
  const failures: Array<{ sampleId: string; message: string }> = [];
  let peakMemory = recognizer.memoryBytes?.() ?? null;

  for (const sample of samples) {
    if (signal.aborted) throw new Error('OCR benchmark cancelled');
    const startedAt = now();
    try {
      const actual = await recognizer.recognize(sample.frame, signal);
      latencies.push(now() - startedAt);
      const memory = recognizer.memoryBytes?.();
      if (memory !== undefined) peakMemory = Math.max(peakMemory ?? 0, memory);
      if (sample.expectedText !== undefined) {
        const expected = normalizeText(sample.expectedText);
        const received = normalizeText(actual);
        exactScores.push(received === expected ? 1 : 0);
        similarities.push(1 - editDistance(received, expected) / Math.max(1, received.length, expected.length));
      }
      if (sample.expectedNumber !== undefined) {
        numberScores.push(parseNumber(actual) === sample.expectedNumber ? 1 : 0);
      }
    } catch (error) {
      latencies.push(now() - startedAt);
      const memory = recognizer.memoryBytes?.();
      if (memory !== undefined) peakMemory = Math.max(peakMemory ?? 0, memory);
      failures.push({ sampleId: sample.id, message: error instanceof Error ? error.message : String(error) });
      if (sample.expectedText !== undefined) { exactScores.push(0); similarities.push(0); }
      if (sample.expectedNumber !== undefined) numberScores.push(0);
    }
  }

  const mean = (values: readonly number[]): number | null => values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    recognizer: recognizer.name,
    samples: samples.length,
    exactTextAccuracy: mean(exactScores),
    normalizedEditSimilarity: mean(similarities),
    numberAccuracy: mean(numberScores),
    latencyMs: { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), mean: mean(latencies) ?? 0 },
    peakMemoryBytes: peakMemory,
    failures,
  };
}
