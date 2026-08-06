import { describe, expect, it } from 'vitest';
import { compileRules, matchesUrl } from './userscript-matcher';

describe('userscript-matcher', () => {
  it('matches exact match-pattern hosts and paths', () => {
    const rules = compileRules({ match: ['http://127.0.0.1/game.html'], include: [], exclude: [], excludeMatch: [] });
    expect(matchesUrl(rules, 'http://127.0.0.1/game.html')).toBe(true);
    expect(matchesUrl(rules, 'http://127.0.0.1/other.html')).toBe(false);
  });

  it('match pattern without port matches any port', () => {
    const rules = compileRules({ match: ['http://127.0.0.1/*'], include: [], exclude: [], excludeMatch: [] });
    expect(matchesUrl(rules, 'http://127.0.0.1:8080/document-start')).toBe(true);
    expect(matchesUrl(rules, 'http://127.0.0.1:54321/x/y')).toBe(true);
    expect(matchesUrl(rules, 'https://127.0.0.1/x')).toBe(false);
  });

  it('matches wildcard hosts including the bare domain', () => {
    const rules = compileRules({ match: ['https://*.example.com/*'], include: [], exclude: [], excludeMatch: [] });
    expect(matchesUrl(rules, 'https://example.com/a')).toBe(true);
    expect(matchesUrl(rules, 'https://game.example.com/a/b')).toBe(true);
    expect(matchesUrl(rules, 'https://deep.sub.example.com/a')).toBe(true);
    expect(matchesUrl(rules, 'https://example.org/a')).toBe(false);
  });

  it('wildcards in the path span slashes', () => {
    const rules = compileRules({ match: ['http://host.test/game/*'], include: [], exclude: [], excludeMatch: [] });
    expect(matchesUrl(rules, 'http://host.test/game/a/b.swf')).toBe(true);
    expect(matchesUrl(rules, 'http://host.test/other/a')).toBe(false);
  });

  it('supports a wildcard scheme', () => {
    const rules = compileRules({ match: ['*://wild.test/*'], include: [], exclude: [], excludeMatch: [] });
    expect(matchesUrl(rules, 'http://wild.test/a')).toBe(true);
    expect(matchesUrl(rules, 'https://wild.test/a')).toBe(true);
    expect(matchesUrl(rules, 'file://wild.test/a')).toBe(true);
  });

  it('include globs match any scheme when no scheme is given', () => {
    const rules = compileRules({ match: [], include: ['example.com/*'], exclude: [], excludeMatch: [] });
    expect(matchesUrl(rules, 'http://example.com/a')).toBe(true);
    expect(matchesUrl(rules, 'https://example.com/a/b')).toBe(true);
    expect(matchesUrl(rules, 'http://other.com/a')).toBe(false);
  });

  it('include globs support wildcards anywhere in host and path', () => {
    const rules = compileRules({ match: [], include: ['http://*.legacy.cn/game*'], exclude: [], excludeMatch: [] });
    expect(matchesUrl(rules, 'http://a.legacy.cn/game')).toBe(true);
    expect(matchesUrl(rules, 'http://a.b.legacy.cn/game/play.swf')).toBe(true);
    expect(matchesUrl(rules, 'http://legacy.cn/other')).toBe(false);
  });

  it('exclude wins over include', () => {
    const rules = compileRules({ match: [], include: ['http://site.test/*'], exclude: ['http://site.test/admin*'], excludeMatch: [] });
    expect(matchesUrl(rules, 'http://site.test/game')).toBe(true);
    expect(matchesUrl(rules, 'http://site.test/admin/dashboard')).toBe(false);
  });

  it('exclude-match follows match-pattern semantics', () => {
    const rules = compileRules({ match: [], include: ['http://site.test/*'], exclude: [], excludeMatch: ['http://site.test/private/*'] });
    expect(matchesUrl(rules, 'http://site.test/private/data')).toBe(false);
    expect(matchesUrl(rules, 'http://site.test/public')).toBe(true);
  });

  it('matches everything when no patterns exist', () => {
    const rules = compileRules({ match: [], include: [], exclude: [], excludeMatch: [] });
    expect(matchesUrl(rules, 'http://anything.test/a')).toBe(true);
    expect(matchesUrl(rules, 'file:///c:/x.html')).toBe(true);
    expect(matchesUrl(rules, 'about:newtab')).toBe(true);
  });

  it('matches everything except excludes when only excludes exist', () => {
    const rules = compileRules({ match: [], include: [], exclude: ['http://no.test/*'], excludeMatch: [] });
    expect(matchesUrl(rules, 'http://yes.test/a')).toBe(true);
    expect(matchesUrl(rules, 'http://no.test/a')).toBe(false);
  });

  it('queries and fragments do not affect host matching', () => {
    const rules = compileRules({ match: ['http://q.test/*'], include: [], exclude: [], excludeMatch: [] });
    expect(matchesUrl(rules, 'http://q.test/path?token=abc#section')).toBe(true);
  });
});
