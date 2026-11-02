const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
function runtimeDirectory(platform, arch) {
  return path.join(root, '.cache', 'esbuild-runtime', `${platform}-${arch}`);
}

// npm installs optional binaries for the build host, not the packaging target.
// Fetch the exact target package pinned by our lockfile and verify its integrity.
async function prepareEsbuildRuntime(platform, arch) {
  const target = `${platform}-${arch}`;
  if (!['win32-ia32', 'win32-x64', 'linux-x64', 'darwin-x64'].includes(target)) {
    throw new Error(`Unsupported esbuild target: ${target}`);
  }
  const lock = require('../package-lock.json');
  const entry = lock.packages[`node_modules/@esbuild/${target}`];
  const version = require('../node_modules/esbuild/package.json').version;
  if (!entry || entry.version !== version || !entry.integrity.startsWith('sha512-')) {
    throw new Error(`Missing matching locked esbuild runtime: ${target} ${version}`);
  }
  const directory = runtimeDirectory(platform, arch);
  fs.mkdirSync(directory, { recursive: true });
  const archive = path.join(directory, `${version}.tgz`);
  const valid = () => fs.existsSync(archive) &&
    `sha512-${crypto.createHash('sha512').update(fs.readFileSync(archive)).digest('base64')}` === entry.integrity;
  if (!valid()) {
    const response = await fetch(entry.resolved, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`esbuild download failed: HTTP ${response.status}`);
    fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
    if (!valid()) throw new Error(`esbuild integrity mismatch: ${target}`);
  }
  const member = platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild';
  const result = spawnSync('tar', ['-xzf', archive, '-C', directory, `package/${member}`], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`esbuild extraction failed: ${result.stderr}`);
  const binary = path.join(directory, platform === 'win32' ? 'esbuild.exe' : 'esbuild');
  fs.copyFileSync(path.join(directory, 'package', member), binary);
  fs.chmodSync(binary, 0o755);
  console.log(`[build] prepared esbuild ${version} for ${target}`);
}

module.exports = { prepareEsbuildRuntime, runtimeDirectory };
