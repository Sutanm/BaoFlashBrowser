import { describe, expect, it } from 'vitest';
import {
  classifyAddress,
  connectAllows,
  isBlockedUrl,
  redactHeadersForLog,
  redactUrlForLog,
} from '@main/modules/userscripts/userscript-request';

describe('userscript-request @connect policy', () => {
  it('allows same-origin requests without @connect', () => {
    expect(connectAllows([], 'http://game.example.com', 'http://game.example.com/api')).toBe(true);
  });

  it('rejects cross-origin requests without @connect', () => {
    expect(connectAllows([], 'http://game.example.com', 'http://api.example.com/x')).toBe(false);
  });

  it('allows hosts listed in @connect', () => {
    expect(connectAllows(['api.example.com'], 'http://game.example.com', 'http://api.example.com/x')).toBe(true);
  });

  it('allows subdomains of a wildcard @connect entry', () => {
    expect(connectAllows(['*.example.com'], 'http://game.example.com', 'http://api.example.com/x')).toBe(true);
    expect(connectAllows(['*.example.com'], 'http://game.example.com', 'http://deep.api.example.com/x')).toBe(true);
  });

  it('wildcard @connect allows any public host', () => {
    expect(connectAllows(['*'], 'http://a.example.com', 'https://anything-else.org/x')).toBe(true);
  });

  it('matches ports and paths transparently', () => {
    expect(connectAllows(['api.example.com'], 'http://game.example.com', 'http://api.example.com:8080/x')).toBe(true);
  });

  it('rejects invalid target URLs', () => {
    expect(connectAllows(['*'], 'http://a.example.com', 'not-a-url')).toBe(false);
  });
});

describe('userscript-request address classification', () => {
  it('classifies loopback addresses', () => {
    expect(classifyAddress('127.0.0.1')).toBe('loopback');
    expect(classifyAddress('127.255.255.254')).toBe('loopback');
    expect(classifyAddress('localhost')).toBe('loopback');
    expect(classifyAddress('::1')).toBe('loopback');
  });

  it('classifies private and link-local addresses', () => {
    expect(classifyAddress('10.1.2.3')).toBe('private');
    expect(classifyAddress('192.168.1.1')).toBe('private');
    expect(classifyAddress('172.16.0.1')).toBe('private');
    expect(classifyAddress('172.31.255.255')).toBe('private');
    expect(classifyAddress('169.254.10.10')).toBe('linklocal');
    expect(classifyAddress('fc00::1')).toBe('private');
    expect(classifyAddress('fe80::1')).toBe('linklocal');
  });

  it('classifies unspecified and public addresses', () => {
    expect(classifyAddress('0.0.0.0')).toBe('unspecified');
    expect(classifyAddress('::')).toBe('unspecified');
    expect(classifyAddress('93.184.216.34')).toBe('public');
    expect(classifyAddress('example.com')).toBe('public');
  });

  it('blocks non-public addresses by default but allows explicit loopback grants', () => {
    expect(isBlockedUrl('http://127.0.0.1:8080/x')).toBe(true);
    expect(isBlockedUrl('http://localhost/x')).toBe(true);
    expect(isBlockedUrl('http://192.168.1.5/x')).toBe(true);
    expect(isBlockedUrl('http://example.com/x')).toBe(false);
    expect(isBlockedUrl('https://example.com/x')).toBe(false);
    expect(isBlockedUrl('file:///etc/passwd')).toBe(true);
    expect(isBlockedUrl('ftp://example.com/x')).toBe(true);
    expect(isBlockedUrl('http://127.0.0.1:8080/x', ['127.0.0.1'])).toBe(false);
  });
});

describe('userscript-request log redaction', () => {
  it('strips query strings from logged URLs', () => {
    expect(redactUrlForLog('http://api.example.com/x?token=secret&a=1')).toBe('http://api.example.com/x?<redacted>');
  });

  it('keeps URLs without queries intact', () => {
    expect(redactUrlForLog('http://api.example.com/x')).toBe('http://api.example.com/x');
  });

  it('removes sensitive headers from logs', () => {
    const headers = {
      'User-Agent': 'demo',
      'Authorization': 'Bearer secret',
      'Cookie': 'session=abc',
      'Proxy-Authorization': 'Basic x',
      'X-Custom': 'ok',
    };
    const redacted = redactHeadersForLog(headers);
    expect(redacted['X-Custom']).toBe('ok');
    expect(redacted).not.toHaveProperty('Authorization');
    expect(redacted).not.toHaveProperty('Cookie');
    expect(redacted).not.toHaveProperty('Proxy-Authorization');
    expect(JSON.stringify(redacted)).not.toContain('secret');
    expect(JSON.stringify(redacted)).not.toContain('abc');
  });

  it('treats header names case-insensitively', () => {
    const redacted = redactHeadersForLog({ 'authorization': 'x', 'cOoKiE': 'y' });
    expect(redacted).not.toHaveProperty('authorization');
    expect(redacted).not.toHaveProperty('cOoKiE');
  });
});
