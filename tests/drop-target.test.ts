import { describe, expect, it } from 'vitest';
import { resolveDropTarget } from '../src/main/utils/drop-target';

const winA = { id: 1, bounds: { x: 0, y: 0, width: 800, height: 600 } };
const winB = { id: 2, bounds: { x: 900, y: 0, width: 800, height: 600 } };

describe('drag drop target (P7)', () => {
  it('hits the window under the cursor', () => {
    expect(resolveDropTarget({ x: 100, y: 100 }, [winA, winB])).toEqual({ kind: 'window', id: 1 });
    expect(resolveDropTarget({ x: 1000, y: 100 }, [winA, winB])).toEqual({ kind: 'window', id: 2 });
  });

  it('treats the window edge as exclusive for the neighbour', () => {
    expect(resolveDropTarget({ x: 900, y: 10 }, [winA, winB])).toEqual({ kind: 'window', id: 2 });
    expect(resolveDropTarget({ x: 1700, y: 10 }, [winA, winB])).toEqual({ kind: 'new-window' });
  });

  it('drops outside every window as a tear-off', () => {
    expect(resolveDropTarget({ x: 2000, y: 100 }, [winA, winB])).toEqual({ kind: 'new-window' });
  });

  it('rejects points outside the virtual desktop', () => {
    expect(resolveDropTarget({ x: -5, y: 10 }, [winA])).toEqual({ kind: 'none' });
    expect(resolveDropTarget({ x: 10, y: -5 }, [winA])).toEqual({ kind: 'none' });
  });
});
