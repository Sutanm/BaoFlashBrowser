/**
 * safeStorage 适配层 — 用操作系统级凭据保护 auto-fill 密钥。
 *
 * 背景：password-store 的自动填充免解锁依赖一个独立 key 加密 DEK
 * （dekAutoFillEnc）。旧实现把这个 key 明文存进 electron-store
 * （password-autofill-key.json），任何能读取 userData 目录的进程都能
 * 解开 DEK 从而解密全部密码条目——主密码形同虚设。
 *
 * 本模块用 Electron safeStorage（Windows DPAPI / macOS Keychain）加密该
 * key。Electron 11.5.0 的官方类型定义未包含 safeStorage（运行时 API
 * 存在），因此这里声明最小本地接口并做防御性能力探测。
 *
 * 纯 Node 测试环境下 require('electron') 返回可执行文件路径字符串，
 * safeStorage 为 undefined，isAvailable() 返回 false——测试与 Linux
 * 无 keyring 的环境自然走"不可用"分支，不会崩溃。
 */
import log from 'electron-log';

/** Electron 11 类型定义缺失的最小 safeStorage 接口（运行时存在）。 */
interface MinimalSafeStorage {
  isEncryptionAvailable?(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
function getSafeStorage(): MinimalSafeStorage | null {
  try {
    // 动态 require：模块顶层在纯 Node（vitest）下也能被 import。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { safeStorage?: MinimalSafeStorage } | string;
    if (typeof electron === 'object' && electron.safeStorage) return electron.safeStorage;
    return null;
  } catch {
    return null;
  }
}

/** OS 级凭据保护是否可用（Windows DPAPI / macOS Keychain 通常 true）。 */
export function isSafeStorageAvailable(): boolean {
  const ss = getSafeStorage();
  if (!ss) return false;
  try {
    if (typeof ss.isEncryptionAvailable === 'function') return ss.isEncryptionAvailable();
    // Electron 11 可能缺 isEncryptionAvailable：尝试一次真实加解密探测。
    const probe = ss.encryptString('probe');
    const back = ss.decryptString(probe);
    return back === 'probe';
  } catch {
    return false;
  }
}

/** 用 OS 级凭据加密字符串，返回 base64；不可用时返回 null。 */
export function encryptWithSafeStorage(plain: string): string | null {
  const ss = getSafeStorage();
  if (!ss) return null;
  try {
    if (typeof ss.isEncryptionAvailable === 'function' && !ss.isEncryptionAvailable()) return null;
    return ss.encryptString(plain).toString('base64');
  } catch (err) {
    log.warn('[safe-storage] encrypt failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** 解密 base64 密文；不可用或失败时返回 null。 */
export function decryptWithSafeStorage(encoded: string): string | null {
  const ss = getSafeStorage();
  if (!ss) return null;
  try {
    if (typeof ss.isEncryptionAvailable === 'function' && !ss.isEncryptionAvailable()) return null;
    return ss.decryptString(Buffer.from(encoded, 'base64'));
  } catch (err) {
    log.warn('[safe-storage] decrypt failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}
