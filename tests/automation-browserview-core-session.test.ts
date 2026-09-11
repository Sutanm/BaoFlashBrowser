import { describe, expect, it, vi } from 'vitest';
import type { AutomationPackageV3 } from '../src/shared/automation/package-v3';

// `visual` surfaces fall back to DOM game-surface detection; stub both entry
// points so the retry / not-found paths are deterministic and need no BrowserView.
vi.mock('../src/main/modules/automation/game-surface-detector', () => ({
  detectGameSurfaces: vi.fn(async () => []),
  chooseLocatedGameSurface: vi.fn(() => undefined),
}));

import { BrowserViewAutomationCoreSession } from '../src/main/modules/automation/browserview-core-session';

function capturedImage(width: number, height: number) {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toPNG: () => Buffer.alloc(0),
    toBitmap: () => Buffer.alloc(width * height * 4),
  };
}

function source(overrides: Partial<AutomationPackageV3> = {}): AutomationPackageV3 {
  return {
    manifest: {
      format: 'baoauto', formatVersion: 3, id: 'commit-test', name: 'Commit test',
      frontends: { workflow: 'workflow.json', scripts: [], mainEntryId: 'workflow' }, features: [], integrity: {},
    },
    workflow: { formatVersion: 3, id: 'commit-test', name: 'Commit test', root: { id: 'root', kind: 'sequence', nodes: [] } },
    scripts: new Map(), assets: new Map(), profiles: new Map(),
    ...overrides,
  };
}

/**
 * The automation capture path guards against a viewport change landing between
 * the revision read and the frame capture: a frame captured under a different
 * transform must never be handed to recognition. The existing suite only covers
 * the recoverable case (one retry succeeds); these pin the terminal cases.
 */
function makeSession(options: {
  revision: () => number;
  transform: () => { scaleX: number; scaleY: number };
  capturePage: () => Promise<unknown>;
  retries?: number;
  profile?: Parameters<typeof BrowserViewAutomationCoreSession>[2];
}) {
  const handle = {
    tabId: 'tab-commit',
    webContents: {
      incrementCapturerCount: vi.fn(),
      decrementCapturerCount: vi.fn(),
      capturePage: vi.fn(async () => options.capturePage()),
    },
    getCssViewport: () => ({ width: 1280, height: 720 }),
    getViewportTransform: () => {
      const { scaleX, scaleY } = options.transform();
      return { logicalSize: { width: 1280, height: 720 }, displaySize: { width: 1280 * scaleX, height: 720 * scaleY }, scaleX, scaleY };
    },
    getViewportRevision: options.revision,
    assertCurrent: vi.fn(),
    waitForViewport: vi.fn(async () => undefined),
    release: vi.fn(),
  };
  const session = new BrowserViewAutomationCoreSession(
    handle as never,
    source(),
    options.profile,
    undefined,
    undefined,
    { matcher: { close: vi.fn() } as never, ocrEngine: { recognize: vi.fn(async () => []) } },
  );
  return { session, handle };
}

describe('BrowserViewAutomationCoreSession capture revision guard', () => {
  it('retries once and reports the transform of the frame it actually returns', async () => {
    let revision = 1; let scale = 1;
    const { session } = makeSession({
      revision: () => revision,
      transform: () => ({ scaleX: scale, scaleY: scale }),
      capturePage: async () => {
        if (revision === 1) { revision = 2; scale = .5; }
        return capturedImage(1280, 720);
      },
    });

    const result = await session.capturePreviewWithViewportTransform();

    // The returned transform must describe the retried frame, not the stale one.
    expect(result.viewportTransform).toEqual({ scaleX: .5, scaleY: .5 });
    await session.close();
  });

  it('fails instead of returning a frame when the viewport never settles', async () => {
    let revision = 0;
    const { session, handle } = makeSession({
      revision: () => revision,
      transform: () => ({ scaleX: 1, scaleY: 1 }),
      capturePage: async () => { revision += 1; return capturedImage(1280, 720); },
    });

    await expect(session.capturePreviewWithViewportTransform()).rejects.toThrow('viewport changed while capturing automation frame');
    // Retry count == initial attempt + the extra retry (initial + 1).
    expect(handle.webContents.capturePage).toHaveBeenCalledTimes(2);
    await session.close();
  });

  it('tolerates a resize between retries when the revision is stable across the capture', async () => {
    const { session } = makeSession({
      revision: () => 7,
      transform: () => ({ scaleX: 1, scaleY: 1 }),
      capturePage: async () => capturedImage(640, 360),
    });

    const result = await session.capturePreviewWithViewportTransform();

    expect(result.width).toBe(640);
    expect(result.viewportTransform).toEqual({ scaleX: 1, scaleY: 1 });
    await session.close();
  });

  it('exposes the current viewport transform without capturing', async () => {
    const { session, handle } = makeSession({
      revision: () => 1,
      transform: () => ({ scaleX: .75, scaleY: .75 }),
      capturePage: async () => capturedImage(1, 1),
    });

    expect(session.currentViewportTransform()).toEqual({ scaleX: .75, scaleY: .75 });
    expect(handle.webContents.capturePage).not.toHaveBeenCalled();
    await session.close();
  });

  it('rejects a captured frame that carries no bitmap', async () => {
    const { session } = makeSession({
      revision: () => 1,
      transform: () => ({ scaleX: 1, scaleY: 1 }),
      // capturePage resolves to something without the native image surface.
      capturePage: async () => ({ getSize: () => ({ width: 8, height: 8 }) }),
    });

    await expect(session.capturePreviewWithViewportTransform()).rejects.toThrow();
    await session.close();
  });
});

describe('BrowserViewAutomationCoreSession surface resolution', () => {
  it('fails the run with the feature-specific message when the encoded game surface is gone', async () => {
    const workflowSurface = (fingerprint: string) => source({
      workflow: {
        formatVersion: 3, id: 'commit-test', name: 'Commit test',
        root: {
          id: 'root', kind: 'with', surface: { kind: 'visual', visualHint: 'flash', fingerprint },
          timeoutMs: 0, body: { id: 'body', kind: 'sequence', nodes: [] },
        },
      },
    });
    const { session } = (() => {
      const handle = {
        tabId: 'tab-surface', webContents: { incrementCapturerCount: vi.fn(), decrementCapturerCount: vi.fn(), capturePage: vi.fn(async () => capturedImage(1280, 720)) },
        getCssViewport: () => ({ width: 1280, height: 720 }),
        getViewportTransform: () => ({ logicalSize: { width: 1280, height: 720 }, displaySize: { width: 1280, height: 720 }, scaleX: 1, scaleY: 1 }),
        getViewportRevision: () => 1, assertCurrent: vi.fn(), waitForViewport: vi.fn(async () => undefined), release: vi.fn(),
      };
      return {
        session: new BrowserViewAutomationCoreSession(
          handle as never,
          workflowSurface('BFG1:' + Buffer.from(JSON.stringify({ version: 1, kind: 'flash', label: 'Game', source: 'https://example.test/g.swf', frameUrl: 'https://example.test/play', width: 960, height: 540 })).toString('base64url')),
          undefined, undefined, undefined,
          { matcher: { close: vi.fn() } as never, ocrEngine: { recognize: vi.fn(async () => []) } },
        ),
      };
    })();

    // `with` runs its surface resolution before the body, so the empty detector
    // result surfaces as a failed run rather than a thrown promise.
    const run = session.startWorkflow();
    const result = await run.completion;

    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error.message).toContain('没有找到特征码指定的游戏区域');
    await session.close();
  });
});