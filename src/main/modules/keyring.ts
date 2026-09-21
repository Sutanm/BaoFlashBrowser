import log from 'electron-log';
import { WinDpapiBackend } from './keyring-win-dpapi';

/**
 * keyring.ts — 跨平台 OS 密钥后端抽象。
 *
 * 统一接口：OS 密钥库只负责"托管一把 wrap key"（加密/解密一小段 base64
 * 秘密），不接触任何密码明文。顶层优先探测 Electron safeStorage（Electron
 * ≥15 才存在，未来升级自动命中），否则按平台选子进程后端：
 *   win32   → DPAPI（PowerShell + .NET ProtectedData）
 *   linux   → secret-tool（Task 3 接入）
 *   darwin  → security CLI（Task 4 接入，experimental）
 *
 * backend=null 不是错误：password-store 侧将其解释为"无 OS 密钥库"，
 * 自动落入档位 C′（本地弱保护）。
 */
export type KeyringBackendId =
  | 'electron-safestorage'
  | 'win-dpapi'
  | 'linux-secret-service'
  | 'darwin-keychain';

/**
 * 失败语义分类（规格 D2，2026-09-21）：
 * - transient：这一时刻拿不到（超时 / 子进程起不来 / 输出被干扰 / 本机无候选后端）。
 *   处置 = **保留密钥材料不动** + 退避重试。
 * - deterministic：后端明确说"解不开"（`decrypt-failed`）。处置 = 保留文件 + `blocked`，
 *   等用户显式决策（重试 / 重建），**绝不自动轮换**。
 *
 * 方向敏感：同一个 `ps-error` 在 wrap 方向是"密文根本没生成"（环境/策略问题，可重试），
 * 在 unwrap 方向才是"现有密文解不开"（确定性）。
 */
export type KeyringFailureKind =
  | 'backend-unavailable'
  | 'timeout'
  | 'spawn-failed'
  | 'protocol-error'
  | 'decrypt-failed';

export interface KeyringFailure {
  ok: false;
  kind: KeyringFailureKind;
  reason: string;
  detail?: string;
}

export interface KeyringStatus {
  /** null = 无任何可用 OS 后端 → 走 C′ */
  backend: KeyringBackendId | null;
  /** 给设置页/日志的诊断原因（i18n 层负责展示文案） */
  reason?: string;
}

export interface KeyringBackend {
  readonly id: KeyringBackendId;
  /** 探测①：平台前提/CLI 是否存在（便宜检查）。 */
  available(): Promise<boolean>;
  /** 探测②：往返探针（写→读→删），识别"装了但守护没跑/沙箱"等。 */
  probe(): Promise<{ ok: boolean; reason?: string }>;
  /** 加密 base64 秘密，返回 base64 blob。 */
  wrap(b64secret: string): Promise<{ ok: true; blob: string } | KeyringFailure>;
  /** 解密 base64 blob，返回 base64 秘密。 */
  unwrap(blob: string): Promise<{ ok: true; secret: string } | KeyringFailure>;
  /** 撤销（可选）：DPAPI 无撤销语义，实现为空操作。 */
  remove?(blob: string): Promise<{ ok: boolean; reason?: string }>;
}

/** 仅供单元测试注入当前后端（配合 clearKeyringCache 复位）。 */
export function _setActiveBackendForTest(backend: KeyringBackend | null): void {
  _activeBackend = backend;
  _cachedStatus = backend ? { backend: backend.id } : { backend: null, reason: 'test-none' };
  _cachedAt = Date.now();
  _probed = true;
}

/** Electron ≥15 的最小 safeStorage 形态（11 上不存在，动态探测）。 */
interface MinimalSafeStorage {
  isEncryptionAvailable?(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

function getElectronModule(): { safeStorage?: MinimalSafeStorage } | string | null {
  try {
    // 动态 require：纯 Node（vitest）下 require('electron') 返回路径字符串，
    // typeof 判断即可安全跳过，模块顶层不会因此崩溃。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('electron') as { safeStorage?: MinimalSafeStorage } | string;
  } catch {
    return null;
  }
}

function createElectronSafeStorageBackend(): KeyringBackend | null {
  const electron = getElectronModule();
  if (typeof electron !== 'object' || !electron) return null;
  const ss = electron.safeStorage;
  if (!ss || typeof ss.encryptString !== 'function' || typeof ss.decryptString !== 'function') return null;
  return {
    id: 'electron-safestorage',
    async available() {
      if (typeof ss.isEncryptionAvailable === 'function') {
        try {
          return ss.isEncryptionAvailable();
        } catch {
          return false;
        }
      }
      return true;
    },
    async probe() {
      try {
        const back = ss.decryptString(ss.encryptString('keyring-probe'));
        return { ok: back === 'keyring-probe' };
      } catch {
        return { ok: false, reason: 'probe-failed' };
      }
    },
    async wrap(b64secret) {
      try {
        const enc = ss.encryptString(b64secret);
        return { ok: true, blob: enc.toString('base64') };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        log.warn('[keyring] electron-safestorage wrap failed:', detail);
        // wrap 方向失败 = 密文未生成（环境/策略问题），可重试，不是密文损坏。
        return { ok: false, kind: 'backend-unavailable', reason: 'wrap-failed', detail };
      }
    },
    async unwrap(blob) {
      try {
        const secret = ss.decryptString(Buffer.from(blob, 'base64'));
        return { ok: true, secret };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        log.warn('[keyring] electron-safestorage unwrap failed:', detail);
        // unwrap 方向失败 = 后端明确拒绝该密文 → 确定性失败（调用方保留文件、等用户决策）。
        // Carry the underlying message: the caller logs only `reason`, and the
        // bare 'unwrap-failed' code made a real occurrence impossible to diagnose
        // (the detail vanished from every log that recorded the rotation).
        return { ok: false, kind: 'decrypt-failed', reason: 'unwrap-failed', detail };
      }
    },
  };
}

function createPlatformBackend(platform: NodeJS.Platform): KeyringBackend | null {
  switch (platform) {
    case 'win32':
      return new WinDpapiBackend();
    case 'linux':
      // Task 3：linux-secret-service（secret-tool）接入处。
      return null;
    case 'darwin':
      // Task 4：darwin-keychain（security CLI，experimental）接入处。
      return null;
    default:
      return null;
  }
}

let _activeBackend: KeyringBackend | null = null;
let _cachedStatus: KeyringStatus | null = null;
let _cachedAt = 0;
/** 缓存结论是否来自真实往返探针（读路径的"提示性"解析不算）。 */
let _probed = false;

/**
 * 探测失败的缓存时长（规格 D5）。成功结论进程级有效；失败只保留很短一段时间，
 * 否则一次瞬时超时会污染整个会话（2026-09-20 事故的放大器之一）。
 */
function failureTtlMs(): number {
  const raw = Number(process.env.BFB_KEYRING_FAILURE_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 15_000;
}

/** 仅供单元测试注入候选后端（不改动真实平台链，配合 clearKeyringCache 复位）。 */
let _candidateOverride: KeyringBackend[] | null = null;

export function _setCandidateBackendsForTest(list: KeyringBackend[] | null): void {
  _candidateOverride = list;
}

/** 平台候选构造（safeStorage 优先 → 平台后端），供探测与亲和试解共用。 */
async function buildCandidates(platform: NodeJS.Platform): Promise<KeyringBackend[]> {
  if (_candidateOverride) return _candidateOverride;
  const out: KeyringBackend[] = [];
  const ss = createElectronSafeStorageBackend();
  if (ss) out.push(ss);
  const plat = createPlatformBackend(platform);
  if (plat) out.push(plat);
  return out;
}

/** 探测失败后可重试。 */
export function clearKeyringCache(): void {
  _activeBackend = null;
  _cachedStatus = null;
  _cachedAt = 0;
  _probed = false;
}

/** 使缓存失效（重试路径调用）：下一次探测会真正重跑，而不是复用失败结论。 */
export function invalidateKeyring(): void {
  clearKeyringCache();
}

/** 依次探测候选后端（safeStorage 优先 → 平台后端），命中即缓存。 */
export async function detectKeyring(): Promise<KeyringStatus> {
  if (_cachedStatus && _probed) {
    const isFailure = !_cachedStatus.backend;
    // 成功结论进程级有效；失败结论只保留很短时间（规格 D5，避免一次超时污染整个会话）。
    if (!isFailure || Date.now() - _cachedAt < failureTtlMs()) return _cachedStatus;
  }
  const result = await resolveBackend(process.platform);
  _activeBackend = result.backend;
  _cachedStatus = result.status;
  _cachedAt = Date.now();
  _probed = true;
  if (!result.status.backend) {
    log.info(`[keyring] no OS backend available (reason=${result.status.reason ?? 'unknown'})`);
  } else {
    log.info(`[keyring] backend active: ${result.status.backend}`);
  }
  return result.status;
}

/**
 * 不做往返探针的后端解析（读路径专用，规格 D5）。
 *
 * 读路径手上就有一段真实密文，unwrap 本身就是最强的探针；再跑一轮 protect→unprotect
 * 既慢又会在机器繁忙时误判（事故当天正是如此）。此处只做廉价的 available 检查，
 * 且**不缓存失败结论**——下一次调用自然重试。
 */
async function resolveWithoutProbe(platform: NodeJS.Platform): Promise<void> {
  if (_probed && _cachedStatus?.backend) return;
  const available = await buildAvailableCandidates(platform);
  _activeBackend = available[0] ?? null;
  _cachedStatus = _activeBackend ? { backend: _activeBackend.id } : { backend: null, reason: 'no-tool' };
  _cachedAt = Date.now();
  // 不是探针结论：enroll（写）路径必须重新探测，绝不凭此写入。
  _probed = false;
}

/** 供单元测试直接探测给定候选（绕过平台与缓存）。 */
export async function resolveBackend(
  platform: NodeJS.Platform,
  candidates?: KeyringBackend[],
): Promise<{ backend: KeyringBackend | null; status: KeyringStatus }> {
  const list = candidates ?? await buildCandidates(platform);

  for (const backend of list) {
    try {
      if (!(await backend.available())) continue;
    } catch {
      continue;
    }
    let probeResult: { ok: boolean; reason?: string };
    try {
      probeResult = await backend.probe();
    } catch {
      probeResult = { ok: false, reason: 'probe-threw' };
    }
    if (probeResult.ok) return { backend, status: { backend: backend.id } };
    return { backend: null, status: { backend: null, reason: probeResult.reason ?? 'probe-failed' } };
  }

  if (platform === 'win32' || platform === 'linux' || platform === 'darwin') {
    return { backend: null, status: { backend: null, reason: 'no-tool' } };
  }
  return { backend: null, status: { backend: null, reason: 'unsupported-platform' } };
}

/** 当前活跃后端 id（诊断/状态展示用；探测未跑时可能为 null）。 */
export function getActiveBackendId(): KeyringBackendId | null {
  return _activeBackend?.id ?? null;
}

/** 本机候选后端（不做往返探针，只做廉价的 available 检查）。 */
async function buildAvailableCandidates(platform: NodeJS.Platform): Promise<KeyringBackend[]> {
  const out: KeyringBackend[] = [];
  for (const backend of await buildCandidates(platform)) {
    try {
      if (await backend.available()) out.push(backend);
    } catch { /* 候选不可用即跳过 */ }
  }
  return out;
}

/**
 * 按亲和标签解封（规格 D4）。
 *
 * 顺序：标签后端 → 当前活跃后端 → 其余可用候选，**最多试 2 个**。
 * 试解全程只读：失败绝不写盘，成功才由调用方回写正确标签。
 *
 * 失败归并：任何一个候选报 `decrypt-failed`（后端明确拒绝该密文）即视为确定性失败；
 * 否则按首个失败（超时/起不来/协议异常）视为瞬时失败，可重试。
 */
export async function keyringUnwrapAffine(
  blob: string,
  preferred: KeyringBackendId | null,
): Promise<{ ok: true; secret: string; backend: KeyringBackendId } | KeyringFailure> {
  // 读路径不跑往返探针（规格 D5）：unwrap 自身即探针，且失败不缓存、下次自然重试。
  await resolveWithoutProbe(process.platform);
  const activeId = getActiveBackendId();
  const available = await buildAvailableCandidates(process.platform);
  const byId = new Map(available.map((backend) => [backend.id, backend]));

  const order: KeyringBackendId[] = [];
  if (preferred && byId.has(preferred)) order.push(preferred);
  if (activeId && byId.has(activeId) && !order.includes(activeId)) order.push(activeId);
  for (const backend of available) {
    if (order.length >= 2) break;
    if (!order.includes(backend.id)) order.push(backend.id);
  }

  if (order.length === 0) {
    return { ok: false, kind: 'backend-unavailable', reason: _cachedStatus?.reason ?? 'no-candidate' };
  }

  let firstFailure: KeyringFailure | null = null;
  let sawDecryptFailure = false;
  for (const id of order.slice(0, 2)) {
    const backend = byId.get(id);
    if (!backend) continue;
    const result = await backend.unwrap(blob);
    if (result.ok) return { ok: true, secret: result.secret, backend: id };
    if (result.kind === 'decrypt-failed') sawDecryptFailure = true;
    if (!firstFailure) firstFailure = result;
  }
  if (sawDecryptFailure) {
    return { ok: false, kind: 'decrypt-failed', reason: firstFailure?.reason ?? 'unwrap-failed', detail: firstFailure?.detail };
  }
  return firstFailure ?? { ok: false, kind: 'backend-unavailable', reason: 'no-candidate' };
}

/** 用当前可用后端加密 base64 秘密；无后端时失败（调用方转 C′）。 */
export async function keyringWrap(b64secret: string): Promise<{ ok: true; blob: string } | KeyringFailure> {
  await detectKeyring();
  if (!_activeBackend) {
    return { ok: false, kind: 'backend-unavailable', reason: _cachedStatus?.reason ?? 'keyring-unavailable' };
  }
  return _activeBackend.wrap(b64secret);
}

/** 用当前可用后端解密 blob；失败时调用方按 kind 分类处置（**保留文件**，不轮换）。 */
export async function keyringUnwrap(blob: string): Promise<{ ok: true; secret: string } | KeyringFailure> {
  await detectKeyring();
  if (!_activeBackend) {
    return { ok: false, kind: 'backend-unavailable', reason: _cachedStatus?.reason ?? 'keyring-unavailable' };
  }
  return _activeBackend.unwrap(blob);
}
