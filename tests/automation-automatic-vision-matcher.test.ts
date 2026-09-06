import { describe, expect, it, vi } from 'vitest';
import { AutomaticVisionMatcher } from '../src/main/modules/automation/automatic-vision-matcher';
import type { AutomationCapturedFrame, AutomationVisionMatcher } from '../src/main/modules/automation/capability-contracts';
import type { ColorPointWorkerMatcher } from '../src/main/modules/automation/color-vision-worker-matcher';

const frame = {
  frameId: 1,
  image: { isEmpty: () => false, getSize: () => ({ width: 20, height: 20 }), toPNG: () => Buffer.alloc(0), toBitmap: () => Buffer.alloc(1600) },
  deviceSize: { width: 20, height: 20 }, cssSize: { width: 20, height: 20 },
} satisfies AutomationCapturedFrame;

function colorMatcher(findManyCandidatesWithSupport: ReturnType<typeof vi.fn>) {
  return {
    find: vi.fn(), findManyCandidatesWithSupport, getStats: vi.fn(() => ({})),
  } as unknown as ColorPointWorkerMatcher;
}

describe('AutomaticVisionMatcher', () => {
  it('keeps accepted color hits and routes only unsupported image-group members to OpenCV', async () => {
    const templateFind = vi.fn(async (assets: string[]) => assets.map((asset, index) => (
      { asset, x: asset === 'plain.png' ? 12 : 3, y: index + 4, width: 2, height: 2, score: .96 }
    )));
    const template = { find: vi.fn(), findManyCandidates: templateFind } satisfies AutomationVisionMatcher;
    const colorFind = vi.fn(async () => ({
      matches: [{ asset: 'pixel.png', x: 3, y: 8, width: 2, height: 2, score: .99, algorithm: 'color-points' as const }],
      unsupportedAssets: ['plain.png'],
    }));
    const router = new AutomaticVisionMatcher(template, colorMatcher(colorFind));

    const result = await router.findManyCandidates(
      ['pixel.png', 'plain.png'], frame, { threshold: .9, maxCandidates: 2 }, new AbortController().signal,
    );

    expect(colorFind).toHaveBeenCalledWith(['pixel.png', 'plain.png'], frame, expect.objectContaining({ threshold: .9 }), expect.any(AbortSignal));
    expect(templateFind).toHaveBeenCalledTimes(1);
    expect(templateFind).toHaveBeenCalledWith(['plain.png'], frame, expect.objectContaining({ maxCandidates: 1 }), expect.any(AbortSignal));
    expect(result.map((item) => item.asset)).toEqual(['plain.png', 'pixel.png']);
  });

  it('does not turn a supported color miss into an OpenCV false positive', async () => {
    const templateFind = vi.fn(async () => [{ asset: 'target.png', x: 1, y: 1, width: 2, height: 2, score: .99 }]);
    const template = { find: vi.fn(), findManyCandidates: templateFind } satisfies AutomationVisionMatcher;
    const router = new AutomaticVisionMatcher(template, colorMatcher(vi.fn(async () => ({ matches: [], unsupportedAssets: [] }))));

    await expect(router.findManyCandidates(
      ['target.png'], frame, { threshold: .9 }, new AbortController().signal,
    )).resolves.toEqual([]);
    expect(templateFind).not.toHaveBeenCalled();
  });

  it('does not let an OpenCV false candidate override a correct color hit', async () => {
    const templateFind = vi.fn(async () => [
      { asset: 'target.png', x: 15, y: 15, width: 2, height: 2, score: .999 },
    ]);
    const template = { find: vi.fn(), findManyCandidates: templateFind } satisfies AutomationVisionMatcher;
    const router = new AutomaticVisionMatcher(template, colorMatcher(vi.fn(async () => ({
      matches: [{ asset: 'target.png', x: 2, y: 3, width: 2, height: 2, score: .98 }],
      unsupportedAssets: [],
    }))));

    await expect(router.findManyCandidates(
      ['target.png'], frame, { threshold: .9, maxCandidates: 1 }, new AbortController().signal,
    )).resolves.toEqual([
      { asset: 'target.png', x: 2, y: 3, width: 2, height: 2, score: .98 },
    ]);
    expect(templateFind).not.toHaveBeenCalled();
  });

  it('does not hide color worker failures behind an OpenCV fallback', async () => {
    const templateFind = vi.fn();
    const template = { find: vi.fn(), findManyCandidates: templateFind } satisfies AutomationVisionMatcher;
    const router = new AutomaticVisionMatcher(
      template,
      colorMatcher(vi.fn(async () => { throw new Error('color matching timed out'); })),
    );

    await expect(router.findManyCandidates(
      ['target.png'], frame, { threshold: .9 }, new AbortController().signal,
    )).rejects.toThrow('color matching timed out');
    expect(templateFind).not.toHaveBeenCalled();
  });

  it('keeps authoring strongest-candidate diagnostics on the automatic backend', async () => {
    const candidate = { asset: 'target.png', x: 4, y: 5, width: 2, height: 2, score: .41, algorithm: 'color-points' as const };
    const templateFind = vi.fn(async () => [candidate]);
    const template = { find: vi.fn(), findManyCandidates: templateFind } satisfies AutomationVisionMatcher;
    const colorFind = vi.fn(async () => ({ matches: [candidate], unsupportedAssets: [] }));
    const router = new AutomaticVisionMatcher(template, colorMatcher(colorFind));

    await expect(router.findManyCandidates(
      ['target.png'], frame, { threshold: -1 }, new AbortController().signal,
    )).resolves.toEqual([candidate]);
    expect(colorFind).toHaveBeenCalledOnce();
    expect(templateFind).not.toHaveBeenCalled();
  });

  it('honors cancellation before dispatching either backend', async () => {
    const templateFind = vi.fn();
    const template = { find: vi.fn(), findManyCandidates: templateFind } satisfies AutomationVisionMatcher;
    const colorFind = vi.fn();
    const router = new AutomaticVisionMatcher(template, colorMatcher(colorFind));
    const controller = new AbortController(); controller.abort();

    await expect(router.findManyCandidates(['target.png'], frame, { threshold: .9 }, controller.signal))
      .rejects.toThrow('automation cancelled');
    expect(colorFind).not.toHaveBeenCalled(); expect(templateFind).not.toHaveBeenCalled();
  });
});
