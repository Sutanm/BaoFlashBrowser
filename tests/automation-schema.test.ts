import { describe, expect, it } from 'vitest';
import {
  collectWorkflowAssetIds,
  parseAutomationWorkflow,
} from '../src/shared/automation/schema';

describe('automation workflow schema', () => {
  it('validates branches and collects every referenced asset', () => {
    const workflow = parseAutomationWorkflow({
      formatVersion: 1,
      id: 'daily-login',
      name: '每日登录',
      readyWhen: { type: 'image-visible', asset: 'pages/home.png', threshold: 0.91 },
      root: {
        type: 'sequence',
        steps: [
          { type: 'wait-image', asset: 'buttons/start.png', timeoutMs: 5000 },
          { type: 'wait-image-state', asset: 'loading/spinner.webp', state: 'hidden' },
          { type: 'move-to-image', asset: 'buttons/menu.png' },
          { type: 'drag-image', source: { type: 'image-visible', asset: 'cards/A.png' }, target: { type: 'image-visible', asset: 'slots/B.png' }, durationMs: 800 },
          { type: 'key-hold-until-image', key: 'Space', modifiers: ['control', 'shift'], asset: 'pages/loaded.png', state: 'visible' },
          {
            type: 'if-condition',
            condition: { type: 'any', conditions: [
              { type: 'image-visible', asset: 'states/first.png' },
              { type: 'all', conditions: [
                { type: 'image-visible', asset: 'states/second.png' },
                { type: 'not', condition: { type: 'image-visible', asset: 'states/blocked.png' } },
              ] },
            ] },
            then: { type: 'sequence', steps: [] },
          },
          {
            type: 'if-image',
            condition: { type: 'image-visible', asset: 'dialogs/reward.png' },
            then: { type: 'sequence', steps: [{ type: 'click-image', asset: 'buttons/claim.png' }] },
            else: { type: 'sequence', steps: [{ type: 'key-press', key: 'Escape' }] },
          },
          { type: 'repeat', times: 2, body: { type: 'sequence', steps: [{ type: 'delay', durationMs: 100 }] } },
          {
            type: 'repeat-until-image', until: 'visible', maxIterations: 5,
            condition: { type: 'image-visible', asset: 'pages/done.png' },
            body: { type: 'sequence', steps: [{ type: 'reload' }] },
          },
        ],
      },
    });

    expect([...collectWorkflowAssetIds(workflow)].sort()).toEqual([
      'buttons/claim.png',
      'buttons/menu.png',
      'buttons/start.png',
      'cards/A.png',
      'dialogs/reward.png',
      'loading/spinner.webp',
      'pages/done.png',
      'pages/home.png',
      'pages/loaded.png',
      'slots/B.png',
      'states/blocked.png',
      'states/first.png',
      'states/second.png',
    ]);
  });

  it('rejects unsafe asset ids and unbounded repeat counts', () => {
    expect(() => parseAutomationWorkflow({
      formatVersion: 1,
      id: 'bad',
      name: 'Bad',
      root: { type: 'sequence', steps: [{ type: 'click-image', asset: '../secret.png' }] },
    })).toThrow();
    expect(() => parseAutomationWorkflow({
      formatVersion: 1,
      id: 'bad-repeat',
      name: 'Bad repeat',
      root: { type: 'sequence', steps: [{ type: 'repeat', times: 1001, body: { type: 'sequence', steps: [] } }] },
    })).toThrow();
  });

  it('allows only http(s) navigation', () => {
    const base = {
      formatVersion: 1, id: 'navigation', name: 'Navigation',
      root: { type: 'sequence', steps: [] as unknown[] },
    };
    expect(() => parseAutomationWorkflow({ ...base, root: { type: 'sequence', steps: [{ type: 'navigate', url: 'file:///secret' }] } })).toThrow();
    expect(() => parseAutomationWorkflow({ ...base, root: { type: 'sequence', steps: [{ type: 'navigate', url: 'https://example.com/game' }] } })).not.toThrow();
  });

  it('rejects duplicate combination-key modifiers', () => {
    expect(() => parseAutomationWorkflow({
      formatVersion: 1, id: 'duplicate-modifier', name: 'Duplicate modifier',
      root: { type: 'sequence', steps: [{ type: 'key-press', key: 'A', modifiers: ['control', 'control'] }] },
    })).toThrow(/modifiers must be unique/);
  });

  it('validates guarded image clicks', () => {
    expect(parseAutomationWorkflow({
      formatVersion: 1, id: 'guarded-click', name: 'Guarded click',
      root: { type: 'sequence', steps: [{ type: 'click-image', asset: 'button.png', verifyBeforeClick: true, maxMovementPx: 12 }] },
    }).root.steps[0]).toMatchObject({ verifyBeforeClick: true, maxMovementPx: 12 });
    expect(() => parseAutomationWorkflow({
      formatVersion: 1, id: 'bad-guard', name: 'Bad guard',
      root: { type: 'sequence', steps: [{ type: 'click-image', asset: 'button.png', maxMovementPx: 501 }] },
    })).toThrow();
  });

  it('bounds drag duration and validates both image endpoints', () => {
    expect(() => parseAutomationWorkflow({
      formatVersion: 1, id: 'bad-drag', name: 'Bad drag',
      root: { type: 'sequence', steps: [{
        type: 'drag-image', source: { type: 'image-visible', asset: 'A.png' },
        target: { type: 'image-visible', asset: '../B.png' }, durationMs: 10_001,
      }] },
    })).toThrow();
  });

  it('validates normalized coordinate clicks without adding image assets', () => {
    const workflow = parseAutomationWorkflow({
      formatVersion: 1, id: 'coordinate-click', name: 'Coordinate click',
      root: { type: 'sequence', steps: [{ type: 'click-coordinate', coordinate: { x: 0, y: 10000 }, clickCount: 2 }] },
    });
    expect(workflow.root.steps[0]).toMatchObject({ coordinate: { x: 0, y: 10000 } });
    expect([...collectWorkflowAssetIds(workflow)]).toEqual([]);
    expect(() => parseAutomationWorkflow({
      formatVersion: 1, id: 'bad-coordinate', name: 'Bad coordinate',
      root: { type: 'sequence', steps: [{ type: 'click-coordinate', coordinate: { x: 10001, y: 1 } }] },
    })).toThrow();
  });

  it('validates random region clicks and requires padding to leave usable space', () => {
    const workflow = parseAutomationWorkflow({
      formatVersion: 1, id: 'random-region-click', name: 'Random region click',
      root: { type: 'sequence', steps: [{
        type: 'random-click-region', region: { left: 1000, top: 2000, right: 9000, bottom: 8000 },
        button: 'right', clickCount: 3, padding: 500,
      }] },
    });
    expect(workflow.root.steps[0]).toMatchObject({ type: 'random-click-region', padding: 500 });
    expect([...collectWorkflowAssetIds(workflow)]).toEqual([]);
    expect(() => parseAutomationWorkflow({
      formatVersion: 1, id: 'bad-random-region-click', name: 'Bad random region click',
      root: { type: 'sequence', steps: [{
        type: 'random-click-region', region: { left: 1000, top: 1000, right: 2000, bottom: 2000 }, padding: 500,
      }] },
    })).toThrow(/padding/);
  });

  it('validates general pointer targets, timeout branches and explicit script endings', () => {
    const workflow = parseAutomationWorkflow({
      formatVersion: 1, id: 'general-controls', name: 'General controls',
      root: { type: 'sequence', steps: [
        { type: 'move-to-coordinate', coordinate: { x: 5000, y: 4000 } },
        { type: 'drag', source: { kind: 'coordinate', coordinate: { x: 1000, y: 2000 } }, target: { kind: 'image', condition: { type: 'image-visible', asset: 'drop.png' } } },
        { type: 'wait-condition-branch', condition: { type: 'image-visible', asset: 'done.png' }, success: { type: 'sequence', steps: [{ type: 'end', result: 'success' }] }, timeout: { type: 'sequence', steps: [{ type: 'end', result: 'failure', message: 'timeout' }] } },
      ] },
    });
    expect([...collectWorkflowAssetIds(workflow)].sort()).toEqual(['done.png', 'drop.png']);
    expect(() => parseAutomationWorkflow({
      formatVersion: 1, id: 'bad-pointer', name: 'Bad pointer',
      root: { type: 'sequence', steps: [{ type: 'drag', source: { kind: 'coordinate', coordinate: { x: -1, y: 0 } }, target: { kind: 'coordinate', coordinate: { x: 1, y: 1 } } }] },
    })).toThrow();
  });

  it('validates a normalized default image search region', () => {
    const workflow = parseAutomationWorkflow({
      formatVersion: 1, id: 'game-region', name: 'Game region',
      searchRegion: { left: 1000, top: 750, right: 9000, bottom: 9250 },
      root: { type: 'sequence', steps: [{ type: 'wait-image', asset: 'game/button.png' }] },
    });
    expect(workflow.searchRegion).toEqual({ left: 1000, top: 750, right: 9000, bottom: 9250 });
    expect(() => parseAutomationWorkflow({
      formatVersion: 1, id: 'inverted-region', name: 'Inverted region',
      searchRegion: { left: 8000, top: 1000, right: 2000, bottom: 9000 },
      root: { type: 'sequence', steps: [] },
    })).toThrow(/positive width/);
    expect(() => parseAutomationWorkflow({
      formatVersion: 1, id: 'two-entries', name: 'Two entries',
      searchRegion: { left: 1000, top: 1000, right: 9000, bottom: 9000 },
      readyWhen: { type: 'image-visible', asset: 'ready.png' },
      root: { type: 'sequence', steps: [] },
    })).toThrow(/cannot also define readyWhen/);
  });

  it('validates nested fast recognition regions and collects assets inside them', () => {
    const workflow = parseAutomationWorkflow({
      formatVersion: 1, id: 'vision-region', name: 'Vision region',
      searchRegion: { left: 1000, top: 1000, right: 9000, bottom: 9000 },
      root: { type: 'sequence', steps: [{
        type: 'vision-region', region: { left: 2000, top: 2000, right: 8000, bottom: 8000 },
        body: { type: 'sequence', steps: [{
          type: 'vision-region', region: { left: 3000, top: 1000, right: 7000, bottom: 6000 },
          body: { type: 'sequence', steps: [{ type: 'wait-image', asset: 'inside.png' }] },
        }] },
      }] },
    });
    expect([...collectWorkflowAssetIds(workflow)]).toEqual(['inside.png']);

    expect(() => parseAutomationWorkflow({
      formatVersion: 1, id: 'disjoint-vision-region', name: 'Disjoint vision region',
      searchRegion: { left: 0, top: 0, right: 4000, bottom: 4000 },
      root: { type: 'sequence', steps: [{
        type: 'vision-region', region: { left: 5000, top: 5000, right: 9000, bottom: 9000 },
        body: { type: 'sequence', steps: [] },
      }] },
    })).toThrow(/does not overlap/);
  });

  it('accepts the automatic image mask and rejects unknown mask modes', () => {
    const parsed = parseAutomationWorkflow({
      formatVersion: 1, id: 'auto-mask', name: 'Auto mask',
      readyWhen: { type: 'image-visible', asset: 'ready.png', mask: 'auto' },
      root: { type: 'sequence', steps: [{ type: 'click-image', asset: 'button.png', mask: 'auto' }] },
    });
    expect(parsed.readyWhen).toMatchObject({ mask: 'auto' });
    expect(parsed.root.steps[0]).toMatchObject({ mask: 'auto' });
    expect(() => parseAutomationWorkflow({
      formatVersion: 1, id: 'bad-mask', name: 'Bad mask',
      root: { type: 'sequence', steps: [{ type: 'click-image', asset: 'button.png', mask: 'background-removal' }] },
    })).toThrow();
  });

  it('supports a combined readiness condition and collects its assets', () => {
    const workflow = parseAutomationWorkflow({
      formatVersion: 1, id: 'combined-ready', name: 'Combined ready',
      readyWhen: { type: 'all', conditions: [
        { type: 'image-visible', asset: 'page.png' },
        { type: 'not', condition: { type: 'image-visible', asset: 'popup.png' } },
      ] },
      root: { type: 'sequence', steps: [] },
    });
    expect([...collectWorkflowAssetIds(workflow)].sort()).toEqual(['page.png', 'popup.png']);
  });

  it('validates image groups and collects all member assets', () => {
    const workflow = parseAutomationWorkflow({
      formatVersion: 1, id: 'directions', name: 'Directions',
      readyWhen: {
        type: 'image-visible', asset: '角色/行走/left.png',
        alternatives: ['角色/行走/right.png', '角色/行走/up.png', '角色/行走/down.png'],
      },
      root: { type: 'sequence', steps: [] },
    });
    expect([...collectWorkflowAssetIds(workflow)].sort()).toEqual([
      '角色/行走/down.png', '角色/行走/left.png', '角色/行走/right.png', '角色/行走/up.png',
    ]);
    expect(() => parseAutomationWorkflow({
      formatVersion: 1, id: 'duplicate-group', name: 'Duplicate group',
      root: { type: 'sequence', steps: [{ type: 'wait-image', asset: 'a.png', alternatives: ['b.png', 'b.png'] }] },
    })).toThrow(/alternatives must be unique/);
  });
});
