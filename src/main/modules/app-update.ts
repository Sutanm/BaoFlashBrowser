import https from 'https';
import type { AppUpdateResult } from '../../shared/types/app-update';

export const RELEASES_URL = 'https://github.com/Sutanm/BaoFlashBrowser/releases';

// Release tags use stable major.minor.patch versions; prereleases are excluded.
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (value: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value)?.slice(1).map(Number);
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

export function checkAppUpdate(currentVersion: string): Promise<AppUpdateResult> {
  return new Promise((resolve) => {
    const fail = () => resolve({ status: 'error', currentVersion });
    const request = https.get('https://api.github.com/repos/Sutanm/BaoFlashBrowser/releases/latest', {
      headers: { 'User-Agent': 'BaoFlashBrowser', Accept: 'application/vnd.github+json' },
    }, (response) => {
      if (response.statusCode !== 200) { response.resume(); fail(); return; }
      let body = '';
      response.setEncoding('utf8');
      response.on('error', fail);
      response.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 1024 * 1024) request.destroy(new Error('Response too large'));
      });
      response.on('end', () => {
        try {
          const release = JSON.parse(body);
          if (release.draft || release.prerelease || typeof release.tag_name !== 'string'
            || !/^v?\d+\.\d+\.\d+$/.test(release.tag_name)) { fail(); return; }
          resolve({
            status: isNewerVersion(release.tag_name, currentVersion) ? 'available' : 'current',
            currentVersion,
            latestVersion: release.tag_name.replace(/^v/, ''),
            releaseUrl: `${RELEASES_URL}/tag/${encodeURIComponent(release.tag_name)}`,
          });
        } catch { fail(); }
      });
    });
    // Total deadline also covers stalled DNS and trickling responses.
    const deadline = setTimeout(() => request.destroy(new Error('Update check timed out')), 15000);
    request.on('close', () => clearTimeout(deadline));
    request.on('error', fail);
  });
}
