import { describe, expect, it } from 'vitest';
import { isNewtabUrl } from '../src/renderer/services/url-utils';
import { isUrl, normalizeUrl } from '../src/renderer/services/id.service';

describe('URL normalization', () => {
  it('keeps supported absolute and internal URLs', () => {
    expect(normalizeUrl('https://example.com/game')).toBe('https://example.com/game');
    expect(normalizeUrl('about:newtab')).toBe('about:newtab');
    expect(normalizeUrl('file:///C:/games/test.swf')).toBe('file:///C:/games/test.swf');
  });

  it('adds HTTPS to host-like input and searches other text', () => {
    expect(isUrl('example.com/game')).toBe(true);
    expect(normalizeUrl('example.com/game')).toBe('https://example.com/game');
    expect(normalizeUrl('flash game', 'baidu')).toBe('https://www.baidu.com/s?wd=flash%20game');
  });

  it('uses the global Bing endpoint for both selected and fallback searches', () => {
    const expected = 'https://www.bing.com/search?q=%E6%B8%B8%E6%88%8F%20game';
    expect(normalizeUrl('游戏 game', 'bing')).toBe(expected);
    expect(normalizeUrl('游戏 game')).toBe(expected);
    expect(normalizeUrl('游戏 game', 'unknown')).toBe(expected);
    expect(normalizeUrl('https://cn.bing.com/search?q=user')).toBe('https://cn.bing.com/search?q=user');
  });

  it('recognizes renderer-owned new-tab URLs', () => {
    expect(isNewtabUrl('about:newtab')).toBe(true);
    expect(isNewtabUrl('about:blank')).toBe(true);
    expect(isNewtabUrl('https://example.com')).toBe(false);
  });
});
