import { describe, expect, it } from 'vitest';
import { previewRectToSource } from '../src/main/modules/automation/capture-geometry';

describe('automation capture geometry', () => {
  it('maps preview selections back to source pixels', () => {
    expect(previewRectToSource(
      { x: 100, y: 50, width: 200, height: 120 },
      { width: 640, height: 360 },
      { width: 1280, height: 720 },
    )).toEqual({ x: 200, y: 100, width: 400, height: 240 });
  });

  it('rounds outward and keeps the crop inside the source', () => {
    expect(previewRectToSource(
      { x: 898, y: 558, width: 2, height: 2 },
      { width: 900, height: 560 },
      { width: 1920, height: 1080 },
    )).toEqual({ x: 1915, y: 1076, width: 5, height: 4 });
  });

  it('rejects invalid or out-of-bounds selections', () => {
    expect(() => previewRectToSource(
      { x: 90, y: 90, width: 20, height: 20 },
      { width: 100, height: 100 },
      { width: 200, height: 200 },
    )).toThrow(/outside/);
  });
});
