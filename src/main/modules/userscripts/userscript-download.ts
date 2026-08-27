// GM_download filename sanitization and constants. Pure logic, no Electron.
// Mirrors the planned src/main/modules/userscripts/userscript-download.ts.

export { sanitizeDownloadFilename as sanitizeFileName } from '../../utils/download-path';

export const DEFAULT_DOWNLOAD_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30000;
export const DEFAULT_DOWNLOAD_MAX_CONCURRENT_PER_SCRIPT = 4;
