import { describe, expect, it } from 'vitest';
import { computeBrowserViewBounds } from '../src/renderer/services/browserview-bounds';

describe('fixed viewport BrowserView bounds', () => {
  it('uses the available area unchanged when the sidebar is closed', () => {
    expect(computeBrowserViewBounds({ x: 0, y: 94, width: 1280, height: 706 }, 0)).toEqual({
      x: 0, y: 94, width: 1280, height: 706,
    });
  });

  it('restores the full viewport width behind the right-side clipping edge', () => {
    expect(computeBrowserViewBounds({ x: 316, y: 94, width: 964, height: 706 }, 316)).toEqual({
      x: 316, y: 94, width: 1280, height: 706,
    });
  });

  it('rounds native bounds and guards empty dimensions', () => {
    expect(computeBrowserViewBounds({ x: 315.6, y: 94.4, width: 0, height: 0 }, 316)).toEqual({
      x: 316, y: 94, width: 316, height: 1,
    });
  });
});
