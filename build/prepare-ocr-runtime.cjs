const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const cacheRoot = path.join(projectRoot, '.cache', 'ocr');
const targetRoot = path.join(projectRoot, 'native', 'ocr', 'win64');
const version = '1.4.1';
const archiveName = `PaddleOCR-json_v${version}_windows_x64.7z`;
const archiveUrl = `https://github.com/hiroi-sora/PaddleOCR-json/releases/download/v${version}/${archiveName}`;
const archiveSha256 = 'c0912a70acb1f8f18fafe1f438a2935292a6ec7e2859156fa48a33e91358d71d';
const licenseUrl = 'https://raw.githubusercontent.com/hiroi-sora/PaddleOCR-json/v1.4.1/LICENSE';
const selectedModels = [
  'ch_PP-OCRv3_det_infer',
  'ch_PP-OCRv3_rec_infer',
  'ch_ppocr_mobile_v2.0_cls_infer',
];

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function download(url, destination, redirects = 0) {
  if (redirects > 8) return Promise.reject(new Error('too many OCR download redirects'));
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'BaoFlashBrowser-build' } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        resolve(download(new URL(response.headers.location, url).toString(), destination, redirects + 1));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`download failed with HTTP ${response.statusCode}: ${url}`));
        return;
      }
      const output = fs.createWriteStream(destination);
      response.pipe(output);
      output.once('finish', () => output.close(resolve));
      output.once('error', reject);
    });
    request.once('error', reject);
  });
}

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else fs.copyFileSync(from, to);
  }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('PaddleOCR-json runtime preparation currently requires Windows');
  const readyMetadata = path.join(targetRoot, 'OCR-RUNTIME.json');
  if (fs.existsSync(path.join(targetRoot, 'PaddleOCR-json.exe')) && fs.existsSync(readyMetadata)) {
    const metadata = JSON.parse(fs.readFileSync(readyMetadata, 'utf8'));
    if (metadata.version === version && metadata.archiveSha256 === archiveSha256) {
      console.log(`OCR runtime already prepared: ${path.relative(projectRoot, targetRoot)}`);
      return;
    }
  }

  fs.mkdirSync(cacheRoot, { recursive: true });
  let archive = fs.readdirSync(cacheRoot)
    .filter((name) => name.toLowerCase().endsWith('.7z'))
    .map((name) => path.join(cacheRoot, name))
    .find((file) => {
      try { return sha256(file) === archiveSha256; } catch { return false; }
    });
  if (!archive) {
    archive = path.join(cacheRoot, archiveName);
    const partial = `${archive}.download`;
    console.log(`Downloading PaddleOCR-json ${version} from the official release...`);
    await download(archiveUrl, partial);
    if (sha256(partial) !== archiveSha256) throw new Error('downloaded OCR archive SHA-256 does not match the official release');
    fs.renameSync(partial, archive);
  }
  if (sha256(archive) !== archiveSha256) throw new Error('OCR archive SHA-256 does not match the official release');

  const extractRoot = path.join(cacheRoot, `extract-${version}`);
  fs.rmSync(extractRoot, { recursive: true, force: true });
  fs.mkdirSync(extractRoot, { recursive: true });
  const extracted = spawnSync('tar', ['-xf', archive, '-C', extractRoot], { stdio: 'inherit' });
  if (extracted.status !== 0) throw new Error(`failed to extract OCR archive (tar exit ${extracted.status})`);
  const sourceRoot = path.join(extractRoot, `PaddleOCR-json_v${version}`);
  if (!fs.existsSync(path.join(sourceRoot, 'PaddleOCR-json.exe'))) throw new Error('OCR archive has an unexpected layout');

  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.mkdirSync(targetRoot, { recursive: true });
  for (const name of fs.readdirSync(sourceRoot)) {
    const file = path.join(sourceRoot, name);
    if (fs.statSync(file).isFile() && /\.(?:dll|exe)$/i.test(name)) fs.copyFileSync(file, path.join(targetRoot, name));
  }
  const targetModels = path.join(targetRoot, 'models');
  fs.mkdirSync(targetModels, { recursive: true });
  for (const model of selectedModels) copyDirectory(path.join(sourceRoot, 'models', model), path.join(targetModels, model));
  for (const file of ['config_chinese.txt', 'dict_chinese.txt']) {
    fs.copyFileSync(path.join(sourceRoot, 'models', file), path.join(targetModels, file));
  }
  await download(licenseUrl, path.join(targetRoot, 'LICENSE'));
  fs.writeFileSync(path.join(targetRoot, 'THIRD-PARTY-NOTICE.txt'), [
    `PaddleOCR-json ${version}`, 'https://github.com/hiroi-sora/PaddleOCR-json',
    'Licensed under the Apache License 2.0. See LICENSE.',
    'This bundle keeps only the Simplified Chinese model, which also recognizes Latin letters and digits.',
    '',
  ].join('\r\n'));
  fs.writeFileSync(readyMetadata, JSON.stringify({
    name: 'PaddleOCR-json', version, archiveSha256, archiveUrl,
    language: 'Simplified Chinese + Latin', models: selectedModels,
  }, null, 2));
  console.log(`Prepared OCR runtime: ${path.relative(projectRoot, targetRoot)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
