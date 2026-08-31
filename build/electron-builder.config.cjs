const fs = require('fs');
const path = require('path');

const targetPlatform = process.env.BAO_TARGET_PLATFORM || process.platform;
const targetArch = process.env.BAO_TARGET_ARCH || process.arch;
const bundleOcr = process.env.BAO_OCR_BUNDLE === '1';

function selectedResources() {
  if (targetPlatform === 'win32' && targetArch === 'x64') {
    const resources = [
      { from: 'plugins/win64', to: 'plugins/win64' },
      { from: 'plugins/experimental/win64', to: 'plugins/experimental/win64' },
      { from: 'native/aria2/aria2c.exe', to: 'native/aria2/aria2c.exe' },
      { from: 'native/mouse-hook.exe', to: 'native/mouse-hook.exe' },
    ];
    if (bundleOcr) resources.push({ from: 'native/ocr/win64', to: 'native/ocr' });
    return resources;
  }

  if (targetPlatform === 'win32' && targetArch === 'ia32') {
    return [
      { from: 'plugins/win32', to: 'plugins/win32' },
      { from: 'native/aria2/win32/aria2c.exe', to: 'native/aria2/aria2c.exe' },
      { from: 'native/mouse-hook.exe', to: 'native/mouse-hook.exe' },
    ];
  }

  if (targetPlatform === 'linux' && targetArch === 'x64') {
    const resources = [
      { from: 'plugins/linux64', to: 'plugins/linux64' },
      { from: 'native/aria2/aria2c', to: 'native/aria2/aria2c' },
      { from: 'native/mouse-hook-linux', to: 'native/mouse-hook-linux' },
    ];
    if (bundleOcr) resources.push({ from: `native/ocr/paddle/${targetPlatform}-${targetArch}`, to: 'native/ocr/paddle' });
    return resources;
  }

  if (targetPlatform === 'darwin' && targetArch === 'x64') {
    return [
      { from: 'plugins/experimental/mac', to: 'plugins/experimental/mac' },
    ];
  }

  throw new Error(`Unsupported release target: ${targetPlatform}-${targetArch}`);
}

module.exports = {
  appId: 'com.bao.flashbrowser',
  productName: targetPlatform === 'darwin' ? 'BaoFlashBrowser Experimental' : 'BaoFlashBrowser',
  directories: { output: bundleOcr ? 'release/ocr' : 'release/standard' },
  ...(process.env.BAO_ELECTRON_DIST ? { electronDist: path.resolve(__dirname, '..', process.env.BAO_ELECTRON_DIST) } : {}),
  files: [
    {
      from: 'dist',
      to: 'dist',
      filter: ['**/*'],
    },
    {
      from: 'release/.app-metadata',
      to: '.',
      filter: ['package.json'],
    },
  ],
  // worker_threads 的 `new Worker(path)` 无法从 asar 归档内加载脚本：
  // 主进程 require 走 Electron 的 asar 集成，但 worker 入口文件由 Node 自行读取，
  // 必须落在真实文件系统上。opencv-js 是 worker 运行时 require 的依赖，
  // 与 worker 同目录树一起解包，保证 worker 解析 node_modules 时路径对得上。
  asarUnpack: [
    'dist/vision-worker.cjs',
    'node_modules/@techstark/opencv-js/**/*',
  ],
  extraResources: selectedResources(),
  win: {
    target: 'nsis',
    icon: 'build/icon.ico',
  },
  linux: {
    target: 'AppImage',
    icon: 'build/icon.png',
    category: 'Network',
  },
  mac: {
    target: ['dmg', 'zip'],
    icon: 'build/icon.png',
    category: 'public.app-category.utilities',
    artifactName: 'BaoFlashBrowser-Experimental-${version}-${arch}.${ext}',
    extendInfo: {
      CFBundleGetInfoString: 'Experimental macOS build — completely untested',
      NSHumanReadableCopyright: 'Experimental macOS build — completely untested',
    },
  },
  appImage: {
    artifactName: '${productName}-${version}-${arch}.${ext}',
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    artifactName: bundleOcr ? 'BaoFlashBrowser-OCR-${version}-${arch}.${ext}' : 'BaoFlashBrowser-${version}-${arch}.${ext}',
  },
  beforePack: async () => {
    if (targetPlatform !== 'linux') return;
    for (const file of ['native/aria2/aria2c', 'native/mouse-hook-linux']) {
      fs.chmodSync(path.resolve(__dirname, '..', file), 0o755);
    }
  },
  afterPack: async (context) => {
    if (context.electronPlatformName !== 'linux') return;
    const executableFiles = ['native/aria2/aria2c', 'native/mouse-hook-linux'];
    if (bundleOcr) executableFiles.push('native/ocr/paddle/bao-paddle-ocr-sidecar');
    for (const file of executableFiles) {
      fs.chmodSync(path.join(context.appOutDir, 'resources', file), 0o755);
    }
  },
};
