import { app, webContents as allWebContents } from 'electron';
import fs from 'fs';
import path from 'path';
import log from 'electron-log';
import type { DevToolFlashInfo, DevToolSnapshot, DevToolTargetInfo } from '@shared/types/devtoolbox';
import { getCdpLeaseOwner } from './cdp-lease';
import { loadConfig } from './config';
import { describeContents, getBufferedEntries, isDevToolsContents } from './devtoolbox-collector';
import { resolveFlashPlugin } from './flash';
import { getMainWindow } from './window';
import { tabManager } from './tabs';

function readMmsCfg(pluginPath: string | null): string {
  if (!pluginPath) return '';
  const target = path.join(path.dirname(pluginPath), 'mms.cfg');
  try {
    return fs.readFileSync(target, 'utf-8').trim();
  } catch {
    return '';
  }
}

function buildFlashInfo(): DevToolFlashInfo {
  const config = loadConfig();
  const resolution = resolveFlashPlugin(app, config.flashPluginChannel, config.flashVersion);
  return {
    pluginPath: resolution.pluginPath,
    version: resolution.version,
    channel: `${resolution.requestedChannel} → ${resolution.effectiveChannel}`,
    source: resolution.source,
    fallbackReason: resolution.fallbackReason ?? null,
    mmsCfg: readMmsCfg(resolution.pluginPath),
    ua: (() => {
      try {
        return getMainWindow()?.webContents.getUserAgent() ?? '';
      } catch {
        return '';
      }
    })(),
  };
}

function collectTargets(): DevToolTargetInfo[] {
  const targets: DevToolTargetInfo[] = [];
  for (const wc of allWebContents.getAllWebContents()) {
    if (wc.isDestroyed() || isDevToolsContents(wc)) continue;
    const type = wc.getType();
    if (type !== 'browserView' && type !== 'window') continue;
    const { source, tabId } = describeContents(wc);
    targets.push({
      id: wc.id,
      kind: source === 'shell' ? 'shell' : 'page',
      tabId,
      url: (() => { try { return wc.getURL(); } catch { return ''; } })(),
      title: (() => { try { return wc.getTitle(); } catch { return ''; } })(),
    });
  }
  return targets;
}

/** `tabId` 由渲染层给（理由同 `probeActivePage`）：主进程的活动标签比渲染层晚一拍。 */
export function getDevToolSnapshot(tabId?: string | null): DevToolSnapshot {
  const resolvedId = tabId ?? tabManager.getActiveId();
  const activeWc = resolvedId ? tabManager.getWebContents(resolvedId) : null;
  return {
    entries: getBufferedEntries(),
    targets: collectTargets(),
    flash: buildFlashInfo(),
    cdpOwner: activeWc ? getCdpLeaseOwner(activeWc.id) : null,
    activeTabId: resolvedId,
  };
}

export function openNativeDevTools(target: 'page' | 'shell'): boolean {
  try {
    if (target === 'shell') {
      const win = getMainWindow();
      if (!win || win.isDestroyed()) return false;
      win.webContents.openDevTools({ mode: 'detach' });
      return true;
    }
    const tabId = tabManager.getActiveId();
    if (!tabId) return false;
    tabManager.openDevTools(tabId);
    return true;
  } catch (error) {
    log.warn('[DevToolbox] openNativeDevTools failed:', error instanceof Error ? error.message : String(error));
    return false;
  }
}
