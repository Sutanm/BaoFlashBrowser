import type { WebContents } from 'electron';
import { setupCapture, teardownCapture } from '../password-capture';

/**
 * Run a short-lived Automation CDP inspection without racing the persistent
 * password-capture debugger lease. Password capture is restored only after
 * the inspection has released its own lease.
 */
export async function inspectWithPasswordCapturePaused<T>(
  webContents: WebContents,
  inspect: (target: WebContents) => Promise<T>,
  shouldRestore: () => boolean = () => true,
): Promise<T> {
  teardownCapture(webContents);
  try { return await inspect(webContents); }
  finally {
    if (!webContents.isDestroyed() && shouldRestore()) setupCapture(webContents);
  }
}
