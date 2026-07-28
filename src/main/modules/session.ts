import { session } from 'electron';
import log from 'electron-log';

export function initSession(): void {
  const defaultSession = session.defaultSession;

  defaultSession.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.141 Safari/537.36',
  );

  log.info('[Session] initialized');
}

export function clearCache(): void {
  const defaultSession = session.defaultSession;
  defaultSession.clearCache().then(() => {
    log.info('[Session] cache cleared');
  });
}
