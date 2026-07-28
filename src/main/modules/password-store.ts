import crypto from 'crypto';
import Store from 'electron-store';
import log from 'electron-log';
import * as dpapi from './dpapi';

const PBKDF2_ITER = 250000;
const SALT_LEN = 16;
const KEY_LEN = 32;
const IV_LEN = 12;

interface EncBlob {
  iv: string;
  ct: string;
  tag: string;
}

interface EntryMeta {
  id: string;
  host: string;
  origin: string;
  title: string;
  username: string;
  updatedAt: number;
}

interface StoredEntry extends EntryMeta {
  passwordEnc: EncBlob;
  createdAt: number;
}

interface PasswordStoreSchema {
  version: number;
  salt: string | null;
  dekMasterEnc: EncBlob | null;
  dekDpapiEnc: string | null;
  entries: StoredEntry[];
}

const store = new Store<PasswordStoreSchema>({
  name: 'password-store',
  defaults: {
    version: 1,
    salt: null,
    dekMasterEnc: null,
    dekDpapiEnc: null,
    entries: [],
  },
});

let _dekFromDpapi: Buffer | null = null;
let _dekFromMaster: Buffer | null = null;
let _initialized: boolean | null = null;

function _b64(buf: Buffer): string {
  return buf.toString('base64');
}
function _unb64(s: string): Buffer {
  return Buffer.from(s, 'base64');
}

function _deriveKek(masterPwd: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(masterPwd, salt, PBKDF2_ITER, KEY_LEN, 'sha256');
}

function _encryptStr(key: Buffer, plaintext: string): EncBlob {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: _b64(iv), ct: _b64(ct), tag: _b64(tag) };
}

function _decryptStr(key: Buffer, blob: EncBlob): string | null {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, _unb64(blob.iv));
    decipher.setAuthTag(_unb64(blob.tag));
    const pt = Buffer.concat([decipher.update(_unb64(blob.ct)), decipher.final()]);
    return pt.toString('utf8');
  } catch (_e) {
    return null;
  }
}

function _encryptBuf(key: Buffer, buf: Buffer): EncBlob {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: _b64(iv), ct: _b64(ct), tag: _b64(tag) };
}

function _decryptBuf(key: Buffer, blob: EncBlob): Buffer | null {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, _unb64(blob.iv));
    decipher.setAuthTag(_unb64(blob.tag));
    const pt = Buffer.concat([decipher.update(_unb64(blob.ct)), decipher.final()]);
    return pt;
  } catch (_e) {
    return null;
  }
}

function _genId(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function isInitialized(): boolean {
  if (_initialized !== null) return _initialized;
  _initialized = !!(store.get('salt') && store.get('dekMasterEnc'));
  return _initialized;
}

export function dpapiAvailable(): boolean {
  return dpapi.isAvailable();
}

export function init(): void {
  if (!isInitialized()) return;
  const dekDpapiEnc = store.get('dekDpapiEnc');
  if (!dekDpapiEnc || !dpapi.isAvailable()) {
    log.warn('[PasswordStore] DPAPI DEK unavailable, auto-fill requires master password');
    return;
  }
  try {
    const dek = dpapi.unprotect(_unb64(dekDpapiEnc));
    if (dek && dek.length === KEY_LEN) {
      _dekFromDpapi = dek;
      log.info('[PasswordStore] DPAPI DEK loaded, auto-fill ready');
    } else {
      log.warn('[PasswordStore] DPAPI DEK length mismatch');
    }
  } catch (e: unknown) {
    log.warn('[PasswordStore] DPAPI unprotect failed: ' + (e as Error).message);
  }
}

export function setupMaster(password: string): boolean {
  if (!password || password.length < 4) throw new Error('Master password at least 4 chars');
  if (isInitialized()) throw new Error('Password store already initialized');
  const dek = crypto.randomBytes(KEY_LEN);
  const salt = crypto.randomBytes(SALT_LEN);
  const kek = _deriveKek(password, salt);
  const dekMasterEnc = _encryptBuf(kek, dek);
  let dekDpapiEnc: string | null = null;
  if (dpapi.isAvailable()) {
    try {
      dekDpapiEnc = _b64(dpapi.protect(dek));
      _dekFromDpapi = dek;
    } catch (e: unknown) {
      log.warn('[PasswordStore] DPAPI protect failed: ' + (e as Error).message);
    }
  }
  store.set('version', 1);
  store.set('salt', _b64(salt));
  store.set('dekMasterEnc', dekMasterEnc);
  store.set('dekDpapiEnc', dekDpapiEnc);
  store.set('entries', []);
  _dekFromMaster = dek;
  _initialized = true;
  return true;
}

export function unlockWithMaster(password: string): boolean {
  if (!isInitialized()) return false;
  const salt = _unb64(store.get('salt')!);
  const kek = _deriveKek(password, salt);
  const dek = _decryptBuf(kek, store.get('dekMasterEnc')!);
  if (!dek) return false;
  _dekFromMaster = dek;
  if (!_dekFromDpapi) _dekFromDpapi = dek;
  return true;
}

export function lock(): void {
  if (_dekFromMaster) {
    try { _dekFromMaster.fill(0); } catch (_e) { /* ignore */ }
    _dekFromMaster = null;
  }
}

export function isUnlocked(): boolean {
  return !!_dekFromMaster;
}

function _getDekForWrite(): Buffer | null {
  return _dekFromMaster || _dekFromDpapi;
}

export function listEntries(): EntryMeta[] {
  const entries = store.get('entries') || [];
  return entries.map((e) => ({
    id: e.id,
    host: e.host,
    origin: e.origin,
    title: e.title,
    username: e.username,
    updatedAt: e.updatedAt,
  }));
}

function _findEntryIndex(id: string): number {
  const entries = store.get('entries') || [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].id === id) return i;
  }
  return -1;
}

export function addEntry(opts: {
  host: string;
  username: string;
  password: string;
  origin?: string;
  title?: string;
}): string {
  if (!opts || !opts.host || !opts.username || !opts.password) throw new Error('Incomplete params');
  const dek = _getDekForWrite();
  if (!dek) throw new Error('Password store not unlocked and DPAPI unavailable');
  const entries = store.get('entries') || [];
  let idx = -1;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].host === opts.host && entries[i].username === opts.username) {
      idx = i;
      break;
    }
  }
  const now = Date.now();
  const entry: StoredEntry = {
    id: idx >= 0 ? entries[idx].id : _genId(),
    host: opts.host,
    origin: opts.origin || 'https://' + opts.host,
    title: opts.title || opts.host,
    username: opts.username,
    passwordEnc: _encryptStr(dek, opts.password),
    createdAt: idx >= 0 ? entries[idx].createdAt : now,
    updatedAt: now,
  };
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  store.set('entries', entries);
  return entry.id;
}

export function updateEntry(
  id: string,
  fields: { title?: string; username?: string; password?: string },
): boolean {
  const entries = store.get('entries') || [];
  const idx = _findEntryIndex(id);
  if (idx < 0) return false;
  const entry = entries[idx];
  if (fields.title !== undefined) entry.title = fields.title;
  if (fields.username !== undefined) entry.username = fields.username;
  if (fields.password !== undefined) {
    const dek = _getDekForWrite();
    if (!dek) throw new Error('Password store not unlocked and DPAPI unavailable');
    entry.passwordEnc = _encryptStr(dek, fields.password);
  }
  entry.updatedAt = Date.now();
  entries[idx] = entry;
  store.set('entries', entries);
  return true;
}

export function deleteEntry(id: string): boolean {
  const entries = (store.get('entries') || []).filter((e) => e.id !== id);
  store.set('entries', entries);
  return true;
}

export function getDecryptedPassword(id: string): string | null {
  if (!_dekFromMaster) return null;
  const entries = store.get('entries') || [];
  const idx = _findEntryIndex(id);
  if (idx < 0) return null;
  return _decryptStr(_dekFromMaster, entries[idx].passwordEnc);
}

export function getEntriesForHost(host: string): { username: string; password: string }[] {
  if (!_dekFromDpapi) return [];
  const entries = store.get('entries') || [];
  const out: { username: string; password: string }[] = [];
  for (const entry of entries) {
    if (entry.host === host) {
      const pw = _decryptStr(_dekFromDpapi, entry.passwordEnc);
      if (pw !== null) out.push({ username: entry.username, password: pw });
    }
  }
  return out;
}

export function getMetaForHost(host: string): { id: string; username: string }[] {
  const entries = store.get('entries') || [];
  const out: { id: string; username: string }[] = [];
  for (const entry of entries) {
    if (entry.host === host) out.push({ id: entry.id, username: entry.username });
  }
  return out;
}

export function changeMaster(oldPwd: string, newPwd: string): boolean {
  if (!newPwd || newPwd.length < 4) throw new Error('New master password at least 4 chars');
  if (!unlockWithMaster(oldPwd)) return false;
  const dek = _dekFromMaster!;
  const salt = crypto.randomBytes(SALT_LEN);
  const kek = _deriveKek(newPwd, salt);
  store.set('salt', _b64(salt));
  store.set('dekMasterEnc', _encryptBuf(kek, dek));
  return true;
}

export function resetAll(): void {
  store.clear();
  if (_dekFromDpapi) {
    try { _dekFromDpapi.fill(0); } catch (_e) { /* ignore */ }
    _dekFromDpapi = null;
  }
  if (_dekFromMaster) {
    try { _dekFromMaster.fill(0); } catch (_e) { /* ignore */ }
    _dekFromMaster = null;
  }
  _initialized = false;
}

export function dispose(): void {
  if (_dekFromMaster) {
    try { _dekFromMaster.fill(0); } catch (_e) { /* ignore */ }
    _dekFromMaster = null;
  }
}
