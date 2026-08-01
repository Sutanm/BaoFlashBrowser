import log from 'electron-log';
import { createHandler } from '../utils/ipc-wrapper';
import {
  init, isInitialized, unlockWithMaster, lock, isUnlocked, setupMaster,
  addEntry, listEntries, deleteEntry,
  getDecryptedPassword,
  setDefault, toggleEnabled, isEnabled, resetAll,
} from '../modules/password-store';
import { getPendingCredential, removePendingCredential, notifyPasswordChanged } from '../modules/password-capture';

export function registerPasswordIPC(): void {
  createHandler('password:status', () => ({
    initialized: isInitialized(),
    unlocked: isUnlocked(),
    enabled: isEnabled(),
  }));

  createHandler('password:setup', async ({ password }: { password: string }) => {
    const ok = await setupMaster(password);
    return { success: ok };
  });

  createHandler('password:unlock', ({ password }: { password: string }) => {
    const ok = unlockWithMaster(password);
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

  createHandler('password:list', () => {
    if (!isUnlocked()) return [];
    return listEntries();
  });

  createHandler('password:save-confirm', ({ captureId }: { captureId: string }) => {
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

  createHandler('password:ignore', ({ captureId }: { captureId: string }) => {
    removePendingCredential(captureId);
    return { success: true };
  });

  createHandler('password:delete', ({ id }: { id: string }) => {
    const ok = deleteEntry(id);
    if (ok) notifyPasswordChanged();
    return { success: ok };
  });

  createHandler('password:get-password', ({ id }: { id: string }) => {
    if (!isUnlocked()) return null;
    return getDecryptedPassword(id);
  });

  createHandler('password:set-default', ({ id }: { id: string }) => {
    setDefault(id);
    notifyPasswordChanged();
    return { success: true };
  });

  createHandler('password:reset', async () => {
    resetAll();
    notifyPasswordChanged();
    return { success: true };
  });

  log.info('[Password] IPC registered');
}
