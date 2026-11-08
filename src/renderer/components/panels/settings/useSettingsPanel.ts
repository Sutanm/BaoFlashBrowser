import { useState, useCallback, useEffect, useRef } from 'react';
import { useDataStore, defaultSettings } from '@renderer/store/useDataStore';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import type { AppUpdateResult } from '@shared/types/app-update';
import type { Settings } from '@shared/types/settings';
import type { PasswordKeyStatus, ViewGuardStatus } from '@shared/types/passwords';
import { requiresMainConfigRestart } from '@renderer/services/settings-restart';
import { DEFAULT_PROXY, proxySettingsSchema } from '@shared/types/proxy';
import {
  DEFAULT_MAIN_CONFIG,
  type MainConfigForm,
  type SettingsPanelProps,
  type SettingsSection,
} from './settings-panel-types';

export function useSettingsPanel({ onOpenUrl }: SettingsPanelProps) {
  const settings = useDataStore((s) => s.settings);
  const setSettings = useDataStore((s) => s.setSettings);
  const setStoreStatus = useDataStore((s) => s.setPasswordStoreStatus);
  const pushToast = useDataStore((s) => s.pushToast);
  const { LL, setLocale } = useI18nContext();

  const [form, setForm] = useState<Settings>({ ...defaultSettings, ...settings });
  const [mainForm, setMainForm] = useState<MainConfigForm>({ ...DEFAULT_MAIN_CONFIG });
  const [appVersion, setAppVersion] = useState('');
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateResult, setUpdateResult] = useState<AppUpdateResult | null>(null);
  useEffect(() => {
    void window.electronAPI.invoke('app:version').then(setAppVersion).catch(() => {});
  }, []);
  const handleCheckUpdate = async () => {
    setCheckingUpdate(true);
    setUpdateResult(null);
    try {
      setUpdateResult(await window.electronAPI.invoke('app:check-update'));
    } catch {
      setUpdateResult({ status: 'error', currentVersion: appVersion });
    } finally { setCheckingUpdate(false); }
  };
  const [downloadDir, setDownloadDir] = useState('');
  const [screenshotDir, setScreenshotDir] = useState('');
  const [saved, setSaved] = useState<boolean | 'restart'>(false);
  const [resetConfirming, setResetConfirming] = useState(false);
  const [autoCapture, setAutoCapture] = useState(true);
  const [autoFill, setAutoFill] = useState(true);
  const [autoFillReady, setAutoFillReady] = useState(false);
  const [passwordTier, setPasswordTier] = useState<'A' | 'C' | 'none'>('none');
  const [passwordStoreInitialized, setPasswordStoreInitialized] = useState(false);
  const [passwordKeyStatus, setPasswordKeyStatus] = useState<PasswordKeyStatus>('ok');
  const [passwordKeyReason, setPasswordKeyReason] = useState<string | null>(null);
  const [excludedSitesText, setExcludedSitesText] = useState('');
  // --- 查看保护（规格 2026-09-22 §8）：门禁形态 + 查看密码设置/修改 ---
  const [viewGuard, setViewGuard] = useState<ViewGuardStatus | null>(null);
  const [viewPwdOpen, setViewPwdOpen] = useState(false);
  const [viewPwdCurrent, setViewPwdCurrent] = useState('');
  const [viewPwdNext, setViewPwdNext] = useState('');
  const [viewPwdConfirm, setViewPwdConfirm] = useState('');
  const [viewPwdBusy, setViewPwdBusy] = useState(false);
  const [viewPwdError, setViewPwdError] = useState<string | null>(null);
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false);
  const [cacheConfirming, setCacheConfirming] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const [activeSection, setActiveSection] = useState<SettingsSection | null>(null);
  const loadedMainFormRef = useRef<MainConfigForm>({ ...DEFAULT_MAIN_CONFIG });

  useEffect(() => {
    window.electronAPI?.config?.get().then((cfg) => {
      if (cfg) {
        const loaded = {
          proxy: cfg.proxy ?? { ...DEFAULT_PROXY },
          flashVersion: cfg.flashVersion,
          flashPluginChannel: cfg.flashPluginChannel,
          lowEndMode: cfg.lowEndMode,
          screenshotDir: cfg.screenshotDir ?? '',
          updateCheckMode: cfg.updateCheckMode ?? DEFAULT_MAIN_CONFIG.updateCheckMode,
          ...(MODULE_DOWNLOAD ? {
            downloadEngine: cfg.downloadEngine ?? DEFAULT_MAIN_CONFIG.downloadEngine,
          } : {}),
          ...(MODULE_USERSCRIPTS ? {
            userscriptMaxResponseMB: cfg.userscriptMaxResponseMB ?? DEFAULT_MAIN_CONFIG.userscriptMaxResponseMB,
            userscriptTimeoutSeconds: cfg.userscriptTimeoutSeconds ?? DEFAULT_MAIN_CONFIG.userscriptTimeoutSeconds,
            userscriptMaxConcurrentPerScript: cfg.userscriptMaxConcurrentPerScript ?? DEFAULT_MAIN_CONFIG.userscriptMaxConcurrentPerScript,
            userscriptMaxConcurrentGlobal: cfg.userscriptMaxConcurrentGlobal ?? DEFAULT_MAIN_CONFIG.userscriptMaxConcurrentGlobal,
            userscriptDownloadMaxMB: cfg.userscriptDownloadMaxMB ?? DEFAULT_MAIN_CONFIG.userscriptDownloadMaxMB,
            userscriptDownloadConcurrent: cfg.userscriptDownloadConcurrent ?? DEFAULT_MAIN_CONFIG.userscriptDownloadConcurrent,
            userscriptMaxValueKB: cfg.userscriptMaxValueKB ?? DEFAULT_MAIN_CONFIG.userscriptMaxValueKB,
          } : {}),
          ...(MODULE_AUTOMATION ? {
            automationVisionWarmStart: cfg.automationVisionWarmStart ?? true,
            automationOcrWarmStart: cfg.automationOcrWarmStart ?? true,
          } : {}),
        } as MainConfigForm;
        loadedMainFormRef.current = loaded;
        setMainForm(loaded);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!MODULE_PASSWORDS) return;
    window.electronAPI?.pwd?.status().then((status) => {
      setAutoCapture(status.autoCapture);
      setAutoFill(status.autoFill);
      setAutoFillReady(status.autoFillReady);
      setPasswordStoreInitialized(status.initialized);
      setPasswordTier(status.tier);
      setPasswordKeyStatus(status.keyStatus ?? 'ok');
      setPasswordKeyReason(status.keyIssue?.reason ?? null);
      setExcludedSitesText(status.excludedSites.join('\n'));
      setViewGuard(status.viewGuard);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (activeSection !== 'downloads') return;
    if (MODULE_DOWNLOAD) window.electronAPI?.dl?.getDir().then(setDownloadDir).catch(() => {});
    window.electronAPI?.screenshot?.getDir?.().then(setScreenshotDir).catch(() => {});
  }, [activeSection]);

  const handleSelectDownloadDir = useCallback(async () => {
    try {
      const dir = await window.electronAPI.dl.setDir(LL.download.selectDir());
      if (dir) { setDownloadDir(dir); pushToast({ message: LL.download.dirChanged(), type: 'success' }); }
    } catch { pushToast({ message: LL.settings.directoryFailed(), type: 'error' }); }
  }, [LL, pushToast]);

  const handleAutoCaptureChange = useCallback(async (enabled: boolean) => {
    setAutoCapture(enabled);
    try {
      const result = await window.electronAPI.pwd.setAutoCapture(enabled);
      setAutoCapture(result.enabled);
    } catch {
      setAutoCapture(!enabled);
    }
  }, []);

  const handleAutoFillChange = useCallback(async (enabled: boolean) => {
    setAutoFill(enabled);
    try {
      const result = await window.electronAPI.pwd.setAutoFill(enabled);
      setAutoFill(result.enabled);
      setAutoFillReady(result.ready);
    } catch {
      setAutoFill(!enabled);
    }
  }, []);

  const handleExcludedSitesSave = useCallback(async () => {
    const sites = excludedSitesText.split(/[\s,;]+/).map((site) => site.trim()).filter(Boolean);
    try {
      const result = await window.electronAPI.pwd.setExcludedSites(sites);
      setExcludedSitesText(result.excludedSites.join('\n'));
      pushToast({ message: LL.password.excludedSitesSaved(), type: 'success' });
    } catch {
      pushToast({ message: LL.password.excludedSitesSaveFailed(), type: 'error' });
    }
  }, [excludedSitesText, pushToast, LL]);

  // Eagerly sync locale when language dropdown changes (before save)
  useEffect(() => {
    if (form.language) setLocale(form.language);
  }, [form.language, setLocale]);

  const handleChange = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }, []);

  const handleMainChange = useCallback(<K extends keyof MainConfigForm>(key: K, value: MainConfigForm[K]) => {
    setMainForm((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }, []);

  const handleSave = useCallback(async () => {
    try {
      if (!proxySettingsSchema.safeParse(mainForm.proxy).success) {
        throw new Error(LL.settings.proxy.invalid());
      }
      const result = await window.electronAPI.invoke('save-config', {
        proxy: mainForm.proxy,
        flashVersion: mainForm.flashVersion,
        flashPluginChannel: mainForm.flashPluginChannel,
        lowEndMode: mainForm.lowEndMode,
        screenshotDir: mainForm.screenshotDir,
        updateCheckMode: mainForm.updateCheckMode,
        ...(MODULE_DOWNLOAD ? { downloadEngine: mainForm.downloadEngine } : {}),
        ...(MODULE_USERSCRIPTS ? {
          userscriptMaxResponseMB: mainForm.userscriptMaxResponseMB,
          userscriptTimeoutSeconds: mainForm.userscriptTimeoutSeconds,
          userscriptMaxConcurrentPerScript: mainForm.userscriptMaxConcurrentPerScript,
          userscriptMaxConcurrentGlobal: mainForm.userscriptMaxConcurrentGlobal,
          userscriptDownloadMaxMB: mainForm.userscriptDownloadMaxMB,
          userscriptDownloadConcurrent: mainForm.userscriptDownloadConcurrent,
          userscriptMaxValueKB: mainForm.userscriptMaxValueKB,
        } : {}),
        ...(MODULE_AUTOMATION ? {
          automationVisionWarmStart: mainForm.automationVisionWarmStart,
          automationOcrWarmStart: mainForm.automationOcrWarmStart,
        } : {}),
      });
      if (result === false) throw new Error('main config was not saved');

      const needsRestart = requiresMainConfigRestart(loadedMainFormRef.current, mainForm);
      loadedMainFormRef.current = { ...mainForm };
      setSettings(form);
      if (needsRestart) {
        setSaved('restart');
        pushToast({ message: LL.settings.savedRestart(), type: 'warning' });
      } else {
        setSaved(true);
        pushToast({ message: LL.settings.saved(), type: 'success' });
      }
    } catch (error) {
      setSaved(false);
      pushToast({
        message: LL.settings.saveFailed({ error: error instanceof Error ? error.message : String(error) }),
        type: 'error',
      });
    }
  }, [form, mainForm, setSettings, pushToast, LL]);

  const handleSelectScreenshotDir = useCallback(async () => {
    try {
      const result = await window.electronAPI.screenshot.setDir(LL.settings.screenshot.dialogTitle());
      if (result.canceled) return;
      if (result.success && result.dir) {
        setMainForm((prev) => ({ ...prev, screenshotDir: result.dir as string }));
        setScreenshotDir(result.dir);
        pushToast({ message: LL.settings.screenshot.dirChanged(), type: 'success' });
      } else {
        const msg = result.code === 'DIR_NOT_WRITABLE'
          ? LL.settings.screenshot.dirNotWritable()
          : result.code === 'DIR_DENIED'
            ? LL.settings.screenshot.dirDenied()
            : LL.settings.screenshot.dirSelectFailed();
        pushToast({ message: msg, type: 'error' });
      }
    } catch {
      pushToast({ message: LL.settings.screenshot.dirSelectFailed(), type: 'error' });
    }
  }, [setMainForm, pushToast, LL]);

  const handleResetPassword = useCallback(async () => {
    if (!resetConfirming) { setResetConfirming(true); return; }
    setResetConfirming(false);
    await window.electronAPI?.pwd?.resetAll();
    const status = await window.electronAPI.pwd.status();
    setStoreStatus(status);
    setAutoCapture(status.autoCapture);
    setAutoFill(status.autoFill);
    setAutoFillReady(status.autoFillReady);
    setPasswordStoreInitialized(status.initialized);
    setPasswordTier(status.tier);
    setPasswordKeyStatus(status.keyStatus ?? 'ok');
    setPasswordKeyReason(status.keyIssue?.reason ?? null);
    setExcludedSitesText(status.excludedSites.join('\n'));
    setViewGuard(status.viewGuard);
    pushToast({ message: LL.password.resetDone(), type: 'info' });
  }, [resetConfirming, setStoreStatus, pushToast, LL]);

  /** 重新拉取门禁状态（设置查看密码/重新检测系统验证之后）。 */
  const reloadViewGuard = useCallback(async () => {
    const status = await window.electronAPI.pwd.status();
    setViewGuard(status.viewGuard);
  }, []);

  const handleViewPwdSave = useCallback(async () => {
    if (viewPwdNext.length < 6) { setViewPwdError(LL.password.viewGateTooShort()); return; }
    if (viewPwdNext !== viewPwdConfirm) { setViewPwdError(LL.password.viewGateMismatch()); return; }
    setViewPwdBusy(true);
    try {
      const result = await window.electronAPI.pwd.setViewPassword(viewPwdNext, viewPwdCurrent || undefined);
      if (!result.success) {
        setViewPwdError(
          result.error === 'wrong-credential'
            ? LL.password.viewGateWrong()
            : LL.password.viewGateChangeFailed(),
        );
        return;
      }
      setViewPwdCurrent(''); setViewPwdNext(''); setViewPwdConfirm('');
      setViewPwdOpen(false); setViewPwdError(null);
      pushToast({ message: LL.password.viewGateChanged(), type: 'success' });
      await reloadViewGuard();
    } finally {
      setViewPwdBusy(false);
    }
  }, [viewPwdNext, viewPwdConfirm, viewPwdCurrent, pushToast, LL, reloadViewGuard]);

  const handleRecheckOsAuth = useCallback(async () => {
    const result = await window.electronAPI.pwd.resetOsAuth();
    setViewGuard(result.viewGuard);
  }, []);

  const handleExportDiagnostics = useCallback(async () => {
    setExportingDiagnostics(true);
    try {
      const result = await window.electronAPI.diagnostics.export();
      if (result.saved) pushToast({ message: LL.settings.diagnosticsSaved(), type: 'success' });
    } catch {
      pushToast({ message: LL.settings.diagnosticsFailed(), type: 'error' });
    } finally {
      setExportingDiagnostics(false);
    }
  }, [pushToast, LL]);

  const handleClearCache = useCallback(async () => {
    if (!cacheConfirming) { setCacheConfirming(true); return; }
    setCacheConfirming(false);
    setClearingCache(true);
    try {
      await window.electronAPI.cache.clear();
      pushToast({ message: LL.settings.cacheCleared(), type: 'success' });
    } catch {
      pushToast({ message: LL.settings.cacheClearFailed(), type: 'error' });
    } finally {
      setClearingCache(false);
    }
  }, [cacheConfirming, pushToast, LL]);

  const handleOpenSwf = useCallback(async () => {
    const url = await window.electronAPI.file.openSwf();
    if (url) onOpenUrl(url, true);
  }, [onOpenUrl]);

  return {
    form,
    mainForm,
    handleChange,
    handleMainChange,
    handleSave,
    saved,
    appVersion,
    checkingUpdate,
    updateResult,
    setUpdateResult,
    handleCheckUpdate,
    downloadDir,
    screenshotDir,
    handleSelectDownloadDir,
    handleSelectScreenshotDir,
    resetConfirming,
    setResetConfirming,
    autoCapture,
    autoFill,
    autoFillReady,
    passwordTier,
    passwordStoreInitialized,
    passwordKeyStatus,
    passwordKeyReason,
    excludedSitesText,
    setExcludedSitesText,
    handleAutoCaptureChange,
    handleAutoFillChange,
    handleExcludedSitesSave,
    handleResetPassword,
    viewGuard,
    viewPwdOpen,
    setViewPwdOpen,
    viewPwdCurrent,
    setViewPwdCurrent,
    viewPwdNext,
    setViewPwdNext,
    viewPwdConfirm,
    setViewPwdConfirm,
    viewPwdBusy,
    viewPwdError,
    setViewPwdError,
    handleViewPwdSave,
    handleRecheckOsAuth,
    exportingDiagnostics,
    handleExportDiagnostics,
    cacheConfirming,
    setCacheConfirming,
    clearingCache,
    handleClearCache,
    handleOpenSwf,
    activeSection,
    setActiveSection,
  };
}

export type SettingsPanelState = ReturnType<typeof useSettingsPanel>;
