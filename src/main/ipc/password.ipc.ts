import log from 'electron-log';
import { z } from 'zod';
import { createHandler, createValidatedHandler } from '../utils/ipc-wrapper';
import {
  init, isInitialized, initVault, getTier, isEnabled, toggleEnabled,
  addEntry, listEntries, deleteEntry,
  setDefault, isAutoCaptureEnabled, setAutoCapture,
  getExcludedSites, setExcludedSites, isAutoFillEnabled, isAutoFillReady, setAutoFill,
  isDekReady, resetAll,
} from '../modules/password-store';
import type { PasswordTier, RevealPasswordResult, ViewGuardMode } from '../../shared/types/passwords';
import { getPendingCredential, removePendingCredential, notifyPasswordChanged } from '../modules/password-capture';
import { tabManager } from '../modules/tabs';

/**
 * 临时档位/门禁判定（Task 5 view-gate.ts 就绪后替换为真实模块）。
 * 仅服务状态展示，不承载任何安全决策：reveal 在 Task 5 前恒 not-authorized。
 */
function resolveTierView(tier: PasswordTier): { mode: ViewGuardMode; fallbackEnabled: boolean; reason?: string } {
  if (tier === 'none') return { mode: 'none', fallbackEnabled: false };
  if (tier === 'C') return { mode: 'none', fallbackEnabled: false, reason: 'no-os-keyring' };
  if (process.platform === 'win32') return { mode: 'os-win', fallbackEnabled: false };
  if (process.platform === 'darwin') return { mode: 'os-mac', fallbackEnabled: false };
  return { mode: 'keyring', fallbackEnabled: false };
}

export function registerPasswordIPC(): void {
  createHandler('password:status', async () => {
    const tier: PasswordTier = isInitialized() ? (await getTier()) ?? 'none' : 'none';
    return {
      enabled: isEnabled(),
      initialized: isInitialized(),
      tier,
      autoCapture: isAutoCaptureEnabled(),
      autoFill: isAutoFillEnabled(),
      autoFillReady: isAutoFillReady(),
      viewGuard: resolveTierView(tier),
      excludedSites: getExcludedSites(),
    };
  });

  const idArg = z.object({ id: z.string().min(1).max(128) }).strict();
  const captureArg = z.object({ captureId: z.string().min(1).max(128) }).strict();

  // v2：无主密码。无参通道按仓库惯例使用 createHandler（args=undefined 不校验）。
  createHandler('password:init', async () => {
    const result = await initVault();
    if (result.success) tabManager.refreshPasswordFill();
    return { success: result.success, tier: result.tier ?? 'none' };
  });

  // v2：列表常显（无解锁态）。
  createHandler('password:list', () => {
    if (!isEnabled()) return [];
    return listEntries();
  });

  createHandler('password:toggle-enabled', async () => {
    const wasEnabled = isEnabled();
    const newState = toggleEnabled();
    if (!wasEnabled && newState) {
      try { await init(); } catch (error: any) { log.warn('[Password] re-init failed:', error?.message); }
    }
    return { enabled: newState };
  });

  createValidatedHandler('password:set-auto-capture', z.object({ enabled: z.boolean() }).strict(), ({ enabled }) => {
    const next = setAutoCapture(enabled);
    tabManager.refreshPasswordCapture(next);
    return { enabled: next };
  });

  createValidatedHandler('password:set-auto-fill', z.object({ enabled: z.boolean() }).strict(), ({ enabled }) => {
    const next = setAutoFill(enabled);
    if (next) tabManager.refreshPasswordFill();
    return { enabled: next, ready: isAutoFillReady() };
  });

  createValidatedHandler('password:set-excluded-sites', z.object({
    sites: z.array(z.string().min(1).max(2048)).max(200),
  }).strict(), ({ sites }) => {
    const excludedSites = setExcludedSites(sites);
    tabManager.refreshPasswordCapture(isAutoCaptureEnabled());
    return { excludedSites };
  });

  createValidatedHandler('password:save-confirm', captureArg, ({ captureId }) => {
    if (!isEnabled()) return { success: false, error: 'Password store is disabled' };
    if (!isInitialized() || !isDekReady()) return { success: false, error: 'Password store not ready' };
    const cred = getPendingCredential(captureId);
    if (!cred) return { success: false, error: 'Credentials expired' };
    try {
      addEntry({ host: cred.host, username: cred.username, password: cred.password, origin: cred.origin || undefined, title: cred.title || undefined });
      removePendingCredential(captureId);
      notifyPasswordChanged();
      return { success: true };
    } catch (error: any) {
      log.error('[Password] save failed:', error.message);
      return { success: false, error: error.message };
    }
  });

  createValidatedHandler('password:ignore', captureArg, ({ captureId }) => {
    removePendingCredential(captureId);
    return { success: true };
  });

  createValidatedHandler('password:delete', idArg, ({ id }) => {
    const ok = deleteEntry(id);
    if (ok) notifyPasswordChanged();
    return { success: ok };
  });

  // v2 查看门禁：Task 5 view-gate 接线前恒 not-authorized，绝不直接暴露明文。
  createValidatedHandler('password:reveal', idArg, (): RevealPasswordResult => {
    return { error: 'not-authorized' };
  });

  createValidatedHandler('password:set-default', idArg, ({ id }) => {
    setDefault(id);
    notifyPasswordChanged();
    return { success: true };
  });

  createValidatedHandler('password:fill', z.object({
    tabId: z.string().min(1).max(128),
    id: z.string().min(1).max(128),
  }).strict(), async ({ tabId, id }) => {
    const result = await tabManager.fillPassword(tabId, id);
    return {
      success: result.success,
      filledFields: result.filledFields,
      filledCredentials: result.filledCredentials,
      reason: result.reason,
    };
  });

  createHandler('password:reset', () => {
    resetAll();
    notifyPasswordChanged();
    return { success: true };
  });

  log.info('[Password] IPC registered (v2)');
}
