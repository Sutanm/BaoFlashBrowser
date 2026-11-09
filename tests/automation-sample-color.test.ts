import { describe, expect, it, vi } from 'vitest';
import { sampleRegionColor, type RegionChangeSample } from '../src/main/modules/automation/region-change-detector';
import { JavaScriptAutomationCapabilityBroker } from '../src/main/modules/automation/javascript-capability-broker';

function sample(values: readonly number[]): RegionChangeSample {
  const bitmap = new Uint8Array(values.length * 4);
  values.forEach((value, index) => {
    bitmap[index * 4] = value;
    bitmap[index * 4 + 1] = value;
    bitmap[index * 4 + 2] = value;
    bitmap[index * 4 + 3] = 255;
  });
  return { bitmap, width: values.length, height: 1, captureMs: 3 };
}

const colors = [{ red: 200, green: 200, blue: 200 }];
const signal = new AbortController().signal;

describe('sampleRegionColor', () => {
  it('只抓一帧，即使没命中也不轮询', async () => {
    const capture = vi.fn(async () => sample([0, 0, 0]));
    const result = await sampleRegionColor({ colors, tolerance: 10, minimumMatchingPixels: 1 }, { capture }, signal);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ found: false, matchingPixels: 0, samples: 1 });
  });

  it('命中时返回像素数与包围盒', async () => {
    const capture = vi.fn(async () => sample([0, 200, 200, 0]));
    const result = await sampleRegionColor({ colors, tolerance: 10, minimumMatchingPixels: 2 }, { capture }, signal);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(result.found).toBe(true);
    expect(result.matchingPixels).toBe(2);
    expect(result.matchBounds).toEqual({ x: 1 / 4, y: 0, width: 2 / 4, height: 1 });
  });

  it('像素数不够 minimumMatchingPixels 时 found 为 false，但像素数仍返回', async () => {
    const capture = async () => sample([200, 0, 0]);
    const result = await sampleRegionColor({ colors, tolerance: 10, minimumMatchingPixels: 5 }, { capture }, signal);
    expect(result.found).toBe(false);
    expect(result.matchingPixels).toBe(1);
  });

  it('容差之外不算命中', async () => {
    const capture = async () => sample([150, 150, 150]);
    const result = await sampleRegionColor({ colors, tolerance: 10, minimumMatchingPixels: 1 }, { capture }, signal);
    expect(result.matchingPixels).toBe(0);
  });

  it('已中止的信号直接抛错，且不抓帧', async () => {
    const capture = vi.fn(async () => sample([200]));
    await expect(sampleRegionColor({ colors, tolerance: 10, minimumMatchingPixels: 1 }, { capture }, AbortSignal.abort()))
      .rejects.toThrow();
    expect(capture).not.toHaveBeenCalled();
  });
});

describe('broker: vision.sampleColor', () => {
  const region = { kind: 'rect', unit: 'logical', space: 'viewport', x: 0, y: 0, width: 10, height: 10 } as never;

  function broker(ports: Record<string, unknown>, grants: string[] = ['vision']) {
    return new JavaScriptAutomationCapabilityBroker(
      'token',
      new Set(grants as never[]),
      ports as never,
      { maxCalls: 100, maxConcurrentCalls: 4 },
    );
  }

  it('没有 vision 授权时拒绝', async () => {
    const response = await broker({}, []).handle({ requestId: '1', runToken: 'token', method: 'vision.sampleColor', params: { region, colors: ['#ffffff'] } } as never);
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.error.code).toBe('PERMISSION_DENIED');
  });

  it('颜色格式非法时拒绝', async () => {
    const response = await broker({}).handle({ requestId: '2', runToken: 'token', method: 'vision.sampleColor', params: { region, colors: ['nope'] } } as never);
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.error.code).toBe('PAYLOAD_INVALID');
  });

  it('合法请求转发到端口并原样返回结果', async () => {
    const sampleColor = vi.fn(async () => ({ found: true, matchingPixels: 7, totalPixels: 100, matchingRatio: .07, maxMatchingPixels: 7, maxMatchingRatio: .07, samples: 1, elapsedMs: 4, captureMs: 3 }));
    const response = await broker({ 'vision.sampleColor': sampleColor }).handle({
      requestId: '3', runToken: 'token', method: 'vision.sampleColor',
      params: { region, colors: ['#c8c8c8'], tolerance: 20, minimumMatchingPixels: 2 },
    } as never);
    expect(response.ok).toBe(true);
    expect(sampleColor).toHaveBeenCalledWith(
      expect.objectContaining({ tolerance: 20, minimumMatchingPixels: 2 }),
      expect.anything(),
    );
    expect(response.ok === true && response.value).toMatchObject({ matchingPixels: 7, samples: 1 });
  });
});


