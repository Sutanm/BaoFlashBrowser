import log from 'electron-log';
import { z } from 'zod';
import { createHandler, createValidatedHandler } from '../utils/ipc-wrapper';
import {
  init, isInitialized, initVault, getTier, isEnabled, toggleEnabled,
  addEntry, listEntries, deleteEntry,
  setDefault, isAutoCaptureEnabled, setAutoCapture,
  getExcludedSites, setExcludedSites, isAutoFillEnabled, isAutoFillReady, setAutoFill,
  isDekReady, resetAll, ensureKeyLoaded, getKeyStatus,
  hasEntry, getDecryptedPassword,
} from '../modules/password-store';
import { invalidateKeyring } from '../modules/keyring';
import {
  authorizeView, resolveViewGuard, resetOsAuthUnavailable, setViewPassword,
} from '../modules/view-gate';
import type {
  PasswordTier, RevealPasswordResult, SetViewPasswordResult, ViewGuardStatus,
} from '../../shared/types/passwords';
import { getPendingCredential, removePendingCredential, notifyPasswordChanged } from '../modules/password-capture';
import { tabManager } from '../modules/tabs';

export function registerPasswordIPC(): void {
  createHandler('password:status', async () => {
    const tier: PasswordTier = isInitialized() ? (await getTier()) ?? 'none' : 'none';
    const key = getKeyStatus();
    return {
      enabled: isEnabled(),
      initialized: isInitialized(),
      tier,
      autoCapture: isAutoCaptureEnabled(),
      autoFill: isAutoFillEnabled(),
      autoFillReady: isAutoFillReady(),
      keyStatus: key.status,
      keyIssue: key.issue,
      viewGuard: await resolveViewGuard(),
      excludedSites: getExcludedSites(),
    };
  });

  // 手动重试：使探测缓存失效（瞬时失败不再污染会话）后重试一次。
  createHandler('password:retry-key', async () => {
    invalidateKeyring();
    await ensureKeyLoaded();
    const key = getKeyStatus();
    return { keyStatus: key.status, keyIssue: key.issue, ready: isAutoFillReady() };
  });

  const idArg = z.object({ id: z.string().min(1).max(128) }).strict();
  // secret 仅在"查看密码"模式下由渲染层提供（A 档走系统对话框，不带口令）。
  const revealArg = z.object({
    id: z.string().min(1).max(128),
    secret: z.string().max(128).optional(),
  }).strict();
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

  createValidatedHandler('password:save-confirm', captureArg, async ({ captureId }) => {
    if (!isEnabled()) return { success: false, error: 'Password store is disabled' };
    // 按需自愈（规格 D6）：此前若因瞬时故障未取到密钥，这里再试一次再决定成败。
    if (!isDekReady()) await ensureKeyLoaded();
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

  // 查看明文：门禁授权制（规格 G1/G2/G12）——先授权，再解密；明文只在此处出一次。
  createValidatedHandler('password:reveal', revealArg, async ({ id, secret }): Promise<RevealPasswordResult> => {
    if (!isEnabled()) return { error: 'not-authorized' };
    // 判定顺序：先"有没有可解密的库"→ 再"条目在不在"→ 最后才验证。
    // 反过来做会误导（未建库却报 missing）或白弹一次验证框（为不存在的条目输口令）。
    if (!isInitialized() || !isDekReady()) return { error: 'not-authorized' };
    if (!hasEntry(id)) return { error: 'missing' };

    const auth = await authorizeView(secret);
    const guard = await resolveViewGuard();
    if (!auth.ok) {
      log.info(`[Password] reveal denied code=${auth.code}${auth.reason ? ` reason=${auth.reason}` : ''} mode=${guard.mode}`);
      return {
        error: auth.code === 'none' ? 'not-authorized' : auth.code,
        reason: auth.reason,
        remainingAttempts: auth.remainingAttempts,
        lockedForMs: auth.lockedForMs,
        mode: guard.mode,
      };
    }

    const password = getDecryptedPassword(id);
    if (password == null) {
      // 授权通过却拿不到明文：只能是条目/密钥在两次调用之间消失（如并发重建）。
      log.warn('[Password] reveal authorized but plaintext unavailable');
      return { error: 'missing', mode: guard.mode };
    }
    log.info('[Password] reveal authorized (plaintext not logged)');
    return { password, mode: guard.mode };
  });

  // 设置 / 修改查看密码（C 档强制；改密需 current 且计入失败计数，规格 G3/G6）。
  createValidatedHandler('password:set-view-password', z.object({
    password: z.string().min(1).max(128),
    current: z.string().max(128).optional(),
  }).strict(), async ({ password, current }): Promise<SetViewPasswordResult> => {
    const guard = await resolveViewGuard();
    if (guard.mode !== 'password') {
      // 当前档位不用查看密码（A 档走 OS 验证）——拒绝写入，避免留下永不生效的材料。
      return { success: false, error: 'not-available' };
    }
    const result = await setViewPassword(password, current);
    if (result.success) notifyPasswordChanged();
    return result;
  });

  // 设置页"重新检测系统验证"：清掉降级标记后返回最新状态（规格 §8）。
  createHandler('password:reset-os-auth', async (): Promise<{ viewGuard: ViewGuardStatus }> => {
    await resetOsAuthUnavailable();
    return { viewGuard: await resolveViewGuard() };
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

  // 用户显式重建（唯一允许销毁密钥材料的产品路径之一，需确认词防误触）。
  createValidatedHandler('password:rebuild-vault', z.object({ confirm: z.literal('REBUILD') }).strict(), async () => {
    resetAll();
    const result = await initVault();
    notifyPasswordChanged();
    if (result.success) tabManager.refreshPasswordFill();
    return { success: result.success, tier: result.tier ?? 'none' };
  });

  createHandler('password:reset', () => {
    resetAll();
    notifyPasswordChanged();
    return { success: true };
  });

  log.info('[Password] IPC registered (v2)');
}
