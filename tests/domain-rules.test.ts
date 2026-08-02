import { describe, expect, it } from 'vitest';
import { domainMatchesRule, normalizeDomainRule } from '../src/main/utils/domain-rules';

describe('password capture domain exclusions', () => {
  it('normalizes URLs, wildcard notation and international domains', () => {
    expect(normalizeDomainRule(' https://Login.Example.com/path ')).toBe('login.example.com');
    expect(normalizeDomainRule('*.example.com')).toBe('example.com');
    expect(normalizeDomainRule('例子.测试')).toBe('xn--fsqu00a.xn--0zwm56d');
  });

  it('matches the domain and its subdomains without matching suffix lookalikes', () => {
    expect(domainMatchesRule('https://example.com/login', 'example.com')).toBe(true);
    expect(domainMatchesRule('account.example.com', 'example.com')).toBe(true);
    expect(domainMatchesRule('notexample.com', 'example.com')).toBe(false);
  });
});
