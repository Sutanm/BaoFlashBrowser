const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const electronVersion = require('../node_modules/electron/package.json').version;
const platform = process.env.BAO_TARGET_PLATFORM || 'win32';
const arch = process.env.BAO_TARGET_ARCH || 'x64';
if (platform !== 'win32') process.exit(0);

const target = path.join(projectRoot, '.cache', 'electron', `${platform}-${arch}-${electronVersion}`);
if (fs.existsSync(path.join(target, 'electron.exe'))) {
  console.log(target);
  process.exit(0);
}

const cacheRoot = path.join(process.env.LOCALAPPDATA || '', 'electron', 'Cache');
const archiveName = `electron-v${electronVersion}-${platform}-${arch}.zip`;
function findArchive(root) {
  if (!fs.existsSync(root)) return '';
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isFile() && entry.name === archiveName) return file;
    if (entry.isDirectory()) {
      const found = findArchive(file);
      if (found) return found;
    }
  }
  return '';
}
const archive = findArchive(cacheRoot);
if (!archive) throw new Error(`Electron cache archive not found: ${archiveName}. Run electron-builder once to populate the cache.`);
fs.mkdirSync(target, { recursive: true });
const result = spawnSync('tar', ['-xf', archive, '-C', target], { stdio: 'inherit' });
if (result.status !== 0 || !fs.existsSync(path.join(target, 'electron.exe'))) {
  throw new Error(`failed to prepare Electron runtime (tar exit ${result.status})`);
}
console.log(target);
