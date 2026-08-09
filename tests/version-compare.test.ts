import { describe, it, expect } from 'vitest';
import { compareVersions, updateHostAllowed } from '../src/main/modules/userscripts/userscript-versions';

describe('compareVersions', () => {
  it('1.2.10 > 1.2.9', () => expect(compareVersions('1.2.10', '1.2.9')).toBe(1));
  it('1.2 === 1.2.0', () => expect(compareVersions('1.2', '1.2.0')).toBe(0));
  it('1.2.0-beta === 1.2.0 (no prerelease semantics)', () => expect(compareVersions('1.2.0-beta', '1.2.0')).toBe(0));
  it('invalid segments treated as 0', () => expect(compareVersions('1.a.3', '1.0.3')).toBe(0));
  it('older returns -1', () => expect(compareVersions('1.0.9', '1.0.10')).toBe(-1));
  it('empty strings are 0.0.0', () => expect(compareVersions('', '0.0.0')).toBe(0));
});

describe('updateHostAllowed', () => {
  it('connect host allows', () => expect(updateHostAllowed(['api.example.com'], [], 'https://api.example.com/v2.user.js')).toBe(true));
  it('connect wildcard allows', () => expect(updateHostAllowed(['*.example.com'], [], 'https://a.example.com/x.user.js')).toBe(true));
  it('connect wildcard matches bare suffix', () => expect(updateHostAllowed(['*.example.com'], [], 'https://example.com/x.user.js')).toBe(true));
  it('match host falls back (weak path)', () => expect(updateHostAllowed([], ['https://game.example.com/*'], 'https://game.example.com/update.user.js')).toBe(true));
  it('match wildcard subdomain falls back', () => expect(updateHostAllowed([], ['http://*.example.com/*'], 'https://cdn.example.com/x.user.js')).toBe(true));
  it('data: source rejected', () => expect(updateHostAllowed([], [], 'data:text/plain,x')).toBe(false));
  it('unrelated host rejected', () => expect(updateHostAllowed(['api.example.com'], [], 'https://evil.example.net/x.user.js')).toBe(false));
  it('relative url rejected (no base)', () => expect(updateHostAllowed(['127.0.0.1'], [], '/manifest.json')).toBe(false));
});
