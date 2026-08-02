import { describe, expect, it } from 'vitest';
import { mergeDownloadPatch, normalizeRestartedDownload, type StoredDownload } from '../src/main/utils/download-record';

const active: StoredDownload = {
  id: 'a2_demo', url: 'https://example.com/game.swf', filename: 'game.swf',
  state: 'progressing', progress: 40, speed: 1024, receivedBytes: 40, totalBytes: 100,
  savePath: 'C:\\Downloads\\game.swf', engine: 'aria2', updatedAt: 1,
};

describe('download state recovery', () => {
  it('marks active and paused records interrupted after restart', () => {
    expect(normalizeRestartedDownload(active, 10)).toMatchObject({ state: 'interrupted', speed: 0, updatedAt: 10 });
    expect(normalizeRestartedDownload({ ...active, state: 'paused' }, 11)).toMatchObject({ state: 'interrupted', updatedAt: 11 });
  });

  it('merges partial progress without losing immutable task fields', () => {
    expect(mergeDownloadPatch(active, { id: active.id, state: 'paused', speed: 0 }, 20)).toEqual({
      ...active, state: 'paused', speed: 0, updatedAt: 20,
    });
    expect(mergeDownloadPatch(undefined, { id: 'missing', state: 'interrupted' }, 20)).toBeNull();
  });
});
