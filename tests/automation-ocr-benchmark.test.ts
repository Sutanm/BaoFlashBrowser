import { describe, expect, it } from 'vitest';
import { benchmarkOcr } from '../src/main/modules/automation/ocr-benchmark';

describe('OCR benchmark harness', () => {
  it('reports text, numeric, latency, memory and failure metrics', async () => {
    const times = [0, 10, 10, 40, 40, 45];
    let memory = 100;
    const result = await benchmarkOcr({
      name: 'fixture',
      recognize: async (frame: string) => {
        memory += 10;
        if (frame === 'failure') throw new Error('fixture failure');
        return frame;
      },
      memoryBytes: () => memory,
    }, [
      { id: 'text', frame: '购买', expectedText: '购买' },
      { id: 'number', frame: '1,280.50', expectedNumber: 1280.5 },
      { id: 'failure', frame: 'failure', expectedText: 'anything' },
    ], { now: () => times.shift() ?? 45 });

    expect(result).toMatchObject({ recognizer: 'fixture', samples: 3, exactTextAccuracy: 0.5, numberAccuracy: 1, peakMemoryBytes: 130 });
    expect(result.latencyMs).toEqual({ p50: 10, p95: 30, mean: 15 });
    expect(result.failures).toEqual([{ sampleId: 'failure', message: 'fixture failure' }]);
  });
});
