import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { Bao1OcrSidecarEngine } from '../src/main/modules/automation/bao1-ocr-sidecar-engine';
import { AutomationTextRecognitionService } from '../src/main/modules/automation/text-recognition-service';
import { createAutomationAbortController } from '../src/shared/automation/abort-controller';

const directory = path.resolve('native/ocr/win32');
const executable = path.join(directory, 'bao-tesseract-ocr-sidecar.exe');
describe.skipIf(process.platform !== 'win32' || !fs.existsSync(executable))('native x86 Tesseract BAO1 runtime', () => {
  it('recognizes Chinese and numbers with usable bounds and confidence, then handles a blank frame', async () => {
    const { data, info } = await sharp(path.resolve('tests/fixtures/tesseract-ui.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let index = 0; index < data.length; index += 4) [data[index], data[index + 2]] = [data[index + 2], data[index]];
    const frame = {
      image: {} as never, bitmap: data, bitmapSize: { width: info.width, height: info.height },
      deviceSize: { width: info.width, height: info.height }, cssSize: { width: info.width, height: info.height },
    };
    const engine = new Bao1OcrSidecarEngine({ executable, cwd: directory });
    const text = new AutomationTextRecognitionService(engine);
    const signal = createAutomationAbortController().signal;
    try {
      expect(await engine.warmup()).toBe(true);
      const items = await text.recognize(frame, signal);
      const match = text.locateRecognized(frame, items, { text: '开始游戏', match: 'contains', minScore: .5 });
      expect(match).not.toBeNull();
      expect(match!.x).toBeGreaterThanOrEqual(0);
      expect(match!.y).toBeGreaterThanOrEqual(0);
      expect(match!.x + match!.width).toBeLessThanOrEqual(info.width);
      expect(match!.y + match!.height).toBeLessThanOrEqual(info.height);
      expect(match!.score).toBeLessThanOrEqual(1);
      expect(await text.readNumber(frame, signal)).toBe(123);
      expect(await text.recognize({ ...frame, bitmap: Buffer.alloc(data.length, 255) }, signal)).toEqual([]);
    } finally { await engine.close(); }
  }, 30_000);
});
