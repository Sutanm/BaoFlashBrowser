import crypto from 'crypto';
import fs from 'fs';
import Store from 'electron-store';
import {
  EncBlob, SALT_LEN, KEY_LEN,
  b64, unb64, deriveKek, encryptStr, decryptStr, encryptBuf, decryptBuf,
} from './crypto-helper';
import { domainMatchesRule, normalizeDomainRule } from '../utils/domain-rules';
import { selectFillEntry } from '../utils/password-fill-policy';

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
  dekAutoFillEnc: EncBlob | null;
  entries: StoredEntry[];
  _enabled: boolean;
  _autoCapture: boolean;
  _autoFill: boolean;
  _excludedSites: string[];
}

const store = new Store<PasswordStoreSchema>({
  name: 'password-store',
  defaults: {
    version: 1,
    salt: null,
    dekMasterEnc: null,
    dekAutoFillEnc: null,
    entries: [],
    _enabled: true,
    _autoCapture: true,
    _autoFill: true,
    _excludedSites: [],
  },
  schema: {
    _enabled: { type: 'boolean' },
    _autoCapture: { type: 'boolean' },
    _autoFill: { type: 'boolean' },
    _excludedSites: { type: 'array', items: { type: 'string' } },
  } as any,
});

let _dekFromMaster: Buffer | null = null;
let _dekForAutoFill: Buffer | null = null;

const autoFillKeyStore = new Store<{ key: string | null }>({
  name: 'password-autofill-key',
  defaults: { key: null },
});

function _clearAutoFillDek(): void {
  if (_dekForAutoFill) {
    try { _dekForAutoFill.fill(0); } catch { /* ignore */ }
    _dekForAutoFill = null;
  }
}

function _ensureAutoFillWrap(dek: Buffer): void {
  const keyText = autoFillKeyStore.get('key');
  let key: Buffer;
  if (keyText) {
    key = unb64(keyText);
    if (key.length !== KEY_LEN) {
      key.fill(0);
      key = crypto.randomBytes(KEY_LEN);
      autoFillKeyStore.set('key', b64(key));
    }
  } else {
    key = crypto.randomBytes(KEY_LEN);
    autoFillKeyStore.set('key', b64(key));
    try {
      if (process.platform !== 'win32') fs.chmodSync(autoFillKeyStore.path, 0o600);
    } catch { /* best-effort permissions hardening */ }
  }
  store.set('dekAutoFillEnc', encryptBuf(key, dek));
  _clearAutoFillDek();
  _dekForAutoFill = Buffer.from(dek);
  key.fill(0);
}

function _tryEnsureAutoFillWrap(dek: Buffer): void {
  try {
    _ensureAutoFillWrap(dek);
  } catch {
    // Auto-fill enrollment must never prevent setup or a valid master unlock.
    _clearAutoFillDek();
  }
}

function _loadAutoFillDek(): void {
  _clearAutoFillDek();
  if (!_autoFill || !isInitialized()) return;
  const keyText = autoFillKeyStore.get('key');
  const wrapped = store.get('dekAutoFillEnc');
  if (!keyText || !wrapped) return;
  const key = unb64(keyText);
  _dekForAutoFill = decryptBuf(key, wrapped);
  key.fill(0);
}

function _genId(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function isInitialized(): boolean {
  return !!(store.get('salt') && store.get('dekMasterEnc'));
}

export async function init(): Promise<void> {
  _loadEnabled();
  if (_enabled) _loadAutoFillDek();
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
  const kek = await deriveKek(password, salt);
  const dekMasterEnc = encryptBuf(kek, dek);
  store.set({
    version: 1,
    salt: b64(salt),
    dekMasterEnc,
    entries: [],
  });
  _dekFromMaster = dek;
  if (_autoFill) _tryEnsureAutoFillWrap(dek);
  return true;
}

export async function unlockWithMaster(password: string): Promise<boolean> {
  if (!isInitialized()) return false;
  const salt = unb64(store.get('salt')!);
  const kek = await deriveKek(password, salt);
  const dek = decryptBuf(kek, store.get('dekMasterEnc')!);
  if (!dek) return false;
  _dekFromMaster = dek;
  if (_autoFill) _tryEnsureAutoFillWrap(dek);
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

export interface FillCredential {
  id: string;
  host: string;
  origin: string;
  username: string;
  password: string;
}

/** Select and decrypt one credential for a concrete frame URL. */
export function getFillCredentialForUrl(
  pageUrl: string,
  requestedId?: string,
  automatic = true,
): FillCredential | null {
  if (!_enabled || (automatic && !_autoFill)) return null;
  const dek = _dekForAutoFill || _dekFromMaster;
  if (!dek) return null;
  const entry = selectFillEntry(store.get('entries') || [], pageUrl, requestedId);
  if (!entry) return null;
  const password = decryptStr(dek, entry.passwordEnc);
  if (password === null) return null;
  return {
    id: entry.id,
    host: entry.host,
    origin: entry.origin,
    username: entry.username,
    password,
  };
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
  if (!await unlockWithMaster(oldPwd)) return false;
  const dek = _dekFromMaster!;
  const salt = crypto.randomBytes(SALT_LEN);
  const kek = await deriveKek(newPwd, salt);
  store.set({
    salt: b64(salt),
    dekMasterEnc: encryptBuf(kek, dek),
  } as any);
  return true;
}

export function resetAll(): void {
  store.clear();
  // Reset encrypted credentials only; capture preferences are independent user settings.
  store.set('_enabled', _enabled);
  store.set('_autoCapture', _autoCapture);
  store.set('_autoFill', _autoFill);
  store.set('_excludedSites', _excludedSites);
  autoFillKeyStore.clear();
  _clearAutoFillDek();
  if (_dekFromMaster) {
    try { _dekFromMaster.fill(0); } catch (_e) { /* ignore */ }
    _dekFromMaster = null;
  }
}

let _enabled = true;
let _autoCapture = true;
let _autoFill = true;
let _excludedSites: string[] = [];

function _loadEnabled(): void {
  const val = store.get('_enabled');
  if (typeof val === 'boolean') _enabled = val;
  const autoCapture = store.get('_autoCapture');
  if (typeof autoCapture === 'boolean') _autoCapture = autoCapture;
  const autoFill = store.get('_autoFill');
  if (typeof autoFill === 'boolean') _autoFill = autoFill;
  const excludedSites = store.get('_excludedSites');
  if (Array.isArray(excludedSites)) _excludedSites = excludedSites.map(normalizeDomainRule).filter((site): site is string => !!site);
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
  if (!_enabled) {
    lock();
    _clearAutoFillDek();
  }
  return _enabled;
}

export function isAutoCaptureEnabled(): boolean {
  return _autoCapture;
}

export function setAutoCapture(enabled: boolean): boolean {
  _autoCapture = enabled;
  store.set('_autoCapture', enabled);
  return _autoCapture;
}

export function isAutoFillEnabled(): boolean {
  return _autoFill;
}

export function isAutoFillReady(): boolean {
  return !!_dekForAutoFill;
}

export function setAutoFill(enabled: boolean): boolean {
  _autoFill = enabled;
  store.set('_autoFill', enabled);
  if (!enabled) {
    _clearAutoFillDek();
  } else if (_dekFromMaster) {
    _tryEnsureAutoFillWrap(_dekFromMaster);
  } else {
    _loadAutoFillDek();
  }
  return _autoFill;
}

export function getExcludedSites(): string[] {
  return [..._excludedSites];
}

export function setExcludedSites(sites: string[]): string[] {
  _excludedSites = [...new Set(sites.map(normalizeDomainRule).filter((site): site is string => !!site))].sort();
  store.set('_excludedSites', _excludedSites);
  return getExcludedSites();
}

export function isCaptureExcluded(urlOrHost: string): boolean {
  return _excludedSites.some((site) => domainMatchesRule(urlOrHost, site));
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
  _clearAutoFillDek();
}
