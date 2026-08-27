import { describe, expect, it } from 'vitest';
import { extractCredentialParams, extractCredentialPayload } from '../src/main/modules/password-capture-params';

describe('password capture parameter extraction', () => {
  it('preserves credential value casing in form bodies', () => {
    expect(extractCredentialParams('username=Bao+User&password=SeCrEt%21')).toEqual({
      username: 'Bao User',
      password: 'SeCrEt!',
    });
  });

  it('accepts case-insensitive keys and legacy password aliases in URLs', () => {
    expect(extractCredentialParams('https://example.com/login?USER=Player&PwD=AaBb12#done')).toEqual({
      username: 'Player',
      password: 'AaBb12',
    });
  });

  it('rejects missing, short and malformed password values', () => {
    expect(extractCredentialParams('username=bao')).toBeNull();
    expect(extractCredentialParams('password=x')).toBeNull();
    expect(extractCredentialParams('password=%E0%A4%A')).toBeNull();
  });
});

describe('password capture payload extraction', () => {
  it('handles JSON aliases without changing credential values', () => {
    expect(extractCredentialPayload('{"login":"Bao","pass":"AaBb12"}')).toEqual({ username: 'Bao', password: 'AaBb12' });
    expect(extractCredentialPayload({ account: 'Player', pwd: 'Secret!' })).toEqual({ username: 'Player', password: 'Secret!' });
  });

  it('rejects arrays, malformed JSON and short passwords', () => {
    expect(extractCredentialPayload('[{"password":"secret"}]')).toBeNull();
    expect(extractCredentialPayload('{bad json')).toBeNull();
    expect(extractCredentialPayload('{"password":"x"}')).toBeNull();
  });
});
