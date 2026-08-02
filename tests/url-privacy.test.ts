import { describe, expect, it } from 'vitest';
import { credentialOrigin, redactUrlForLog, sanitizeUrlForPersistence } from '../src/shared/utils/url-privacy';

describe('URL privacy', () => {
  it('removes all query and fragment data from logs', () => {
    expect(redactUrlForLog('https://game.example/login?token=secret&server=2#account')).toBe('https://game.example/login');
  });

  it('removes sensitive persistence parameters while retaining routing parameters', () => {
    const result = new URL(sanitizeUrlForPersistence('https://game.example/play?server_id=2&userid=42&token=secret&zone=west'));
    expect(result.searchParams.get('server_id')).toBe('2');
    expect(result.searchParams.get('zone')).toBe('west');
    expect(result.searchParams.has('userid')).toBe(false);
    expect(result.searchParams.has('token')).toBe(false);
  });

  it('stores only the origin for captured credentials', () => {
    expect(credentialOrigin('https://login.example/path?token=secret')).toBe('https://login.example');
  });
});
