import fs from 'fs';
import path from 'path';

/**
 * Physical Flash plugin version resolution.
 *
 * Three sources, in increasing cost:
 *   1. the file name (`pepflashplayer64_34_0_0_380.dll`) — free, authoritative
 *      for the experimental bundles that encode the version there;
 *   2. the version token embedded in the binary (`WIN 29,0,0,171`,
 *      `LNX 32,0,0,371`) — the canonical string the plugin reports to pages;
 *   3. `manifest.json` next to a macOS `.plugin` bundle.
 *
 * Stable bundles ship with unversioned file names, so source 2 is what makes
 * `physicalVersion` observable at all. Reading it does NOT change what the app
 * advertises to sites: `ppapi-flash-version` still comes from config (see
 * `flash.ts`), because legacy gates are pinned to 34.0.0.330.
 */

const VERSION_PATTERN = /^\d+\.\d+\.\d+\.\d+$/;

/** `WIN 29,0,0,171` — the token present in every bundled build. */
const EMBEDDED_TOKEN = /(?:WIN|LNX|MAC|UNIX) (\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3})/g;

/** Flash 10 was the first PPAPI era; anything lower is not a real token. */
const MIN_PLAUSIBLE_MAJOR = 10;

/** Guard against pathological inputs; the largest bundled plugin is ~31 MB. */
const MAX_SCAN_BYTES = 64 * 1024 * 1024;

interface CacheEntry {
  size: number;
  mtimeMs: number;
  version: string | null;
}

const cache = new Map<string, CacheEntry>();

export function extractVersionFromFilename(pluginPath: string): string | null {
  const name = path.basename(pluginPath, path.extname(pluginPath));
  const parts = name.split('_');
  for (let i = parts.length - 4; i >= 0; i--) {
    const version = parts.slice(i, i + 4).join('.');
    if (VERSION_PATTERN.test(version)) return version;
  }
  return null;
}

function pickToken(text: string): string | null {
  let fallback: string | null = null;
  for (const match of text.matchAll(EMBEDDED_TOKEN)) {
    const version = match.slice(1, 5).join('.');
    if (Number(match[1]) >= MIN_PLAUSIBLE_MAJOR) return version;
    fallback ??= version;
  }
  return fallback;
}

/**
 * Scans the plugin binary for its embedded `PLATFORM x,y,z,w` token.
 * ASCII first (all current bundles), UTF-16LE as a fallback for hypothetical
 * wide-string builds. Results are cached per path + size + mtime.
 */
export function readEmbeddedFlashVersion(pluginPath: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(pluginPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SCAN_BYTES) return null;

  const cached = cache.get(pluginPath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.version;
  }

  let version: string | null = null;
  try {
    const buffer = fs.readFileSync(pluginPath);
    version = pickToken(buffer.toString('latin1')) ?? pickToken(buffer.toString('utf16le'));
  } catch {
    version = null;
  }

  cache.set(pluginPath, { size: stat.size, mtimeMs: stat.mtimeMs, version });
  return version;
}

/** Clears the scan cache. Tests only; production has no invalidation path. */
export function clearFlashVersionCache(): void {
  cache.clear();
}
