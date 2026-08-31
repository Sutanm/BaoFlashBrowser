const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const asar = require('@electron/asar');

const projectRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const stage = option('stage', 'source');
const platform = option('platform', process.platform);
const arch = option('arch', process.arch);
const ocrMode = option('ocr', 'none');
const explicitRoot = option('root', '');
const allowMissingArtifact = args.includes('--allow-missing-artifact');
const failures = [];
const checkedFiles = [];

function fail(message) {
  failures.push(message);
}

function relative(file) {
  return path.relative(projectRoot, file).replace(/\\/g, '/');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function record(file, role) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    fail(`missing ${role}: ${relative(file)}`);
    return;
  }
  const stat = fs.statSync(file);
  checkedFiles.push({ role, path: relative(file), size: stat.size, sha256: sha256(file) });
}

function expectJsonFields(file, expected, role) {
  record(file, role);
  if (!fs.existsSync(file)) return;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [key, expectedValue] of Object.entries(expected)) {
      if (value[key] !== expectedValue) {
        fail(`${role} ${key} is ${JSON.stringify(value[key])}, expected ${JSON.stringify(expectedValue)}: ${relative(file)}`);
      }
    }
  } catch (error) {
    fail(`${role} is not valid JSON: ${relative(file)} (${error.message})`);
  }
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

function peMachine(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.length < 64 || buffer.toString('ascii', 0, 2) !== 'MZ') return null;
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 6 > buffer.length || buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') return null;
  const machine = buffer.readUInt16LE(peOffset + 4);
  return machine === 0x8664 ? 'x64' : machine === 0x014c ? 'ia32' : `machine-0x${machine.toString(16)}`;
}

function elfArch(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.length < 20 || !buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return null;
  const bits = buffer[4] === 2 ? '64' : buffer[4] === 1 ? '32' : '?';
  const machine = buffer.readUInt16LE(18);
  if (machine === 0x3e && bits === '64') return 'x64';
  if (machine === 0x03 && bits === '32') return 'ia32';
  return `elf${bits}-machine-0x${machine.toString(16)}`;
}

function machoArchitectures(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.length < 8) return [];

  const cpuName = (type) => {
    if (type === 0x01000007) return 'x64';
    if (type === 0x0100000c) return 'arm64';
    if (type === 7) return 'ia32';
    return `cpu-0x${(type >>> 0).toString(16)}`;
  };

  const littleMagic = buffer.readUInt32LE(0);
  const bigMagic = buffer.readUInt32BE(0);
  if (littleMagic === 0xfeedface || littleMagic === 0xfeedfacf) {
    return [cpuName(buffer.readUInt32LE(4))];
  }
  if (bigMagic === 0xfeedface || bigMagic === 0xfeedfacf) {
    return [cpuName(buffer.readUInt32BE(4))];
  }

  const isFat64 = bigMagic === 0xcafebabf;
  if (bigMagic !== 0xcafebabe && !isFat64) return [];
  const count = buffer.readUInt32BE(4);
  const entrySize = isFat64 ? 32 : 20;
  if (count > 32 || 8 + count * entrySize > buffer.length) return [];
  return Array.from({ length: count }, (_, index) => cpuName(buffer.readUInt32BE(8 + index * entrySize)));
}

function expectArch(file, expected, format, role) {
  record(file, role);
  if (!fs.existsSync(file)) return;
  const actual = format === 'pe' ? peMachine(file) : elfArch(file);
  if (actual !== expected) fail(`${role} architecture is ${actual || 'unknown'}, expected ${expected}: ${relative(file)}`);
}

function expectMachOArch(file, expected, role) {
  record(file, role);
  if (!fs.existsSync(file)) return;
  const architectures = machoArchitectures(file);
  if (!architectures.includes(expected)) {
    fail(`${role} architectures are ${architectures.join(', ') || 'unknown'}, expected ${expected}: ${relative(file)}`);
  }
}

function verifyRuffle(root, fromAsar = false) {
  if (fromAsar) return;
  const ruffleDir = path.join(root, 'lib', 'ruffle');
  record(path.join(ruffleDir, 'ruffle.js'), 'Ruffle bootstrap');
  record(path.join(ruffleDir, 'SourceHanSansCN-Regular.otf'), 'Ruffle CJK font');
  record(path.join(ruffleDir, 'SourceHanSans-LICENSE.txt'), 'Ruffle CJK font license');
  const files = walk(ruffleDir);
  if (!files.some((file) => /^core\.ruffle\..+\.js$/.test(path.basename(file)))) fail('missing Ruffle core JavaScript chunk');
  if (!files.some((file) => file.endsWith('.wasm'))) fail('missing Ruffle WebAssembly module');
  for (const file of files.filter((file) => /(^core\.ruffle\..+\.js$)|\.wasm$/.test(path.basename(file)))) {
    record(file, file.endsWith('.wasm') ? 'Ruffle WebAssembly' : 'Ruffle core');
  }
}

function verifySelectedResources(resourcesRoot, packaged = true) {
  const plugins = path.join(resourcesRoot, 'plugins');
  const native = path.join(resourcesRoot, 'native');

  if (platform === 'win32' && arch === 'x64') {
    expectArch(path.join(plugins, 'win64', 'pepflashplayer64.dll'), 'x64', 'pe', 'Windows x64 PPAPI');
    expectArch(
      path.join(plugins, 'experimental', 'win64', 'pepflashplayer64_34_0_0_380.dll'),
      'x64',
      'pe',
      'Windows x64 experimental China PPAPI',
    );
    expectArch(path.join(native, 'aria2', 'aria2c.exe'), 'x64', 'pe', 'Windows x64 aria2');
    expectArch(path.join(native, 'mouse-hook.exe'), 'ia32', 'pe', 'Windows mouse hook');
  } else if (platform === 'win32' && arch === 'ia32') {
    expectArch(path.join(plugins, 'win32', 'pepflashplayer.dll'), 'ia32', 'pe', 'Windows ia32 PPAPI');
    const aria2Path = packaged
      ? path.join(native, 'aria2', 'aria2c.exe')
      : path.join(native, 'aria2', 'win32', 'aria2c.exe');
    expectArch(aria2Path, 'ia32', 'pe', 'Windows ia32 aria2');
    expectArch(path.join(native, 'mouse-hook.exe'), 'ia32', 'pe', 'Windows mouse hook');
  } else if (platform === 'linux' && arch === 'x64') {
    expectArch(path.join(plugins, 'linux64', 'libpepflashplayer64.so'), 'x64', 'elf', 'Linux x64 PPAPI');
    expectArch(path.join(native, 'aria2', 'aria2c'), 'x64', 'elf', 'Linux x64 aria2');
    expectArch(path.join(native, 'mouse-hook-linux'), 'x64', 'elf', 'Linux mouse hook');
  } else if (platform === 'darwin' && arch === 'x64') {
    record(path.join(plugins, 'experimental', 'mac', 'README.txt'), 'macOS experimental support notice');
    const plugin = path.join(plugins, 'experimental', 'mac', 'PepperFlashPlayer.plugin');
    record(path.join(plugin, 'Contents', 'Info.plist'), 'macOS experimental PPAPI bundle metadata');
    expectMachOArch(
      path.join(plugin, 'Contents', 'MacOS', 'PepperFlashPlayer'),
      'x64',
      'macOS experimental PPAPI',
    );
    expectJsonFields(
      path.join(plugins, 'experimental', 'mac', 'manifest.json'),
      { version: '34.0.0.380', 'x-ppapi-arch': 'mac', 'x-ppapi-os': 'mac' },
      'macOS experimental PPAPI manifest',
    );
    if (walk(plugin).some((file) => file.endsWith('.lzma'))) {
      fail('macOS experimental PPAPI contains an undecoded .lzma payload');
    }
  } else {
    fail(`unsupported target ${platform}-${arch}`);
  }

  if (packaged) {
    const allowedPluginDir = platform === 'linux' ? 'linux64' : platform === 'win32' ? (arch === 'x64' ? 'win64' : 'win32') : null;
    for (const unwanted of ['linux64', 'win32', 'win64'].filter((name) => name !== allowedPluginDir)) {
      if (fs.existsSync(path.join(plugins, unwanted))) fail(`package contains foreign plugin directory: plugins/${unwanted}`);
    }
    const experimentalRoot = path.join(plugins, 'experimental');
    const allowedExperimentalDir = platform === 'darwin' ? 'mac' : platform === 'win32' && arch === 'x64' ? 'win64' : null;
    for (const unwanted of ['mac', 'win64'].filter((name) => name !== allowedExperimentalDir)) {
      if (fs.existsSync(path.join(experimentalRoot, unwanted))) fail(`package contains foreign experimental plugin directory: plugins/experimental/${unwanted}`);
    }
    for (const file of walk(native)) {
      if (/\.(c|cs)$/i.test(file)) fail(`package contains native source file: ${relative(file)}`);
      if (platform === 'linux' && file.endsWith('.exe')) fail(`Linux package contains Windows binary: ${relative(file)}`);
      if (platform === 'win32' && /mouse-hook-linux$|\/aria2c$/.test(file.replace(/\\/g, '/'))) fail(`Windows package contains Linux binary: ${relative(file)}`);
    }
    if (platform === 'darwin' && walk(resourcesRoot).some((file) => file.toLowerCase().endsWith('.dmg'))) {
      fail('macOS application resources contain a build-time DMG');
    }
  }
}

function compareVersions(left, right) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function highestGlibcRequirement(root) {
  let highest = null;
  for (const file of walk(root)) {
    let buffer;
    try {
      // Linux symlinks created on DrvFS appear as unreadable reparse points to
      // Windows Node. Their real targets are also present in the onedir tree.
      buffer = fs.readFileSync(file);
    } catch (error) {
      if (error && ['EACCES', 'EINVAL'].includes(error.code) && fs.lstatSync(file).isSymbolicLink()) continue;
      throw error;
    }
    if (buffer.length < 4 || !buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) continue;
    const matches = buffer.toString('latin1').matchAll(/GLIBC_(\d+\.\d+)/g);
    for (const match of matches) {
      if (!highest || compareVersions(match[1], highest.version) > 0) highest = { version: match[1], file };
    }
  }
  return highest;
}

function verifyOcr(resourcesRoot, packaged) {
  const ocrRoot = path.join(resourcesRoot, 'native', 'ocr');
  if (ocrMode === 'bundled') {
    if (!['win32', 'linux'].includes(platform) || arch !== 'x64') fail(`bundled OCR is not supported for ${platform}-${arch}`);
    if (platform === 'win32') {
      const paddleRoot = packaged ? ocrRoot : path.join(ocrRoot, 'win64');
      expectArch(path.join(paddleRoot, 'bao-paddle-ocr-sidecar.exe'), 'x64', 'pe', 'Paddle Inference BAO1 Sidecar');
      expectJsonFields(path.join(paddleRoot, 'OCR-RUNTIME.json'), {
        protocol: 1, provider: 'Paddle Inference', engine: 'Paddle Inference C++ 2.3.2 CPU MKL', model: 'PP-OCRv3', platform, arch,
      }, 'Paddle runtime manifest');
      record(path.join(paddleRoot, 'LICENSE'), 'PaddleOCR/PaddleOCR-json license');
      if (fs.existsSync(path.join(paddleRoot, 'PaddleOCR-json.exe'))) fail('Windows OCR package unexpectedly contains legacy PaddleOCR-json executable');
      if (packaged && fs.existsSync(path.join(ocrRoot, 'rapidocr'))) fail('Windows OCR package unexpectedly contains RapidOCR runtime');
      return;
    }
    const paddleRoot = packaged
      ? path.join(ocrRoot, 'paddle')
      : path.join(ocrRoot, 'paddle', `${platform}-${arch}`);
    const paddleExecutable = path.join(paddleRoot, 'bao-paddle-ocr-sidecar');
    expectArch(paddleExecutable, 'x64', 'elf', 'Paddle Inference Sidecar');
    const highestGlibc = highestGlibcRequirement(paddleRoot);
    if (!highestGlibc) fail(`Paddle Linux bundle has no readable glibc requirements: ${relative(paddleRoot)}`);
    else if (compareVersions(highestGlibc.version, '2.28') > 0) {
      fail(`Paddle Linux bundle requires GLIBC_${highestGlibc.version}, maximum supported is GLIBC_2.28: ${relative(highestGlibc.file)}`);
    }
    expectJsonFields(path.join(paddleRoot, 'OCR-RUNTIME.json'), {
      protocol: 1, provider: 'Paddle Inference', engine: 'Paddle Inference C++ 2.6.2 CPU MKL', model: 'PP-OCRv3', platform, arch,
    }, 'Paddle runtime manifest');
    for (const model of ['ch_PP-OCRv3_det_infer', 'ch_PP-OCRv3_rec_infer']) {
      record(path.join(paddleRoot, 'models', model, 'inference.pdmodel'), `Paddle ${model} graph`);
      record(path.join(paddleRoot, 'models', model, 'inference.pdiparams'), `Paddle ${model} parameters`);
    }
    record(path.join(paddleRoot, 'LICENSE-PaddleOCR'), 'PaddleOCR license');
  } else if (ocrMode === 'none' && packaged && fs.existsSync(ocrRoot)) {
    fail('standard package unexpectedly contains OCR runtime');
  }
}

function verifySource() {
  const dist = path.join(projectRoot, 'dist');
  for (const name of ['main.js', 'preload.js', 'webview-preload.js', 'vision-worker.cjs', 'renderer/index.html', 'renderer/bundle.js', 'renderer/bundle.css']) {
    record(path.join(dist, name), `dist/${name}`);
  }
  if (fs.existsSync(path.join(dist, 'dist'))) fail('stale nested build output exists at dist/dist');
  verifyRuffle(dist);
  verifySelectedResources(projectRoot, false);
  if (ocrMode === 'bundled') verifyOcr(projectRoot, false);
}

function packageExeMatches(dir) {
  if (platform !== 'win32') return true;
  return fs.readdirSync(dir).some((name) => name.endsWith('.exe') && peMachine(path.join(dir, name)) === arch);
}

function findUnpackedRoot() {
  if (explicitRoot) return path.resolve(projectRoot, explicitRoot);
  const release = path.join(projectRoot, 'release', ocrMode === 'bundled' ? 'ocr' : 'standard');
  if (!fs.existsSync(release)) return '';
  return fs.readdirSync(release, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && (
      platform === 'darwin' ? entry.name === 'mac' || entry.name.startsWith('mac-') : entry.name.endsWith('unpacked')
    ))
    .map((entry) => path.join(release, entry.name))
    .filter(packageExeMatches)
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || '';
}

function verifyAsar(asarPath) {
  record(asarPath, 'application archive');
  if (!fs.existsSync(asarPath)) return;
  const entries = asar.listPackage(asarPath).map((name) => name.replace(/\\/g, '/').replace(/^\/+/, ''));
  const required = [
    'package.json',
    'dist/main.js',
    'dist/preload.js',
    'dist/webview-preload.js',
    'dist/renderer/index.html',
    'dist/renderer/bundle.js',
    'dist/renderer/bundle.css',
    'dist/lib/ruffle/ruffle.js',
    'dist/lib/ruffle/SourceHanSansCN-Regular.otf',
    'dist/lib/ruffle/SourceHanSans-LICENSE.txt',
    'node_modules/electron-log/package.json',
    'node_modules/electron-store/package.json',
    'node_modules/@techstark/opencv-js/package.json',
  ];
  for (const name of required) if (!entries.includes(name)) fail(`app.asar is missing ${name}`);
  if (!entries.some((name) => /^dist\/lib\/ruffle\/core\.ruffle\..+\.js$/.test(name))) fail('app.asar is missing a Ruffle core chunk');
  if (!entries.some((name) => /^dist\/lib\/ruffle\/.+\.wasm$/.test(name))) fail('app.asar is missing Ruffle WebAssembly');
  if (entries.some((name) => name.startsWith('dist/dist/'))) fail('app.asar contains stale dist/dist output');
}

function verifyVisionWorkerUnpacked(resourcesRoot) {
  // worker_threads 无法从 asar 内加载脚本：vision-worker.cjs 与其运行时依赖
  // @techstark/opencv-js 必须通过 asarUnpack 解包到 app.asar.unpacked/。
  // 这里校验解包产物存在，防止有人误删 asarUnpack 配置后回归到打包报错。
  const unpacked = path.join(resourcesRoot, 'app.asar.unpacked');
  record(path.join(unpacked, 'dist', 'vision-worker.cjs'), 'unpacked vision worker');
  record(path.join(unpacked, 'node_modules', '@techstark', 'opencv-js', 'package.json'), 'unpacked OpenCV.js manifest');
  record(path.join(unpacked, 'node_modules', '@techstark', 'opencv-js', 'dist', 'opencv.js'), 'unpacked OpenCV.js bundle');
  if (fs.existsSync(path.join(resourcesRoot, 'app.asar')) && !fs.existsSync(unpacked)) {
    fail('app.asar.unpacked is missing — vision worker cannot be loaded by worker_threads');
  }
}

function verifyUnpacked() {
  const root = findUnpackedRoot();
  if (!root || !fs.existsSync(root)) {
    fail('could not find a matching unpacked application under release/');
    return;
  }
  const macApp = platform === 'darwin'
    ? fs.readdirSync(root, { withFileTypes: true }).find((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
    : null;
  const resources = macApp
    ? path.join(root, macApp.name, 'Contents', 'Resources')
    : path.join(root, 'resources');
  verifyAsar(path.join(resources, 'app.asar'));
  verifySelectedResources(resources);
  verifyOcr(resources, true);
  verifyVisionWorkerUnpacked(resources);

  if (platform === 'win32') {
    const exes = fs.readdirSync(root).filter((name) => name.endsWith('.exe'));
    const appExe = exes.find((name) => peMachine(path.join(root, name)) === arch);
    if (!appExe) fail(`unpacked application has no ${arch} executable`);
    else expectArch(path.join(root, appExe), arch, 'pe', 'packaged application executable');

    const installers = walk(path.join(projectRoot, 'release'))
      .filter((file) => file.endsWith(`-${arch}.exe`) && !file.includes(`${path.sep}${path.basename(root)}${path.sep}`))
      .filter((file) => ocrMode === 'bundled' ? path.basename(file).includes('-OCR-') : !path.basename(file).includes('-OCR-'))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (installers[0]) record(installers[0], 'NSIS installer');
    else if (!allowMissingArtifact) fail(`missing ${arch} NSIS installer under release/`);
  } else if (platform === 'linux') {
    const appImages = walk(path.join(projectRoot, 'release'))
      .filter((file) => arch === 'x64' ? /-(x64|x86_64)\.AppImage$/.test(file) : file.endsWith(`-${arch}.AppImage`))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (appImages[0]) record(appImages[0], 'AppImage');
    else if (!allowMissingArtifact) fail(`missing ${arch} AppImage under release/`);
  } else if (platform === 'darwin') {
    const artifacts = walk(path.join(projectRoot, 'release'))
      .filter((file) => /BaoFlashBrowser-Experimental-.+-(x64|x86_64)\.(dmg|zip)$/.test(path.basename(file)))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (artifacts.length > 0) artifacts.forEach((file) => record(file, 'macOS experimental artifact'));
    else if (!allowMissingArtifact) fail('missing experimental macOS DMG/ZIP under release/');
  }
}

if (stage === 'source') verifySource();
else if (stage === 'unpacked') verifyUnpacked();
else fail(`unknown verification stage: ${stage}`);

const manifest = {
  generatedAt: new Date().toISOString(),
  stage,
  target: `${platform}-${arch}`,
  profile: ocrMode === 'bundled' ? 'ocr' : 'standard',
  passed: failures.length === 0,
  files: checkedFiles,
  failures,
};
const manifestDir = path.join(projectRoot, 'release', 'manifests');
fs.mkdirSync(manifestDir, { recursive: true });
const manifestPath = path.join(manifestDir, `${platform}-${arch}-${ocrMode === 'bundled' ? 'ocr' : 'standard'}-${stage}.json`);
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

if (failures.length) {
  console.error(`[verify-release] ${failures.length} failure(s):`);
  for (const message of failures) console.error(`  - ${message}`);
  console.error(`[verify-release] manifest: ${relative(manifestPath)}`);
  process.exitCode = 1;
} else {
  console.log(`[verify-release] ${stage} ${platform}-${arch}: ${checkedFiles.length} files passed`);
  console.log(`[verify-release] manifest: ${relative(manifestPath)}`);
}
