import log from 'electron-log';
import type { Session } from 'electron';
import { patchedSWFObject } from './session';
import { setupDownloadHandlers } from './download';

let sessionSetup = false;

/**
 * One-time session configuration:
 * - Sets user agent
 * - Redirects Taomee swfobject.js to patched version
 * - Registers unified download handlers (Chromium tracking + aria2)
 */
export function setupSessionOnce(sess: Session): void {
  if (sessionSetup) return;
  sessionSetup = true;

  sess.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.141 Safari/537.36',
  );

  // Taomee SWFObject bypass
  sess.webRequest.onBeforeRequest(
    { urls: ['*://webres.61.com/common/js/swfobject.js*'] },
    (_details: any, cb: any) => {
      cb({ redirectURL: 'data:text/javascript;charset=utf-8,' + encodeURIComponent(patchedSWFObject()) });
    },
  );

  // Unified download handler (Chromium tracking or aria2)
  setupDownloadHandlers(sess);

  log.info('[SessionManager] session configured');
}
