import { describe, expect, it } from 'vitest';
import { aria2GidSchema, aria2StatusSchema } from '../src/main/utils/aria2-response';

const status = {
  totalLength: '2048', completedLength: '1024', downloadSpeed: '512', status: 'active',
  files: [{ path: '/downloads/game.swf', index: '1' }],
};

describe('aria2 response boundary', () => {
  it('accepts RPC lengths, paths, states and GIDs', () => {
    expect(aria2GidSchema.parse('0123456789abcdef')).toBe('0123456789abcdef');
    for (const state of ['active', 'waiting', 'paused', 'error', 'complete', 'removed']) {
      expect(aria2StatusSchema.parse({ ...status, status: state }).files?.[0].path).toBe('/downloads/game.swf');
    }
  });

  it.each([null, 123, '', {}, 'not-a-gid'])('rejects malformed GID %j', (value) => {
    expect(aria2GidSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    null, {}, { ...status, totalLength: '10junk' }, { ...status, completedLength: -1 },
    { ...status, downloadSpeed: 'NaN' }, { ...status, status: 'unknown' },
    { ...status, files: [{ path: { unexpected: true } }] },
  ])('rejects malformed status %j', (value) => {
    expect(aria2StatusSchema.safeParse(value).success).toBe(false);
  });
});
