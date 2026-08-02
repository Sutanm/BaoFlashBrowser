import { describe, expect, it } from 'vitest';
import { deriveKek, encryptBuf, decryptBuf, encryptStr, decryptStr } from '../src/main/modules/crypto-helper';

describe('password cryptography', () => {
  it('derives keys asynchronously and round-trips encrypted values', async () => {
    const key = await deriveKek('ValidPassword1', Buffer.alloc(16, 7));
    expect(key).toHaveLength(32);
    expect(decryptStr(key, encryptStr(key, 'secret'))).toBe('secret');
    expect(decryptBuf(key, encryptBuf(key, Buffer.from('data')))?.toString()).toBe('data');
  });

  it('rejects modified authenticated ciphertext', async () => {
    const key = await deriveKek('ValidPassword1', Buffer.alloc(16, 9));
    const encrypted = encryptStr(key, 'secret');
    encrypted.ct = Buffer.from('tampered').toString('base64');
    expect(decryptStr(key, encrypted)).toBeNull();
  });
});
