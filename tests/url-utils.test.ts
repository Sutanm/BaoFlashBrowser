import { describe, expect, it } from 'vitest';
import { isLocalAddress, isNewtabUrl, resolveFaviconSrc } from '../src/renderer/services/url-utils';
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

describe('favicon source resolution', () => {
  it('never invents a remote fallback when no favicon was stored', () => {
    expect(resolveFaviconSrc(undefined, 'https://www.baidu.com')).toBeNull();
    expect(resolveFaviconSrc('', 'https://www.baidu.com')).toBeNull();
  });

  it('keeps a stored favicon for normal sites', () => {
    expect(resolveFaviconSrc('https://www.baidu.com/favicon.ico', 'https://www.baidu.com'))
      .toBe('https://www.baidu.com/favicon.ico');
  });

  it('keeps inline data/blob icons, they cost no network request', () => {
    const dataUrl = 'data:image/png;base64,AAAA';
    expect(resolveFaviconSrc(dataUrl, 'https://example.com')).toBe(dataUrl);
  });

  it('drops icons for loopback entries so stopped debug servers stay quiet', () => {
    expect(isLocalAddress('http://localhost:8090/x')).toBe(true);
    expect(isLocalAddress('http://127.0.0.1:18673')).toBe(true);
    expect(isLocalAddress('https://example.com')).toBe(false);
    // 条目本身是本地服务，或存下来的 favicon 指向本地服务，都不请求
    expect(resolveFaviconSrc('http://127.0.0.1:18673/favicon.ico', 'http://127.0.0.1:18673'))
      .toBeNull();
    expect(resolveFaviconSrc('http://localhost:8090/favicon.ico', 'https://example.com'))
      .toBeNull();
  });
});
