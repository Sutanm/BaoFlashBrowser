import fs from 'fs';
import path from 'path';
import chokidar, { FSWatcher } from 'chokidar';
import type { AutomationAsset } from '../../../shared/automation/types';

const EXTENSIONS = new Set<AutomationAsset['extension']>(['.png', '.jpg', '.jpeg', '.webp']);

export type AssetScanOptions = {
  maxFiles?: number;
  maxFileBytes?: number;
};

export type AutomationAssetWatcher = {
  close(): Promise<void>;
};

function toAssetId(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath).split(path.sep).join('/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(`asset escaped root: ${absolutePath}`);
  }
  return relative;
}

export function scanAutomationAssets(root: string, options: AssetScanOptions = {}): AutomationAsset[] {
  const maxFiles = options.maxFiles ?? 1000;
  const maxFileBytes = options.maxFileBytes ?? 16 * 1024 * 1024;
  const resolvedRoot = path.resolve(root);
  if (!fs.existsSync(resolvedRoot)) return [];
  if (!fs.statSync(resolvedRoot).isDirectory()) throw new Error(`asset root is not a directory: ${resolvedRoot}`);

  const assets: AutomationAsset[] = [];
  const visit = (directory: string): void => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase() as AutomationAsset['extension'];
      if (!EXTENSIONS.has(extension)) continue;
      const bytes = fs.statSync(absolutePath).size;
      if (bytes > maxFileBytes) throw new Error(`asset exceeds ${maxFileBytes} bytes: ${absolutePath}`);
      assets.push({ id: toAssetId(resolvedRoot, absolutePath), absolutePath, bytes, extension });
      if (assets.length > maxFiles) throw new Error(`asset count exceeds ${maxFiles}`);
    }
  };
  visit(resolvedRoot);
  return assets;
}

export function watchAutomationAssets(
  root: string,
  onChange: (assets: AutomationAsset[]) => void,
  options: AssetScanOptions & { debounceMs?: number } = {},
): AutomationAssetWatcher {
  const resolvedRoot = path.resolve(root);
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  const emit = (): void => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!closed) onChange(scanAutomationAssets(resolvedRoot, options));
    }, options.debounceMs ?? 80);
  };
  const watcher: FSWatcher = chokidar.watch(resolvedRoot, {
    ignoreInitial: true,
    followSymlinks: false,
    depth: 20,
  });
  watcher.on('add', emit).on('change', emit).on('unlink', emit).on('addDir', emit).on('unlinkDir', emit);
  return {
    async close(): Promise<void> {
      closed = true;
      if (timer) clearTimeout(timer);
      await watcher.close();
    },
  };
}
