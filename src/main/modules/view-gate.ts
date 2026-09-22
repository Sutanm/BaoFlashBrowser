import crypto from 'crypto';
import Store from 'electron-store';
import log from 'electron-log';
import { PBKDF2_ITER, SALT_LEN, b64, unb64 } from './crypto-helper';
import {
  getViewFallback, setViewFallback, isDekReady, isInitialized, getTier,
  type ViewFallbackRecord,
} from './password-store';
import type { ViewGuardStatus } from '../../shared/types/passwords';
import { createWinCredUiBackend } from './view-gate-win';

/**
 * view-gate.ts — "查看密码明文"的门禁（规格：docs/superpowers/specs/2026-09-22-view-gate-design.md）。
 *
 * 目标只有一个：**防窥屏**（肩窥、旁人、临时离座）——不假装防本地攻击者（§10 局限清单）。
 *
 * 铁律
 * - G1 门禁在解密之前：本模块只决定"能不能看"，绝不接触明文；
 *   `getDecryptedPassword()` 只允许在 `authorizeView()` 返回 ok 之后由 IPC 调用。
 * - G2 明文只出一次：本模块不记录、不回传、不落盘任何口令。
 * - G3 任何校验入口都计入失败计数（含"修改查看密码"的 current 校验）——
 *   否则那条路径就是一个免计数的暴力破解口。
 * - G12 无会话豁免：**每一次查看都验证**，因此本模块不保存任何 granted 标志。
 *
 * 分层：本模块读写 `viewFallback`（经 password-store 的访问器）与独立的守卫存储，
 * password-store 不反向依赖本模块（与 keyring 的分层一致，避免环形依赖）。
 */

/** 连续失败上限（用户拍板：5 次）。 */
export const MAX_VIEW_FAILURES = 5;
/** 触顶后的锁定时长（用户拍板：30 分钟）。 */
export const VIEW_LOCK_MS = 30 * 60 * 1000;
/** 查看密码长度下限。不做复杂度强制：目标是防窥屏，爆破由锁定负责。 */
export const VIEW_PASSWORD_MIN = 6;
export const VIEW_PASSWORD_MAX = 128;

export type ViewAuthCode =
  | 'ok'
  /** 锁定期内（含正确口令也拒绝）。 */
  | 'locked'
  /** C 档尚未设置查看密码 → 引导设置。 */
  | 'needs-setup'
  /** 密码模式但本次没带口令（调用方未输入）。 */
  | 'needs-input'
  /** 口令/凭据错误（已计入失败）。 */
  | 'wrong-credential'
  /** 用户取消了系统验证对话框（不计入失败）。 */
  | 'cancelled'
  /** 验证通道不可用/超时，fail closed（不计入失败）。 */
  | 'unavailable'
  /** Windows 账户已被系统锁定（不计入失败）。 */
  | 'account-locked'
  /** OS 验证不可用，已降级为查看密码（不计入失败）。 */
  | 'degraded'
  /** 无门禁可用（未建库 / 密钥不可用）。 */
  | 'none';

export interface ViewAuthResult {
  ok: boolean;
  code: ViewAuthCode;
  /** 仅 wrong-credential：还剩几次机会。 */
  remainingAttempts?: number;
  /** 仅 locked：剩余毫秒。 */
  lockedForMs?: number;
  /** 机器码补充，供 UI 分类提示（不含任何口令信息）。 */
  reason?: string;
}

export interface OsVerifyResultOk {
  ok: true;
}
export type OsVerifyFailureKind =
  | 'bad-credential'
  | 'cancelled'
  | 'not-current-user'
  | 'account-locked'
  | 'unusable-account'
  | 'denied'
  | 'unavailable';
export type OsVerifyResult = OsVerifyResultOk | { ok: false; kind: OsVerifyFailureKind; reason?: string };

/** OS 身份验证后端（Windows 由 view-gate-win.ts 提供；darwin/linux 尚未实现 → 无后端）。 */
export interface OsVerifyBackend {
  readonly id: 'win-credui';
  available(): Promise<boolean>;
  verify(): Promise<OsVerifyResult>;
}

interface ViewGuardSchema {
  failCount: number;
  lockedUntil: number | null;
  /** OS 验证被判定不可用（空密码/禁用/策略拒绝）→ 永久降级为查看密码（规格 G10）。 */
  osAuthUnavailable: boolean;
}

/**
 * 守卫状态独立存储：**不随 `resetAll()` / 重建密码本清除**。
 * 锁定记录是关于"尝试"的，不是关于"数据"的——重建后仍应受同样的锁定约束。
 */
const guardStore = new Store<ViewGuardSchema>({
  name: 'password-view-guard',
  defaults: { failCount: 0, lockedUntil: null, osAuthUnavailable: false },
});

// ---------------------------------------------------------------------------
// 测试注入缝（生产链路不设置）
// ---------------------------------------------------------------------------

/** `undefined` = 未注入（按平台取真实后端）；`null` = 显式"无后端"。 */
let _osBackendOverride: OsVerifyBackend | null | undefined;
let _platformOverride: NodeJS.Platform | null = null;

export function _setOsBackendForTest(backend: OsVerifyBackend | null): void {
  _osBackendOverride = backend;
}

export function _setPlatformForTest(platform: NodeJS.Platform | null): void {
  _platformOverride = platform;
}

export function _resetViewGateForTest(): void {
  // 写默认值而不是 clear()：mock 的 electron-store 只在首次构造时铺 defaults，
  // clear() 之后取键会得到 undefined，把断言变成测装置自身的行为。
  _writeState({ failCount: 0, lockedUntil: null, osAuthUnavailable: false });
  _osBackendOverride = undefined;
  _platformOverride = null;
}

// ---------------------------------------------------------------------------
// 失败计数与锁定（规格 G7）
// ---------------------------------------------------------------------------

interface GuardState {
  failCount: number;
  lockedUntil: number | null;
  osAuthUnavailable: boolean;
}

function _readState(now = Date.now()): GuardState {
  const state: GuardState = {
    failCount: guardStore.get('failCount') ?? 0,
    lockedUntil: guardStore.get('lockedUntil') ?? null,
    osAuthUnavailable: guardStore.get('osAuthUnavailable') ?? false,
  };
  // 锁定期满即清零，给回完整的重试次数。
  if (state.lockedUntil !== null && now >= state.lockedUntil) {
    state.failCount = 0;
    state.lockedUntil = null;
    _writeState(state);
  }
  return state;
}

function _writeState(state: GuardState): void {
  guardStore.set('failCount', state.failCount);
  guardStore.set('lockedUntil', state.lockedUntil);
  guardStore.set('osAuthUnavailable', state.osAuthUnavailable);
}

/** 纯函数（可单测）：第 n 次连续失败后的计数与锁定。 */
export function computeFailOutcome(
  failCount: number,
  now: number,
): { failCount: number; lockedUntil: number | null; remainingAttempts: number } {
  if (failCount >= MAX_VIEW_FAILURES) {
    return { failCount, lockedUntil: now + VIEW_LOCK_MS, remainingAttempts: 0 };
  }
  return { failCount, lockedUntil: null, remainingAttempts: MAX_VIEW_FAILURES - failCount };
}

export function isViewLocked(now = Date.now()): { locked: boolean; lockedForMs: number } {
  const state = _readState(now);
  if (state.lockedUntil === null || now >= state.lockedUntil) return { locked: false, lockedForMs: 0 };
  return { locked: true, lockedForMs: state.lockedUntil - now };
}

/**
 * 记一次失败。返回 `lockedForMs` 表示**这次失败同时触发了锁定**。
 *
 * 触发锁定的那次仍以 `wrong-credential` 返回（并附带 `lockedForMs`），
 * 这样 UI 能同时说清"口令错了"和"已被锁 30 分钟"；此后才返回 `locked`。
 */
/**
 * 记一次失败。返回 `lockedForMs` 表示**这次失败同时触发了锁定**。
 *
 * 触发锁定的那次仍以 `wrong-credential` 返回（并附带 `lockedForMs`），
 * 这样 UI 能同时说清"口令错了"和"已被锁 30 分钟"；此后才返回 `locked`。
 */
function _registerFailure(now = Date.now()): { remainingAttempts: number; lockedForMs?: number } {
  const state = _readState(now);
  const outcome = computeFailOutcome(state.failCount + 1, now);
  _writeState({ ...state, failCount: outcome.failCount, lockedUntil: outcome.lockedUntil });
  if (outcome.lockedUntil !== null) {
    log.warn(
      `[view-gate] locked for ${Math.round(VIEW_LOCK_MS / 60000)}min after `
      + `${outcome.failCount} consecutive failures`,
    );
    return { remainingAttempts: 0, lockedForMs: VIEW_LOCK_MS };
  }
  return { remainingAttempts: outcome.remainingAttempts };
}

function _clearFailures(): void {
  const state = _readState();
  if (state.failCount === 0 && state.lockedUntil === null) return;
  _writeState({ ...state, failCount: 0, lockedUntil: null });
}

function _remainingAttempts(now = Date.now()): number {
  const state = _readState(now);
  if (state.lockedUntil !== null && now < state.lockedUntil) return 0;
  return Math.max(0, MAX_VIEW_FAILURES - state.failCount);
}

// ---------------------------------------------------------------------------
// 查看密码（规格 G6）
// ---------------------------------------------------------------------------

function _derive(password: string, salt: Buffer, iter: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, iter, 32, 'sha256', (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** 常量时间比对；记录损坏时返回 false（不抛）。 */
async function _verifyPassword(candidate: string, record: ViewFallbackRecord): Promise<boolean> {
  const expected = unb64(record.hash);
  const iter = Number.isFinite(record.iter) && record.iter > 0 ? record.iter : PBKDF2_ITER;
  const actual = await _derive(candidate, unb64(record.salt), iter);
  try {
    if (expected.length === 0 || expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  } finally {
    actual.fill(0);
    expected.fill(0);
  }
}

export interface SetViewPasswordResult {
  success: boolean;
  error?: string;
  remainingAttempts?: number;
  lockedForMs?: number;
}

/**
 * 设置 / 修改查看密码（规格 G6）。
 *
 * 已存在时必须提供 `current` 且校验通过——这条校验**计入失败计数**（G3）。
 * 锁定期间不接受任何设置，否则锁定可被"改密"绕开。
 */
export async function setViewPassword(next: string, current?: string): Promise<SetViewPasswordResult> {
  if (typeof next !== 'string' || next.length < VIEW_PASSWORD_MIN || next.length > VIEW_PASSWORD_MAX) {
    return { success: false, error: 'weak-password' };
  }
  const lock = isViewLocked();
  if (lock.locked) return { success: false, error: 'locked', lockedForMs: lock.lockedForMs };

  const existing = getViewFallback();
  if (existing) {
    if (typeof current !== 'string' || current.length === 0) {
      return { success: false, error: 'current-required' };
    }
    if (!(await _verifyPassword(current, existing))) {
      const failure = _registerFailure();
      log.warn(`[view-gate] view password change rejected (remaining=${failure.remainingAttempts})`);
      return {
        success: false,
        error: 'wrong-credential',
        remainingAttempts: failure.remainingAttempts,
        lockedForMs: failure.lockedForMs,
      };
    }
  }

  const salt = crypto.randomBytes(SALT_LEN);
  const hash = await _derive(next, salt, PBKDF2_ITER);
  try {
    setViewFallback({ salt: b64(salt), hash: b64(hash), iter: PBKDF2_ITER });
  } finally {
    hash.fill(0);
  }
  _clearFailures();
  log.info(`[view-gate] view password ${existing ? 'changed' : 'set'}`);
  return { success: true };
}

// ---------------------------------------------------------------------------
// 策略解析（规格 §2）
// ---------------------------------------------------------------------------

function osBackendFor(platform: NodeJS.Platform): OsVerifyBackend | null {
  if (_osBackendOverride !== undefined) return _osBackendOverride;
  // 只有真实存在可用后端才走 OS 门禁；darwin/linux 的 T3/T4 未实现，
  // 若在此返回一个"假可用"的 mode 就等于无门禁（规格 §2 的偏离说明）。
  if (platform === 'win32') return createWinCredUiBackend();
  return null;
}

function osModeFor(backend: OsVerifyBackend): ViewGuardStatus['mode'] {
  return backend.id === 'win-credui' ? 'os-win' : 'password';
}

export async function resolveViewGuard(): Promise<ViewGuardStatus> {
  const passwordSet = !!getViewFallback();
  const lock = isViewLocked();
  const lockedForMs = lock.locked ? lock.lockedForMs : undefined;
  const remainingAttempts = _remainingAttempts();

  if (!isInitialized()) {
    return { mode: 'none', passwordSet, reason: 'not-initialized' };
  }
  if (!isDekReady()) {
    // 门禁问的是"现在能不能解密"，不是"历史上是否加载成功"：
    // DEK 不在内存时验证通过也解不出明文——先修密钥，别让用户白输一次口令。
    return { mode: 'none', passwordSet, reason: 'key-unavailable', lockedForMs, remainingAttempts };
  }

  const tier = await getTier();
  if (tier !== 'A') {
    return { mode: 'password', passwordSet, reason: 'tier-c', lockedForMs, remainingAttempts };
  }

  const platform = _platformOverride ?? process.platform;
  const backend = osBackendFor(platform);
  if (!backend || _readState().osAuthUnavailable) {
    return {
      mode: 'password',
      passwordSet,
      reason: _readState().osAuthUnavailable ? 'os-auth-unavailable' : 'no-os-auth-backend',
      lockedForMs,
      remainingAttempts,
    };
  }
  if (!(await backend.available())) {
    return { mode: 'password', passwordSet, reason: 'no-os-auth-backend', lockedForMs, remainingAttempts };
  }
  return { mode: osModeFor(backend), passwordSet, lockedForMs, remainingAttempts };
}

/** 设置页"重新检测系统验证"：清掉降级标记，让 OS 门禁可以被重新尝试。 */
export async function resetOsAuthUnavailable(): Promise<void> {
  const state = _readState();
  if (!state.osAuthUnavailable) return;
  _writeState({ ...state, osAuthUnavailable: false });
  log.info('[view-gate] os auth re-check requested (osAuthUnavailable cleared)');
}

// ---------------------------------------------------------------------------
// 授权（每次查看都调用，规格 G12）
// ---------------------------------------------------------------------------

export async function authorizeView(secret?: string): Promise<ViewAuthResult> {
  const lock = isViewLocked();
  if (lock.locked) return { ok: false, code: 'locked', lockedForMs: lock.lockedForMs, remainingAttempts: 0 };

  const guard = await resolveViewGuard();
  if (guard.mode === 'none') return { ok: false, code: 'none', reason: guard.reason };

  if (guard.mode === 'password') {
    const record = getViewFallback();
    if (!record) return { ok: false, code: 'needs-setup' };
    if (typeof secret !== 'string' || secret.length === 0) return { ok: false, code: 'needs-input' };
    if (await _verifyPassword(secret, record)) {
      _clearFailures();
      return { ok: true, code: 'ok' };
    }
    const failure = _registerFailure();
    log.warn(`[view-gate] view password rejected (remaining=${failure.remainingAttempts})`);
    return {
      ok: false,
      code: 'wrong-credential',
      remainingAttempts: failure.remainingAttempts,
      lockedForMs: failure.lockedForMs,
    };
  }

  const backend = osBackendFor(_platformOverride ?? process.platform);
  if (!backend) return { ok: false, code: 'unavailable', reason: 'no-os-auth-backend' };

  const result = await backend.verify();
  if (result.ok) {
    _clearFailures();
    log.info(`[view-gate] os identity verified backend=${backend.id}`);
    return { ok: true, code: 'ok' };
  }

  switch (result.kind) {
    case 'cancelled':
      // 用户主动取消不是失败：不计数、不提示错误。
      return { ok: false, code: 'cancelled', reason: 'cancelled' };
    case 'bad-credential':
    case 'not-current-user': {
      const failure = _registerFailure();
      log.warn(`[view-gate] os identity rejected kind=${result.kind} remaining=${failure.remainingAttempts}`);
      return {
        ok: false,
        code: 'wrong-credential',
        reason: result.kind,
        remainingAttempts: failure.remainingAttempts,
        lockedForMs: failure.lockedForMs,
      };
    }
    case 'account-locked':
      // 继续计数无意义（系统已锁），且会掩盖真实原因。
      log.warn('[view-gate] windows account locked out; not counted');
      return { ok: false, code: 'account-locked', reason: 'account-locked' };
    case 'unusable-account':
    case 'denied': {
      const state = _readState();
      _writeState({ ...state, osAuthUnavailable: true });
      log.warn(
        `[view-gate] os auth unusable (${result.kind}`
        + `${result.reason ? ` ${result.reason}` : ''}) → degrading to view password`,
      );
      return { ok: false, code: 'degraded', reason: result.kind };
    }
    case 'unavailable':
    default:
      return { ok: false, code: 'unavailable', reason: result.reason || result.kind };
  }
}
