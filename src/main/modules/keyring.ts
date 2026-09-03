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
  wrap(b64secret: string): Promise<{ ok: true; blob: string } | { ok: false; reason: string }>;
  /** 解密 base64 blob，返回 base64 秘密。 */
  unwrap(blob: string): Promise<{ ok: true; secret: string } | { ok: false; reason: string }>;
  /** 撤销（可选）：DPAPI 无撤销语义，实现为空操作。 */
  remove?(blob: string): Promise<{ ok: boolean; reason?: string }>;
}

/** 仅供单元测试注入当前后端（配合 clearKeyringCache 复位）。 */
export function _setActiveBackendForTest(backend: KeyringBackend | null): void {
  _activeBackend = backend;
  _cachedStatus = backend ? { backend: backend.id } : { backend: null, reason: 'test-none' };
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
        const reason = error instanceof Error ? error.message : String(error);
        log.warn('[keyring] electron-safestorage wrap failed:', reason);
        return { ok: false, reason: 'wrap-failed' };
      }
    },
    async unwrap(blob) {
      try {
        const secret = ss.decryptString(Buffer.from(blob, 'base64'));
        return { ok: true, secret };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log.warn('[keyring] electron-safestorage unwrap failed:', reason);
        return { ok: false, reason: 'unwrap-failed' };
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

/** 探测失败后可重试。 */
export function clearKeyringCache(): void {
  _activeBackend = null;
  _cachedStatus = null;
}

/** 依次探测候选后端（safeStorage 优先 → 平台后端），命中即缓存。 */
export async function detectKeyring(): Promise<KeyringStatus> {
  if (_cachedStatus) return _cachedStatus;
  const result = await resolveBackend(process.platform);
  _activeBackend = result.backend;
  _cachedStatus = result.status;
  if (!result.status.backend) {
    log.info(`[keyring] no OS backend available (reason=${result.status.reason ?? 'unknown'})`);
  } else {
    log.info(`[keyring] backend active: ${result.status.backend}`);
  }
  return result.status;
}

/** 供单元测试直接探测给定候选（绕过平台与缓存）。 */
export async function resolveBackend(
  platform: NodeJS.Platform,
  candidates?: KeyringBackend[],
): Promise<{ backend: KeyringBackend | null; status: KeyringStatus }> {
  const list = candidates ?? (() => {
    const out: KeyringBackend[] = [];
    const ss = createElectronSafeStorageBackend();
    if (ss) out.push(ss);
    const plat = createPlatformBackend(platform);
    if (plat) out.push(plat);
    return out;
  })();

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

/** 用当前可用后端加密 base64 秘密；无后端时失败（调用方转 C′）。 */
export async function keyringWrap(b64secret: string): Promise<{ ok: true; blob: string } | { ok: false; reason: string }> {
  await detectKeyring();
  if (!_activeBackend) return { ok: false, reason: _cachedStatus?.reason ?? 'keyring-unavailable' };
  return _activeBackend.wrap(b64secret);
}

/** 用当前可用后端解密 blob；失败时调用方视为"后端失配"，转 C′ 或重 enroll。 */
export async function keyringUnwrap(blob: string): Promise<{ ok: true; secret: string } | { ok: false; reason: string }> {
  await detectKeyring();
  if (!_activeBackend) return { ok: false, reason: _cachedStatus?.reason ?? 'keyring-unavailable' };
  return _activeBackend.unwrap(blob);
}
