import { app, shell } from 'electron';
import { z } from 'zod';
import { createValidatedHandler } from '../utils/ipc-wrapper';
import { checkAppUpdate, RELEASES_URL } from '../modules/app-update';
import type { AppUpdateResult } from '../../shared/types/app-update';

export function registerAppUpdateIPC(): void {
  let pending: Promise<AppUpdateResult> | undefined;
  let releaseUrl = RELEASES_URL;
  createValidatedHandler('app:version', z.object({}).optional(), () => app.getVersion());
  createValidatedHandler('app:check-update', z.object({}).optional(), () => {
    if (!pending) {
      pending = checkAppUpdate(app.getVersion()).then((result) => {
        releaseUrl = result.releaseUrl ?? RELEASES_URL;
        return result;
      }).finally(() => { pending = undefined; });
    }
    return pending;
  });
  createValidatedHandler('app:open-release', z.object({}).optional(), () => shell.openExternal(releaseUrl));
}
