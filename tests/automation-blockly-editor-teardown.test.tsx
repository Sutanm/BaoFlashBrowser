// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The teardown guard extracted from the Automation 2.0 Blockly editor.
 *
 * The original defect — "Cannot read property 'FULL_BLOCK_FIELDS' of null" in
 * the renderer console log — needs a field re-measure that jsdom cannot perform
 * (Blockly measures text through `HTMLCanvasElement.getContext("2d")`, which
 * jsdom does not implement), so the mounted-editor symptom is not reproducible
 * in this environment. This suite pins the teardown CONTRACT instead: after
 * cleanup nothing may touch the workspace again, and the workspace reference
 * must be cleared before disposal.
 *
 * The module under test needs only these three Blockly entry points, so they are
 * faked here. Keeping the guard in its own module is what makes this safe: the
 * block schema (whose custom field extends `Blockly.Field`) stays out of this
 * import graph.
 */
const svgResize = vi.fn();
const workspaceToDom = vi.fn(() => ({}));
const domToText = vi.fn(() => '<xml/>');

vi.mock('blockly', () => ({
  svgResize: (...args: unknown[]) => svgResize(...args),
  Xml: {
    workspaceToDom: (...args: unknown[]) => workspaceToDom(...args),
    domToText: (...args: unknown[]) => domToText(...args),
  },
  Events: { FINISHED_LOADING: 'finished_loading' },
}));

import { automateTeardown } from '../src/renderer/components/automation/automation-blockly-teardown';
const observers: FakeResizeObserver[] = [];
class FakeResizeObserver {
  constructor(readonly callback: () => void) { observers.push(this); }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  /** Re-deliver the callback the way a queued frame would. */
  deliver(): void { this.callback(); }
}

interface FakeWorkspace {
  listeners: Array<(event: unknown) => void>;
  addChangeListener(fn: (event: unknown) => void): void;
  removeChangeListener(fn: (event: unknown) => void): void;
  dispose(): void;
}

function makeWorkspace(): FakeWorkspace {
  const listeners: Array<(event: unknown) => void> = [];
  return {
    listeners,
    addChangeListener: (fn) => { listeners.push(fn); },
    removeChangeListener: (fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    dispose: vi.fn(),
  };
}

function wire(overrides: { onDirtyChange?: (dirty: boolean) => void } = {}) {
  const workspace = makeWorkspace();
  const toolboxObserver = { disconnect: vi.fn() };
  const clearWorkspaceRef = vi.fn();
  const cleanup = automateTeardown(
    workspace as never,
    document.createElement('div'),
    toolboxObserver,
    'draft-key',
    overrides.onDirtyChange,
    clearWorkspaceRef,
  );
  return { workspace, toolboxObserver, clearWorkspaceRef, cleanup };
}

describe('automateTeardown', () => {
  beforeEach(() => {
    observers.length = 0;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
    localStorage.clear();
    svgResize.mockClear();
    workspaceToDom.mockClear().mockReturnValue({});
    domToText.mockClear().mockReturnValue('<xml/>');
  });

  afterEach(() => vi.restoreAllMocks());

  it('persists a real edit and reports it dirty while mounted', () => {
    const onDirtyChange = vi.fn();
    const { workspace } = wire({ onDirtyChange });

    workspace.listeners.forEach((listener) => listener({ isUiEvent: false, type: 'change' }));

    expect(workspaceToDom).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('draft-key')).toBe('<xml/>');
    expect(onDirtyChange).toHaveBeenCalledWith(true);
  });

  it('resizes the workspace while it is still mounted', () => {
    wire();
    expect(observers).toHaveLength(1);

    observers[0].deliver();

    expect(svgResize).toHaveBeenCalledTimes(1);
  });

  it('ignores a resize callback delivered after cleanup', () => {
    const { cleanup } = wire();
    cleanup();

    // The callback was queued before cleanup and is delivered afterwards; the
    // real bug threw "FULL_BLOCK_FIELDS of null" at this exact point.
    expect(() => { observers.forEach((observer) => observer.deliver()); }).not.toThrow();
    expect(svgResize).not.toHaveBeenCalled();
  });

  it('does not serialize the workspace after cleanup', () => {
    const { workspace, cleanup } = wire();
    workspace.listeners.forEach((listener) => listener({ isUiEvent: false, type: 'change' }));
    expect(workspaceToDom).toHaveBeenCalledTimes(1);

    cleanup();
    workspaceToDom.mockClear();
    // The real listener was already removed, so drive any surviving listener the
    // same way the editor's own callback would have been if it had not.
    workspace.listeners.forEach((listener) => listener({ isUiEvent: false, type: 'change' }));

    expect(workspaceToDom).not.toHaveBeenCalled();
  });

  it('disconnects the observer, detaches the listener, clears the ref, then disposes', () => {
    const { workspace, toolboxObserver, clearWorkspaceRef, cleanup } = wire();
    const order: string[] = [];
    toolboxObserver.disconnect.mockImplementation(() => order.push('toolbox'));
    clearWorkspaceRef.mockImplementation(() => order.push('ref'));
    (workspace as { dispose: () => void }).dispose = vi.fn(() => { order.push('dispose'); });

    cleanup();

    expect(toolboxObserver.disconnect).toHaveBeenCalledTimes(1);
    expect(workspace.listeners).toHaveLength(0);
    expect(clearWorkspaceRef).toHaveBeenCalledTimes(1);
    expect(workspace.dispose).toHaveBeenCalledTimes(1);
    // The ref must be cleared before disposal so nothing reaches a half-disposed workspace.
    expect(order).toEqual(['toolbox', 'ref', 'dispose']);
  });

  it('ignores UI events and the finished-loading event', () => {
    const onDirtyChange = vi.fn();
    const { workspace } = wire({ onDirtyChange });

    workspace.listeners.forEach((listener) => listener({ isUiEvent: true, type: 'change' }));
    workspace.listeners.forEach((listener) => listener({ isUiEvent: false, type: 'finished_loading' }));

    expect(workspaceToDom).not.toHaveBeenCalled();
    expect(localStorage.getItem('draft-key')).toBeNull();
    expect(onDirtyChange).not.toHaveBeenCalled();
  });
});