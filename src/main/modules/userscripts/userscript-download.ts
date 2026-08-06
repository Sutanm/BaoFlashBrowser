// GM_download filename sanitization and constants. Pure logic, no Electron.
// Mirrors the planned src/main/modules/userscripts/userscript-download.ts.

export const DEFAULT_DOWNLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30000;
export const DEFAULT_DOWNLOAD_MAX_CONCURRENT_PER_SCRIPT = 2;

export function sanitizeFileName(name: string, fallback = 'download'): string {
  const cleaned = String(name ?? '')
    .replace(/[\\/]/g, '')
    .replace(/^\.+/, '')
    // eslint-disable-next-line no-control-regex -- strip C0 control chars
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 200);
  return cleaned || fallback;
}
