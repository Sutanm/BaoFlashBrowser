import { describe, expect, it, vi } from 'vitest';
import { AUTHORING_BEST_CANDIDATE_THRESHOLD, AutomationVisionService, captureDensityAdjustedScales } from '../src/main/modules/automation/vision-service';
import { AutomationTextRecognitionService } from '../src/main/modules/automation/text-recognition-service';
import type { AutomationCapturedFrame } from '../src/main/modules/automation/capability-contracts';

const frame = {
  frameId: 1,
  image: { isEmpty: () => false, getSize: () => ({ width: 10, height: 10 }), toPNG: () => Buffer.alloc(0), toBitmap: () => Buffer.alloc(400) },
  deviceSize: { width: 10, height: 10 },
  cssSize: { width: 10, height: 10 },
} satisfies AutomationCapturedFrame;

describe('Automation capability services', () => {
  it('selects the strongest image alternative through one vision port', async () => {
    const find = vi.fn(async (asset: string) => asset === 'b' ? { x: 2, y: 2, width: 2, height: 2, score: 0.95 } : { x: 1, y: 1, width: 2, height: 2, score: 0.8 });
    const service = new AutomationVisionService({ find });
    const result = await service.locate(frame, { assets: ['a', 'b'], threshold: 0.7, scales: [1] }, new AbortController().signal);
    expect(result).toMatchObject({ asset: 'b', score: 0.95 });
  });

  it('restores capture-density scaling before matching templates', () => {
    expect(captureDensityAdjustedScales({
      image: {} as never,
      deviceSize: { width: 2560, height: 1440 },
      cssSize: { width: 1280, height: 720 },
    }, [.75, 1, 1.25])).toEqual([1.5, 2, 2.5]);
  });

  it('keeps the best below-threshold image candidate for authoring diagnostics', async () => {
    const find = vi.fn(async () => ({ x: 3, y: 4, width: 2, height: 2, score: 0.42 }));
    const service = new AutomationVisionService({ find });
    const result = await service.locate(frame, {
      assets: ['candidate.png'], threshold: AUTHORING_BEST_CANDIDATE_THRESHOLD, scales: [1],
    }, new AbortController().signal);
    expect(find).toHaveBeenCalledWith('candidate.png', frame, expect.objectContaining({ threshold: -1 }), expect.any(AbortSignal));
    expect(result).toMatchObject({ asset: 'candidate.png', score: 0.42, x: 3, y: 4 });
  });

  it('locates text independently from ReadText and ReadNumber semantics', async () => {
    const recognize = vi.fn(async () => [
      { text: '购买', score: 0.99, box: [[1, 2], [5, 2], [5, 4], [1, 4]] as Array<[number, number]> },
      { text: '1,280.50', score: 0.98, box: [[1, 5], [8, 5], [8, 7], [1, 7]] as Array<[number, number]> },
    ]);
    const service = new AutomationTextRecognitionService({ recognize });
    const signal = new AbortController().signal;
    await expect(service.locate(frame, { text: '购买', match: 'exact', minScore: 0.9 }, signal)).resolves.toMatchObject({ text: '购买', x: 1, y: 2, width: 4, height: 2 });
    await expect(service.readText(frame, signal)).resolves.toBe('购买 1,280.50');
    await expect(service.readNumber(frame, signal)).resolves.toBe(1280.5);
  });

  it('returns the closest below-condition OCR candidate only for authoring diagnostics', async () => {
    const items = [
      { text: '开始游残', score: 0.42, box: [[1, 2], [5, 2], [5, 4], [1, 4]] as Array<[number, number]> },
      { text: '空格键', score: 0.99, box: [[6, 2], [9, 2], [9, 4], [6, 4]] as Array<[number, number]> },
    ];
    const service = new AutomationTextRecognitionService({ recognize: async () => items });
    const request = { text: '开始游戏', match: 'contains' as const, minScore: 0.5 };
    expect(service.locateRecognized(frame, items, request)).toBeNull();
    expect(service.locateBestRecognized(frame, items, request)).toMatchObject({
      text: '开始游残', score: 0.42, matched: false,
    });
  });

  it('marks an authoring OCR candidate green only when text and confidence both pass', () => {
    const item = { text: '开始游戏', score: 0.98, box: [[1, 2], [5, 2], [5, 4], [1, 4]] as Array<[number, number]> };
    const service = new AutomationTextRecognitionService({ recognize: async () => [item] });
    expect(service.locateBestRecognized(frame, [item], { text: '开始游戏', match: 'exact', minScore: 0.9 })).toMatchObject({ matched: true, textSimilarity: 1 });
  });

  it('does not present an unrelated high-confidence OCR observation as the best query candidate', () => {
    const item = { text: '开始游戏', score: 0.99, box: [[1, 2], [5, 2], [5, 4], [1, 4]] as Array<[number, number]> };
    const service = new AutomationTextRecognitionService({ recognize: async () => [item] });
    expect(service.locateBestRecognized(frame, [item], { text: '购买', match: 'contains', minScore: 0.5 })).toBeNull();
  });

  it('rejects ReadNumber when OCR has no numeric value', async () => {
    const service = new AutomationTextRecognitionService({ recognize: async () => [{ text: '无价格', score: 1, box: [[0, 0], [1, 0], [1, 1], [0, 1]] }] });
    await expect(service.readNumber(frame, new AbortController().signal)).rejects.toThrow('does not contain a number');
  });
});
