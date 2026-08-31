import path from 'path';
import { describe, expect, it } from 'vitest';
import { createAutomationAbortController } from '../src/shared/automation/abort-controller';
import { Bao1OcrSidecarEngine } from '../src/main/modules/automation/bao1-ocr-sidecar-engine';

const fixture = path.resolve(process.cwd(), 'tests', 'fixtures', 'fake-bao1-ocr-sidecar.cjs');
const frame = {
  image: { isEmpty: () => false, getSize: () => ({ width: 2, height: 1 }), toPNG: () => Buffer.alloc(0), toBitmap: () => Buffer.alloc(8) },
  bitmap: Buffer.from([7, 0, 0, 255, 8, 0, 0, 255]), bitmapSize: { width: 2, height: 1 },
  deviceSize: { width: 2, height: 1 }, cssSize: { width: 2, height: 1 },
};

describe('BAO1 OCR Sidecar protocol', () => {
  it('sends an in-memory BGRA frame and validates OCR items', async () => {
    const engine = new Bao1OcrSidecarEngine({ executable: process.execPath, args: [fixture] }, 2_000, 2_000);
    try {
      await expect(engine.recognize(frame, createAutomationAbortController().signal)).resolves.toEqual([
        { text: '像素7', score: 0.98, box: [[1, 2], [31, 2], [31, 18], [1, 18]] },
      ]);
    } finally { await engine.close(); }
  });

  it('rejects invalid response shapes instead of leaking them into Automation Core', async () => {
    const engine = new Bao1OcrSidecarEngine({ executable: process.execPath, args: [fixture, 'bad'] }, 2_000, 2_000);
    try { await expect(engine.recognize(frame, createAutomationAbortController().signal)).rejects.toThrow('invalid response'); }
    finally { await engine.close(); }
  });

  it('kills a timed-out process and releases the serialized request queue', async () => {
    const engine = new Bao1OcrSidecarEngine({ executable: process.execPath, args: [fixture, 'timeout'] }, 30, 2_000);
    try {
      await expect(engine.recognize(frame, createAutomationAbortController().signal)).rejects.toThrow('timed out');
      await expect(engine.recognize(frame, createAutomationAbortController().signal)).rejects.toThrow('timed out');
    } finally { await engine.close(); }
  });

  it('terminates promptly when an automation run is cancelled', async () => {
    const engine = new Bao1OcrSidecarEngine({ executable: process.execPath, args: [fixture, 'timeout'] }, 2_000, 2_000);
    const controller = createAutomationAbortController();
    const result = engine.recognize(frame, controller.signal);
    setTimeout(() => controller.abort(), 20);
    try { await expect(result).rejects.toThrow('automation cancelled'); }
    finally { await engine.close(); }
  });
});
