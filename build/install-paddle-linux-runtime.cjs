const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const archive = path.join(root, '.cache', 'ocr', 'paddle-linux-x64-manylinux.tar.gz');
const target = path.join(root, 'native', 'ocr', 'paddle', 'linux-x64');

if (!fs.existsSync(archive)) {
  throw new Error(`Linux Paddle OCR archive is missing: ${archive}\nBuild it with tools/ocr-paddle-cpp/Dockerfile.manylinux first.`);
}

const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
if (listing.status !== 0) throw new Error(`Could not inspect Paddle OCR archive: ${listing.stderr}`);
const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
if (!entries.length || entries.some((entry) => {
  const normalized = entry.replace(/^\.\//, '');
  return path.isAbsolute(normalized) || normalized.split('/').includes('..');
})) throw new Error('Paddle OCR archive contains an unsafe path');

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
const extraction = spawnSync('tar', ['-xzf', archive, '-C', target], { encoding: 'utf8' });
if (extraction.status !== 0) throw new Error(`Could not extract Paddle OCR archive: ${extraction.stderr}`);
for (const required of ['bao-paddle-ocr-sidecar', 'OCR-RUNTIME.json', 'LICENSE-PaddleOCR']) {
  if (!fs.existsSync(path.join(target, required))) throw new Error(`Paddle OCR runtime is missing ${required}`);
}
if (process.platform !== 'win32') fs.chmodSync(path.join(target, 'bao-paddle-ocr-sidecar'), 0o755);
console.log(`Installed Linux Paddle OCR runtime: ${target}`);
