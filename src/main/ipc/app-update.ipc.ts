import { app, shell, Notification } from 'electron';
import log from 'electron-log';
import { z } from 'zod';
import { createValidatedHandler } from '../utils/ipc-wrapper';
import { checkAppUpdate, RELEASES_URL } from '../modules/app-update';
import { loadConfig } from '../modules/config';
import { uiText } from '../modules/ui-language';
import type { AppUpdateResult } from '../../shared/types/app-update';

// 并发合并：同一时刻只有一个查询在飞行中，多个调用共享同一结果。
let pending: Promise<AppUpdateResult> | undefined;
let releaseUrl = RELEASES_URL;

function checkOnce(): Promise<AppUpdateResult> {
  if (!pending) {
    pending = checkAppUpdate(app.getVersion()).then((result) => {
      releaseUrl = result.releaseUrl ?? RELEASES_URL;
      return result;
    }).finally(() => { pending = undefined; });
  }
  return pending;
}

export function registerAppUpdateIPC(): void {
  createValidatedHandler('app:version', z.object({}).optional(), () => app.getVersion());
  createValidatedHandler('app:check-update', z.object({}).optional(), () => checkOnce());
  createValidatedHandler('app:open-release', z.object({}).optional(), () => shell.openExternal(releaseUrl));
}

/**
 * 启动时自动检查更新（每次启动只查询一次，不轮询）。
 * 仅当 config.updateCheckMode === 'auto' 时执行；检测到新版本弹一次桌面通知，
 * 点击通知打开该版本的 Release 页。检查失败静默记录，不打扰用户。
 */
export async function runStartupUpdateCheck(): Promise<void> {
  if (loadConfig().updateCheckMode !== 'auto') return;
  try {
    const result = await checkOnce();
    if (result.status !== 'available' || !result.latestVersion) return;
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title: uiText('发现新版本', 'Update available'),
      body: uiText(
        `BaoFlashBrowser ${result.latestVersion} 已发布，点击查看更新。`,
        `BaoFlashBrowser ${result.latestVersion} is available. Click to view the release.`,
      ),
    });
    notification.on('click', () => {
      void shell.openExternal(result.releaseUrl ?? RELEASES_URL);
    });
    notification.show();
  } catch (error) {
    log.warn('[AppUpdate] startup update check failed:', error instanceof Error ? error.message : String(error));
  }
}
