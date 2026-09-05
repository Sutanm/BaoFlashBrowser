import path from 'path';
import { ColorPointWorkerMatcher } from '../../src/main/modules/automation/color-vision-worker-matcher';
import type { AutomationCapturedFrame } from '../../src/main/modules/automation/capability-contracts';
import type { AutomationTemplatePixels } from '../../src/main/modules/automation/vision-worker-matcher';

function image(width: number, height: number, color: [number, number, number, number]): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) pixels.set(color, offset);
  return pixels;
}

function paint(pixels: Uint8Array, imageWidth: number, x: number, y: number, width: number, height: number, color: [number, number, number, number]) {
  for (let row = 0; row < height; row += 1) for (let column = 0; column < width; column += 1) {
    pixels.set(color, ((y + row) * imageWidth + x + column) * 4);
  }
}

async function main() {
  const template = image(12, 10, [0, 0, 0, 0]);
  paint(template, 12, 2, 2, 8, 6, [40, 70, 210, 255]);
  paint(template, 12, 6, 3, 4, 3, [180, 30, 240, 255]);
  const scene = image(120, 80, [10, 15, 20, 255]);
  paint(scene, 120, 40, 30, 8, 6, [40, 70, 210, 255]);
  paint(scene, 120, 44, 31, 4, 3, [180, 30, 240, 255]);
  const provider = {
    async load(): Promise<AutomationTemplatePixels> {
      return { cacheKey: 'synthetic-v1', width: 12, height: 10, bgra: template };
    },
  };
  const matcher = new ColorPointWorkerMatcher(provider, {
    workerPath: path.join(__dirname, 'color-vision-worker.cjs'), requestTimeoutMs: 5_000,
  });
  const frame: AutomationCapturedFrame = {
    frameId: 1,
    image: { isEmpty: () => false, getSize: () => ({ width: 120, height: 80 }), toPNG: () => Buffer.alloc(0), toBitmap: () => Buffer.from(scene) },
    bitmap: Buffer.from(scene), bitmapSize: { width: 120, height: 80 },
    deviceSize: { width: 120, height: 80 }, cssSize: { width: 120, height: 80 },
  };
  try {
    const signal = new AbortController().signal;
    const first = await matcher.findCandidates('target.png', frame, { threshold: .9, scales: [1], maxCandidates: 2 }, signal);
    const second = await matcher.findCandidates('target.png', frame, { threshold: .9, scales: [1], maxCandidates: 2, region: { x: 30, y: 20, width: 40, height: 30 } }, signal);
    if (first[0]?.x !== 40 || first[0]?.y !== 30 || second[0]?.x !== 40 || second[0]?.y !== 30) {
      throw new Error(`unexpected color worker result: ${JSON.stringify({ first, second })}`);
    }
    const ambiguousScene = Uint8Array.from(scene);
    paint(ambiguousScene, 120, 80, 50, 8, 6, [40, 70, 210, 255]);
    paint(ambiguousScene, 120, 84, 51, 4, 3, [180, 30, 240, 255]);
    const ambiguous = await matcher.findCandidates('target.png', {
      ...frame, frameId: 2, bitmap: Buffer.from(ambiguousScene),
      image: { ...frame.image, toBitmap: () => Buffer.from(ambiguousScene) },
    }, { threshold: .9, scales: [1], maxCandidates: 1 }, signal);
    if (ambiguous.length !== 0) throw new Error(`ambiguous color target was accepted: ${JSON.stringify(ambiguous)}`);
    console.log(JSON.stringify({ passed: true, full: first[0], region: second[0], ambiguousRejected: true }, null, 2));
  } finally {
    await matcher.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
