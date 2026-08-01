import crypto from 'crypto';
import Store from 'electron-store';
import {
  EncBlob, SALT_LEN, KEY_LEN,
  b64, unb64, deriveKek, encryptStr, decryptStr, encryptBuf, decryptBuf,
} from './crypto-helper';

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
  entries: StoredEntry[];
  _enabled: boolean;
}

const store = new Store<PasswordStoreSchema>({
  name: 'password-store',
  defaults: {
    version: 1,
    salt: null,
    dekMasterEnc: null,
    entries: [],
    _enabled: true,
  },
  schema: {
    _enabled: { type: 'boolean' },
  },
});

let _dekFromMaster: Buffer | null = null;

function _genId(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function isInitialized(): boolean {
  return !!(store.get('salt') && store.get('dekMasterEnc'));
}

export async function init(): Promise<void> {
  _loadEnabled();
}

export async function setupMaster(password: string): Promise<boolean> {
  const MIN_PASSWORD_LENGTH = 8;
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Master password at least ${MIN_PASSWORD_LENGTH} chars`);
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password)) {
    throw new Error('Master password must contain uppercase, lowercase and digit');
  }
  if (isInitialized()) throw new Error('Password store already initialized');
  const dek = crypto.randomBytes(KEY_LEN);
  const salt = crypto.randomBytes(SALT_LEN);
  const kek = deriveKek(password, salt);
  const dekMasterEnc = encryptBuf(kek, dek);
  store.set({
    version: 1,
    salt: b64(salt),
    dekMasterEnc,
    entries: [],
  });
  _dekFromMaster = dek;
  return true;
}

export function unlockWithMaster(password: string): boolean {
  if (!isInitialized()) return false;
  const salt = unb64(store.get('salt')!);
  const kek = deriveKek(password, salt);
  const dek = decryptBuf(kek, store.get('dekMasterEnc')!);
  if (!dek) return false;
  _dekFromMaster = dek;
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
  return _dekFromMaster;
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
  if (!dek) throw new Error('Password store not unlocked');
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
    passwordEnc: encryptStr(dek, opts.password),
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
    if (!dek) throw new Error('Password store not unlocked');
    entry.passwordEnc = encryptStr(dek, fields.password);
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
  return decryptStr(_dekFromMaster, entries[idx].passwordEnc);
}

export function getEntriesForHost(host: string): { username: string; password: string }[] {
  if (!_dekFromMaster) return [];
  const entries = store.get('entries') || [];
  const normalizedHost = _normalizeHost(host);
  const out: { username: string; password: string }[] = [];
  for (const entry of entries) {
    if (_normalizeHost(entry.host) === normalizedHost) {
      const pw = decryptStr(_dekFromMaster, entry.passwordEnc);
      if (pw !== null) out.push({ username: entry.username, password: pw });
    }
  }
  return out;
}

function _normalizeHost(host: string): string {
  return host.replace(/^www\./i, '').toLowerCase();
}

export function getMetaForHost(host: string): { id: string; username: string }[] {
  const entries = store.get('entries') || [];
  const normalizedHost = _normalizeHost(host);
  const out: { id: string; username: string }[] = [];
  for (const entry of entries) {
    if (_normalizeHost(entry.host) === normalizedHost) {
      out.push({ id: entry.id, username: entry.username });
    }
  }
  return out;
}

export async function changeMaster(oldPwd: string, newPwd: string): Promise<boolean> {
  const MIN_PASSWORD_LENGTH = 8;
  if (!newPwd || newPwd.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`New master password at least ${MIN_PASSWORD_LENGTH} chars`);
  }
  if (!/[A-Z]/.test(newPwd) || !/[a-z]/.test(newPwd) || !/\d/.test(newPwd)) {
    throw new Error('New master password must contain uppercase, lowercase and digit');
  }
  if (!unlockWithMaster(oldPwd)) return false;
  const dek = _dekFromMaster!;
  const salt = crypto.randomBytes(SALT_LEN);
  const kek = deriveKek(newPwd, salt);
  store.set({
    salt: b64(salt),
    dekMasterEnc: encryptBuf(kek, dek),
  } as any);
  return true;
}

export function resetAll(): void {
  store.clear();
  if (_dekFromMaster) {
    try { _dekFromMaster.fill(0); } catch (_e) { /* ignore */ }
    _dekFromMaster = null;
  }
}

let _enabled = true;

function _loadEnabled(): void {
  const val = store.get('_enabled');
  if (typeof val === 'boolean') _enabled = val;
}

function _saveEnabled(): void {
  store.set('_enabled', _enabled);
}

export function isEnabled(): boolean {
  return _enabled;
}

export function toggleEnabled(): boolean {
  _enabled = !_enabled;
  _saveEnabled();
  if (!_enabled) lock();
  return _enabled;
}

export function setDefault(id: string): void {
  const entries = store.get('entries') || [];
  const idx = entries.findIndex((e: any) => e.id === id);
  if (idx < 0) return;
  entries[idx].updatedAt = Date.now();
  store.set('entries', entries);
}

export function dispose(): void {
  if (_dekFromMaster) {
    try { _dekFromMaster.fill(0); } catch (_e) { /* ignore */ }
    _dekFromMaster = null;
  }
}
