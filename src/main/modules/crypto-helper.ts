import crypto from 'crypto';

export const PBKDF2_ITER = 250000;
export const SALT_LEN = 16;
export const KEY_LEN = 32;
export const IV_LEN = 12;

export interface EncBlob {
  iv: string;
  ct: string;
  tag: string;
}

export function b64(buf: Buffer): string {
  return buf.toString('base64');
}

export function unb64(s: string): Buffer {
  return Buffer.from(s, 'base64');
}

export function deriveKek(masterPwd: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(masterPwd, salt, PBKDF2_ITER, KEY_LEN, 'sha256', (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export function encryptStr(key: Buffer, plaintext: string): EncBlob {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: b64(iv), ct: b64(ct), tag: b64(tag) };
}

export function decryptStr(key: Buffer, blob: EncBlob): string | null {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, unb64(blob.iv));
    decipher.setAuthTag(unb64(blob.tag));
    const pt = Buffer.concat([decipher.update(unb64(blob.ct)), decipher.final()]);
    return pt.toString('utf8');
  } catch (_e) {
    return null;
  }
}

export function encryptBuf(key: Buffer, buf: Buffer): EncBlob {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: b64(iv), ct: b64(ct), tag: b64(tag) };
}

export function decryptBuf(key: Buffer, blob: EncBlob): Buffer | null {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, unb64(blob.iv));
    decipher.setAuthTag(unb64(blob.tag));
    const pt = Buffer.concat([decipher.update(unb64(blob.ct)), decipher.final()]);
    return pt;
  } catch (_e) {
    return null;
  }
}
