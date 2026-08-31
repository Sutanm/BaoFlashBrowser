import { describe, expect, it, vi } from 'vitest';
import { BrowserViewCaptureService } from '../src/main/modules/automation/browserview-capture-service';
import { captureFrameGeometry, frameId } from '../src/shared/automation/core/frame-geometry';
import { generation, region, targetId, viewportSpace } from '../src/shared/automation/core/geometry';

const space = viewportSpace({
  targetId: targetId('capture-test'),
  targetGeneration: generation(1),
  viewportGeneration: generation(1),
});

function image(width: number, height: number, resize = true) {
  const value = {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toPNG: () => Buffer.alloc(0),
    toBitmap: () => Buffer.alloc(width * height * 4),
  };
  return resize ? {
    ...value,
    resize: ({ width: nextWidth, height: nextHeight }: { width: number; height: number }) => image(nextWidth, nextHeight, false),
  } : value;
}

function service(sourceImage = image(200, 100)) {
  const source = {
    incrementCapturerCount: vi.fn(),
    decrementCapturerCount: vi.fn(),
    capturePage: vi.fn(async () => sourceImage),
  };
  const capture = new BrowserViewCaptureService(source, {
    frameGeometry: (value, bitmapSize, logicalRegion) => captureFrameGeometry({
      frameId: frameId(value),
      space,
      capturedRegion: region('logical', space,
        logicalRegion?.x ?? 0, logicalRegion?.y ?? 0,
        logicalRegion?.width ?? 100, logicalRegion?.height ?? 50),
      bitmapSize,
    }),
  });
  return { capture, source };
}

describe('BrowserViewCaptureService', () => {
  it('normalizes a capture and binds immutable frame geometry', async () => {
    const { capture, source } = service();
    const frame = await capture.capture({ logicalViewportSize: { width: 100, height: 50 } });
    expect(source.incrementCapturerCount).toHaveBeenCalledWith({ width: 100, height: 50 });
    expect(frame.bitmapSize).toEqual({ width: 100, height: 50 });
    expect(frame.geometry?.capturedRegion).toMatchObject({ x: 0, y: 0, width: 100, height: 50 });
  });

  it('captures the mapped display rectangle and normalizes it to the logical region', async () => {
    const { capture, source } = service(image(380, 75));
    const frame = await capture.capture({
      logicalViewportSize: { width: 1280, height: 720 },
      displayViewportSize: { width: 1920, height: 1080 },
      logicalRegion: { x: 100, y: 50, width: 760, height: 150 },
      displayRegion: { x: 150, y: 75, width: 1140, height: 225 },
    });
    expect(source.capturePage).toHaveBeenCalledWith({ x: 150, y: 75, width: 1140, height: 225 });
    expect(source.incrementCapturerCount).toHaveBeenCalledWith({ width: 760, height: 150 });
    expect(frame.bitmapSize).toEqual({ width: 760, height: 150 });
    expect(frame.geometry?.capturedRegion).toMatchObject({ x: 100, y: 50, width: 760, height: 150 });
  });

  it('reuses one frame for equal regions inside a fresh-frame scope', async () => {
    const { capture, source } = service(image(100, 50));
    await capture.withFreshFrame(async () => {
      const first = await capture.capture({ logicalViewportSize: { width: 100, height: 50 } });
      const second = await capture.capture({ logicalViewportSize: { width: 100, height: 50 } });
      expect(second).toBe(first);
    });
    expect(source.capturePage).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a frame across operation scopes', async () => {
    const { capture, source } = service(image(100, 50));
    await capture.withFreshFrame(() => capture.capture({ logicalViewportSize: { width: 100, height: 50 } }));
    await capture.withFreshFrame(() => capture.capture({ logicalViewportSize: { width: 100, height: 50 } }));
    expect(source.capturePage).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent captures inside one explicit operation scope', async () => {
    const { capture, source } = service(image(100, 50));
    const scope = {};
    const [first, second] = await Promise.all([
      capture.capture({ logicalViewportSize: { width: 100, height: 50 }, scope }),
      capture.capture({ logicalViewportSize: { width: 100, height: 50 }, scope }),
    ]);
    expect(second).toBe(first);
    expect(source.capturePage).toHaveBeenCalledTimes(1);
  });

  it('keeps simultaneous explicit operation scopes isolated', async () => {
    const { capture, source } = service(image(100, 50));
    await Promise.all([
      capture.capture({ logicalViewportSize: { width: 100, height: 50 }, scope: {} }),
      capture.capture({ logicalViewportSize: { width: 100, height: 50 }, scope: {} }),
    ]);
    expect(source.capturePage).toHaveBeenCalledTimes(2);
  });

  it('always balances the capturer count when capture fails', async () => {
    const { capture, source } = service({ ...image(1, 1), isEmpty: () => true });
    await expect(capture.capture({ logicalViewportSize: { width: 1, height: 1 } })).rejects.toThrow('empty');
    expect(source.incrementCapturerCount).toHaveBeenCalledTimes(1);
    expect(source.decrementCapturerCount).toHaveBeenCalledTimes(1);
  });
});
