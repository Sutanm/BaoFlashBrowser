import crypto from 'crypto';
import fs from 'fs';
import Store from 'electron-store';
import log from 'electron-log';
import {
  EncBlob, KEY_LEN,
  b64, unb64, encryptStr, decryptStr, encryptBuf, decryptBuf,
} from './crypto-helper';
import { domainMatchesRule, normalizeDomainRule } from '../utils/domain-rules';
import { selectFillEntry } from '../utils/password-fill-policy';
import { detectKeyring, getActiveBackendId, keyringWrap, keyringUnwrap, type KeyringFailureKind } from './keyring';

/**
 * password-store.ts — 密码本 v2（无主密码）。
 *
 * 数据形态：{ version: 2, dekAutoFillEnc, entries[], viewFallback? }。
 * - DEK（随机 32B）加密所有条目；DEK 本身只由 auto-fill wrap key 保管
 *   （dekAutoFillEnc = encryptBuf(wrapKey, dek)）。
 * - wrap key 按档位存放：A = OS 密钥库（keyEnc，keyring 加密）；
 *   C′ = 本地弱保护（keyLocal，可逆混淆 + 0600，等同 Chromium basic_text）。
 * - 无"解锁/锁定"概念：DEK 启动即经 wrap key 解出，常驻 _dek；
 *   填充/增删改不再要求任何输入；"查看明文"门禁由 view-gate（Task 5+）承担。
 * - 不做存量兼容（决策 8）：v1 密码本 / 旧明文 key 检测到即改名
 *   `.legacy.bak` 搁置，不读取、不迁移。
 */

const LEGACY_SUFFIX = '.legacy.bak';
const LOCAL_MASK_CONTEXT = 'bao-flash-browser:auto-fill-key-local:v1';

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
  dekAutoFillEnc: EncBlob | null;
  entries: StoredEntry[];
  /** C′ 可选兜底查看密码的哈希（预留位，Task 5 才填充；默认 null）。 */
  viewFallback: { salt: string; hash: string } | null;
  _enabled: boolean;
  _autoCapture: boolean;
  _autoFill: boolean;
  _excludedSites: string[];
}

interface AutoFillKeySchema {
  keyEnc: string | null;
  keyLocal: string | null;
  /** 旧版明文遗留（读取即搁置，绝不复用）。 */
  key?: string | null;
  keyPlain?: string | null;
}

const store = new Store<PasswordStoreSchema>({
  name: 'password-store',
  defaults: {
    version: 2,
    dekAutoFillEnc: null,
    entries: [],
    viewFallback: null,
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

const autoFillKeyStore = new Store<AutoFillKeySchema>({
  name: 'password-autofill-key',
  defaults: { keyEnc: null, keyLocal: null },
});

/** 单一 DEK：v2 下是条目解密与填充的唯一钥匙（原 _dekFromMaster/_dekForAutoFill 并轨）。 */
let _dek: Buffer | null = null;

// ---------------------------------------------------------------------------
// 密钥获取失败语义（规格 D1/D2，2026-09-21 事故根因修复）
//
// 硬不变式：**读取/解封路径不得写盘**。任何失败都必须保留密钥材料原样，
// 因为读路径拿到的错误不足以区分"这把 key 永久作废"与"这一刻拿不到"，
// 而后者若被当成前者处理（搁置 + 轮换）= 丢弃全部条目（不可逆）。
// 唯一允许销毁/轮换密钥材料的地方：enroll（initVault / 用户显式重建）
// 与旧明文 key 迁移（决策 8，白名单例外）。
// ---------------------------------------------------------------------------

/** 密码本侧的密钥失败种类：keyring 传输层 5 种 + 存储层 4 种。 */
export type PasswordKeyFailureKind =
  | KeyringFailureKind
  | 'key-length-mismatch'
  | 'corrupt-local'
  | 'legacy-plaintext'
  | 'key-material-missing';

/** 确定性失败：文件保留、状态 blocked、等用户显式决策（绝不自动轮换）。 */
const DETERMINISTIC_KEY_FAILURES: ReadonlySet<PasswordKeyFailureKind> = new Set<PasswordKeyFailureKind>([
  'decrypt-failed',
  'key-length-mismatch',
  'corrupt-local',
  'legacy-plaintext',
  'key-material-missing',
]);

export function isDeterministicKeyFailure(kind: PasswordKeyFailureKind): boolean {
  return DETERMINISTIC_KEY_FAILURES.has(kind);
}

interface WrapKeyLoad {
  key: Buffer | null;
  /** 无 key 但也不该报错（尚未 enroll）时为 'ok'。 */
  outcome: 'ok' | 'transient' | 'deterministic';
  kind?: PasswordKeyFailureKind;
  reason?: string;
  backend?: string | null;
}

/** 最近一次密钥加载结果（K1 仅供日志与内部判断；K3 经 IPC 暴露给 UI）。 */
let _keyLoadState: { outcome: 'ok' | 'transient' | 'deterministic'; kind?: PasswordKeyFailureKind; reason?: string; backend?: string | null; attempts: number } = { outcome: 'ok', attempts: 0 };

export function getKeyLoadState(): Readonly<typeof _keyLoadState> {
  return { ..._keyLoadState };
}

// ---------------------------------------------------------------------------
// 旧数据搁置（决策 8；检测条件审计 #10：非 null 判定 + version<2）
// ---------------------------------------------------------------------------

/** 纯函数（可单测）：v1 密码本特征 = version<2，或 salt/dekMasterEnc 存在且非 null。 */
export function _looksLikeLegacyStoreText(jsonText: string): boolean {
  try {
    const data = JSON.parse(jsonText) as Record<string, unknown>;
    if (!data || typeof data !== 'object') return true;
    if (typeof data.version === 'number') return data.version < 2;
    return Boolean(data.salt) && Boolean(data.dekMasterEnc);
  } catch {
    return true; // 无法解析 → 按旧/损坏数据搁置
  }
}

/** 纯函数（可单测）：旧明文 key 特征 = key / keyPlain 非空字符串。 */
export function _looksLikeLegacyPlainKey(parsed: unknown): boolean {
  const data = parsed as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') return false;
  return (typeof data.key === 'string' && data.key.length > 0)
    || (typeof data.keyPlain === 'string' && data.keyPlain.length > 0);
}

function _readJsonFileSafe(filePath: string): unknown | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function _shelfFile(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const backup = `${filePath}${LEGACY_SUFFIX}`;
    if (fs.existsSync(backup)) fs.unlinkSync(backup);
    fs.renameSync(filePath, backup);
    log.warn('[password-store] legacy data shelved:', backup);
  } catch (error) {
    log.warn('[password-store] shelf failed:', error instanceof Error ? error.message : String(error));
  }
}

/** 检测 v1 密码本文件并搁置；命中返回 true（调用方随后重置为 v2 默认）。 */
function _shelveLegacyStoreIfAny(): boolean {
  const raw = _readJsonFileSafe(store.path);
  if (raw === null) return false; // 全新安装，无文件
  if (_looksLikeLegacyStoreText(JSON.stringify(raw))) {
    _shelfFile(store.path);
    return true;
  }
  return false;
}

function _resetStoreToFreshV2(): void {
  store.clear();
  store.set('version', 2);
  store.set('dekAutoFillEnc', null);
  store.set('entries', []);
  store.set('viewFallback', null);
  store.set('_enabled', _enabled);
  store.set('_autoCapture', _autoCapture);
  store.set('_autoFill', _autoFill);
  store.set('_excludedSites', _excludedSites);
  autoFillKeyStore.clear();
  _clearDek();
}

// ---------------------------------------------------------------------------
// C′ 本地弱保护（仅防文本直读，不防任何主动攻击者 —— 等同 Chromium basic_text）
// ---------------------------------------------------------------------------

function _localMask(length: number): Buffer {
  const out = Buffer.alloc(length);
  let block = Buffer.from(LOCAL_MASK_CONTEXT, 'utf8');
  let offset = 0;
  while (offset < length) {
    block = crypto.createHash('sha256').update(block).digest();
    const take = Math.min(block.length, length - offset);
    block.copy(out, offset, 0, take);
    offset += take;
  }
  return out;
}

function _obfuscateLocal(key: Buffer): string {
  const mask = _localMask(key.length);
  const xored = Buffer.alloc(key.length);
  for (let i = 0; i < key.length; i++) xored[i] = key[i] ^ mask[i];
  mask.fill(0);
  return `v1:${b64(xored)}`;
}

function _deobfuscateLocal(encoded: string): Buffer | null {
  try {
    if (!encoded.startsWith('v1:')) return null;
    const xored = unb64(encoded.slice(3));
    const mask = _localMask(xored.length);
    const key = Buffer.alloc(xored.length);
    for (let i = 0; i < xored.length; i++) key[i] = xored[i] ^ mask[i];
    mask.fill(0);
    return key;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// wrap key（auto-fill key）生命周期：A = OS 密钥库 / C′ = 本地弱保护
// ---------------------------------------------------------------------------

function _chmodKeyFile(): void {
  try {
    if (process.platform !== 'win32') fs.chmodSync(autoFillKeyStore.path, 0o600);
  } catch { /* best-effort permissions hardening */ }
}

async function _currentTier(): Promise<'A' | 'C'> {
  const status = await detectKeyring();
  return status.backend ? 'A' : 'C';
}

/** 按档位持久化 wrap key；任一失败返回 false（调用方零化后不落盘）。 */
async function _persistWrapKey(key: Buffer, tier: 'A' | 'C'): Promise<boolean> {
  if (tier === 'A') {
    const enc = await keyringWrap(b64(key));
    if (!enc.ok) return false;
    autoFillKeyStore.set('keyEnc', enc.blob);
    autoFillKeyStore.set('keyLocal', null);
    return true;
  }
  autoFillKeyStore.set('keyLocal', _obfuscateLocal(key));
  autoFillKeyStore.set('keyEnc', null);
  _chmodKeyFile();
  return true;
}

/**
 * 读当前可用 wrap key。
 *
 * **零破坏**：本函数在任何失败分支都不改名、不清空、不轮换密钥材料，
 * 只返回分类后的 outcome 交给调用方（重试 / 上报 / 等用户决策）。
 * 唯一的写盘例外是旧明文 key 迁移（决策 8 白名单：搁置不读；此处不迁移，
 * 因为键已被 `_looksLikeLegacyPlainKey` 判定为不可信遗留）。
 */
async function _loadWrapKey(): Promise<WrapKeyLoad> {
  const raw = _readJsonFileSafe(autoFillKeyStore.path);
  if (raw !== null && _looksLikeLegacyPlainKey(raw)) {
    // 决策 8：旧明文 key 不读取、不迁移 —— 唯一的读路径搁置白名单。
    _shelfFile(autoFillKeyStore.path);
    autoFillKeyStore.clear();
    return { key: null, outcome: 'deterministic', kind: 'legacy-plaintext', reason: 'legacy-plaintext' };
  }
  const keyEnc = autoFillKeyStore.get('keyEnc');
  if (keyEnc) {
    const result = await keyringUnwrap(keyEnc);
    if (!result.ok) {
      const outcome = isDeterministicKeyFailure(result.kind) ? 'deterministic' : 'transient';
      log.warn(
        `[password-store] wrap key unavailable kind=${result.kind} reason=${result.reason}`
        + `${result.detail ? ` detail=${result.detail}` : ''} backend=${getActiveBackendId() ?? 'none'}`
        + ' (key file kept, no rotation)',
      );
      return {
        key: null,
        outcome,
        kind: result.kind,
        reason: result.reason,
        backend: getActiveBackendId(),
      };
    }
    const key = unb64(result.secret);
    if (key.length !== KEY_LEN) {
      key.fill(0);
      log.warn(`[password-store] wrap key length mismatch expected=${KEY_LEN} (key file kept, no rotation)`);
      return { key: null, outcome: 'deterministic', kind: 'key-length-mismatch', reason: 'key-length-mismatch' };
    }
    return { key, outcome: 'ok' };
  }
  const keyLocal = autoFillKeyStore.get('keyLocal');
  if (keyLocal) {
    const key = _deobfuscateLocal(keyLocal);
    if (!key || key.length !== KEY_LEN) {
      if (key) key.fill(0);
      log.warn('[password-store] local wrap key unreadable (key file kept, no rotation)');
      return { key: null, outcome: 'deterministic', kind: 'corrupt-local', reason: 'corrupt-local' };
    }
    return { key, outcome: 'ok' };
  }
  // 无任何 key = 尚未 enroll，不是失败。
  return { key: null, outcome: 'ok' };
}

// ---------------------------------------------------------------------------
// DEK 生命周期
// ---------------------------------------------------------------------------

function _clearDek(): void {
  if (_dek) {
    try { _dek.fill(0); } catch { /* ignore */ }
    _dek = null;
  }
}

/** v2 无解锁态；DEK 是否就绪（save-confirm/编辑守卫）。 */
export function isDekReady(): boolean {
  return !!_dek;
}

/** 当前 DEK（只读引用，调用方禁止长期持有；主要为内部与门禁使用）。 */
export function getDek(): Buffer | null {
  return _dek;
}

function _getDekForWrite(): Buffer {
  if (!_dek) throw new Error('Password store not ready');
  return _dek;
}

/** v2 vault 已建立（dekAutoFillEnc 落盘）。 */
export function isInitialized(): boolean {
  return !!store.get('dekAutoFillEnc');
}

/** 启动加载：搁置旧数据 → 按 A/C′ 解出 DEK。 */
export async function init(): Promise<void> {
  _loadEnabled();
  if (_shelveLegacyStoreIfAny()) _resetStoreToFreshV2();
  if (!_enabled) return;
  await _loadDekFromStore();
}

async function _loadDekFromStore(): Promise<'ok' | 'transient' | 'deterministic'> {
  _clearDek();
  if (!isInitialized()) {
    _keyLoadState = { outcome: 'ok', attempts: 0 };
    return 'ok';
  }
  const blob = store.get('dekAutoFillEnc');
  if (!blob) {
    _keyLoadState = { outcome: 'ok', attempts: 0 };
    return 'ok';
  }
  const loaded = await _loadWrapKey();
  if (!loaded.key) {
    if (loaded.outcome === 'ok') {
      // 库已建但 keyEnc / keyLocal 皆空 —— 密钥材料缺失（例如被历史版本的破坏性
      // 失败处理搁置过）。确定性失败：绝不静默装作正常，也不自行重建。
      log.warn('[password-store] vault initialized but no key material present (no rotation, user decision required)');
      _keyLoadState = {
        outcome: 'deterministic',
        kind: 'key-material-missing',
        reason: 'key-material-missing',
        backend: getActiveBackendId(),
        attempts: _keyLoadState.attempts + 1,
      };
      return 'deterministic';
    }
    _keyLoadState = {
      outcome: loaded.outcome,
      kind: loaded.kind,
      reason: loaded.reason,
      backend: loaded.backend ?? getActiveBackendId(),
      attempts: _keyLoadState.attempts + 1,
    };
    return loaded.outcome;
  }
  const dek = decryptBuf(loaded.key, blob);
  loaded.key.fill(0);
  if (!dek) {
    // 有 wrap key 却解不开 dekAutoFillEnc ⇒ 密钥与密文不匹配。保留文件，不轮换。
    log.warn('[password-store] DEK unwrap failed with the stored wrap key (key file kept, no rotation)');
    _keyLoadState = {
      outcome: 'deterministic',
      kind: 'decrypt-failed',
      reason: 'dek-unwrap-failed',
      backend: getActiveBackendId(),
      attempts: _keyLoadState.attempts + 1,
    };
    return 'deterministic';
  }
  _dek = dek;
  _keyLoadState = { outcome: 'ok', attempts: 0 };
  return 'ok';
}

/** 新建 v2 密码本（无密码）：生成 DEK → wrap key 按档位落盘 → dekAutoFillEnc。 */
export async function initVault(): Promise<{ success: boolean; tier: 'A' | 'C' | null }> {
  const tier = await _currentTier();
  if (isInitialized()) {
    await _loadDekFromStore();
    return { success: !!_dek, tier };
  }
  const dek = crypto.randomBytes(KEY_LEN);
  const wrapKey = crypto.randomBytes(KEY_LEN);
  if (!(await _persistWrapKey(wrapKey, tier))) {
    dek.fill(0);
    wrapKey.fill(0);
    return { success: false, tier };
  }
  store.set('version', 2);
  store.set('dekAutoFillEnc', encryptBuf(wrapKey, dek));
  store.set('entries', store.get('entries') || []);
  store.set('viewFallback', null);
  wrapKey.fill(0);
  _clearDek();
  _dek = dek;
  return { success: true, tier };
}

/** 供状态 IPC：当前档位（A/C′/未启用 → null）。 */
export async function getTier(): Promise<'A' | 'C' | null> {
  if (!isInitialized()) return null;
  return _currentTier();
}

// ---------------------------------------------------------------------------
// 条目 CRUD（全部基于 _dek，无解锁态）
// ---------------------------------------------------------------------------

export function listEntries(): EntryMeta[] {
  const entries = store.get('entries') || [];
  return entries.map((entry) => ({
    id: entry.id,
    host: entry.host,
    origin: entry.origin,
    title: entry.title,
    username: entry.username,
    updatedAt: entry.updatedAt,
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
    origin: opts.origin || `https://${opts.host}`,
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
    entry.passwordEnc = encryptStr(dek, fields.password);
  }
  entry.updatedAt = Date.now();
  entries[idx] = entry;
  store.set('entries', entries);
  return true;
}

export function deleteEntry(id: string): boolean {
  const current = store.get('entries') || [];
  const entries = current.filter((entry) => entry.id !== id);
  if (entries.length === current.length) return false;
  store.set('entries', entries);
  return true;
}

/** 纯解密函数：由 view-gate 授权后的 reveal 路径调用（Task 5+），本层不做门禁。 */
export function getDecryptedPassword(id: string): string | null {
  if (!_dek) return null;
  const idx = _findEntryIndex(id);
  if (idx < 0) return null;
  const entries = store.get('entries') || [];
  return decryptStr(_dek, entries[idx].passwordEnc);
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
  if (!_dek) return null;
  const entry = selectFillEntry(store.get('entries') || [], pageUrl, requestedId);
  if (!entry) return null;
  const password = decryptStr(_dek, entry.passwordEnc);
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
  if (!_dek) return [];
  const entries = store.get('entries') || [];
  const normalizedHost = _normalizeHost(host);
  const out: { username: string; password: string }[] = [];
  for (const entry of entries) {
    if (_normalizeHost(entry.host) === normalizedHost) {
      const password = decryptStr(_dek, entry.passwordEnc);
      if (password !== null) out.push({ username: entry.username, password });
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

function _genId(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function resetAll(): void {
  store.clear();
  store.set('_enabled', _enabled);
  store.set('_autoCapture', _autoCapture);
  store.set('_autoFill', _autoFill);
  store.set('_excludedSites', _excludedSites);
  autoFillKeyStore.clear();
  _clearDek();
  _keyLoadState = { outcome: 'ok', attempts: 0 };
}

// ---------------------------------------------------------------------------
// 开关与设置（语义保持；解锁/锁定状态机随主密码退役删除）
// ---------------------------------------------------------------------------

let _enabled = true;
let _autoCapture = true;
let _autoFill = true;
let _excludedSites: string[] = [];

function _loadEnabled(): void {
  const enabled = store.get('_enabled');
  if (typeof enabled === 'boolean') _enabled = enabled;
  const autoCapture = store.get('_autoCapture');
  if (typeof autoCapture === 'boolean') _autoCapture = autoCapture;
  const autoFill = store.get('_autoFill');
  if (typeof autoFill === 'boolean') _autoFill = autoFill;
  const excludedSites = store.get('_excludedSites');
  if (Array.isArray(excludedSites)) _excludedSites = excludedSites.map(normalizeDomainRule).filter((site): site is string => !!site);
}

export function isEnabled(): boolean {
  return _enabled;
}

export function toggleEnabled(): boolean {
  _enabled = !_enabled;
  store.set('_enabled', _enabled);
  if (_enabled) void _loadDekFromStore();
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

/** auto-fill 是否就绪：开关开 + vault 已建 + DEK 在内存（v2 无解锁态，启动即就绪）。 */
export function isAutoFillReady(): boolean {
  return _autoFill && isInitialized() && !!_dek;
}

export function setAutoFill(enabled: boolean): boolean {
  _autoFill = enabled;
  store.set('_autoFill', enabled);
  if (enabled) void _loadDekFromStore();
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
  const idx = entries.findIndex((entry) => entry.id === id);
  if (idx < 0) return;
  entries[idx].updatedAt = Date.now();
  store.set('entries', entries);
}

export function dispose(): void {
  _clearDek();
}
