import log from 'electron-log';
import { z } from 'zod';
import { createHandler, createValidatedHandler } from '../utils/ipc-wrapper';
import {
  init, isInitialized, unlockWithMaster, lock, isUnlocked, setupMaster,
  addEntry, listEntries, deleteEntry,
  getDecryptedPassword,
  setDefault, toggleEnabled, isEnabled, resetAll, isAutoCaptureEnabled, setAutoCapture,
  getExcludedSites, setExcludedSites, isAutoFillEnabled, isAutoFillReady, setAutoFill,
} from '../modules/password-store';
import { getPendingCredential, removePendingCredential, notifyPasswordChanged } from '../modules/password-capture';
import { tabManager } from '../modules/tabs';

export function registerPasswordIPC(): void {
  createHandler('password:status', () => ({
    initialized: isInitialized(),
    unlocked: isUnlocked(),
    enabled: isEnabled(),
    autoCapture: isAutoCaptureEnabled(),
    autoFill: isAutoFillEnabled(),
    autoFillReady: isAutoFillReady(),
    excludedSites: getExcludedSites(),
  }));

  const passwordArg = z.object({ password: z.string().min(1).max(1024) }).strict();
  const idArg = z.object({ id: z.string().min(1).max(128) }).strict();
  const captureArg = z.object({ captureId: z.string().min(1).max(128) }).strict();

  createValidatedHandler('password:setup', passwordArg, async ({ password }) => {
    const ok = await setupMaster(password);
    if (ok) tabManager.refreshPasswordFill();
    return { success: ok };
  });

  createValidatedHandler('password:unlock', passwordArg, async ({ password }) => {
    const ok = await unlockWithMaster(password);
    if (ok) tabManager.refreshPasswordFill();
    return { success: ok };
  });

  createHandler('password:lock', () => { lock(); return { success: true }; });

  createHandler('password:toggle-enabled', async () => {
    const wasEnabled = isEnabled();
    const newState = toggleEnabled();
    if (!wasEnabled && newState) {
      try { await init(); } catch (e: any) { log.warn('[Password] re-init failed:', e.message); }
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

  createHandler('password:list', () => {
    if (!isUnlocked()) return [];
    return listEntries();
  });

  createValidatedHandler('password:save-confirm', captureArg, ({ captureId }) => {
    if (!isEnabled()) return { success: false, error: 'Password store is disabled' };
    if (!isUnlocked()) return { success: false, error: 'Password store is locked' };
    const cred = getPendingCredential(captureId);
    if (!cred) return { success: false, error: 'Credentials expired' };
    try {
      addEntry({ host: cred.host, username: cred.username, password: cred.password, origin: cred.origin || undefined, title: cred.title || undefined });
      removePendingCredential(captureId);
      notifyPasswordChanged();
      return { success: true };
    } catch (e: any) {
      log.error('[Password] save failed:', e.message);
      return { success: false, error: e.message };
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

  createValidatedHandler('password:get-password', idArg, ({ id }) => {
    if (!isUnlocked()) return null;
    return getDecryptedPassword(id);
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

  createHandler('password:reset', async () => {
    resetAll();
    notifyPasswordChanged();
    return { success: true };
  });

  log.info('[Password] IPC registered');
}
