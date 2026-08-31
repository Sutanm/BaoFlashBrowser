import path from 'path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { createAutomationAbortController } from '../src/shared/automation/abort-controller';
import { bundledPaddleOcrSidecarAvailable, PaddleOcrSidecarEngine } from '../src/main/modules/automation/paddle-ocr-sidecar-engine';

describe.skipIf(!bundledPaddleOcrSidecarAvailable())('bundled Paddle BAO1 runtime', () => {
  it('recognizes a BGRA memory frame without writing a temporary image', async () => {
    const width = 560; const height = 120;
    const fontUrl = `file:///${path.resolve(process.cwd(), 'assets', 'SourceHanSansCN-Regular.otf').replace(/\\/g, '/')}`;
    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><style>@font-face{font-family:SourceHan;src:url('${fontUrl}')}</style><rect width="100%" height="100%" fill="white"/><text x="24" y="82" font-family="SourceHan" font-size="56" fill="black">开始游戏 123</text></svg>`;
    const { data } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let index = 0; index < data.byteLength; index += 4) [data[index], data[index + 2]] = [data[index + 2], data[index]];
    const frame = {
      image: {} as never, bitmap: data, bitmapSize: { width, height },
      deviceSize: { width, height }, cssSize: { width, height },
    };
    const engine = new PaddleOcrSidecarEngine();
    try {
      const text = (await engine.recognize(frame, createAutomationAbortController().signal)).map((item) => item.text).join(' ');
      expect(text).toContain('开始游戏');
      expect(text).toContain('123');
    } finally { await engine.close(); }
  }, 30_000);
});
