const fs = require('fs');
const path = require('path');

const targetPlatform = process.env.BAO_TARGET_PLATFORM || process.platform;
const targetArch = process.env.BAO_TARGET_ARCH || process.arch;

function selectedResources() {
  if (targetPlatform === 'win32' && targetArch === 'x64') {
    return [
      { from: 'plugins/win64', to: 'plugins/win64' },
      { from: 'plugins/experimental/win64', to: 'plugins/experimental/win64' },
      { from: 'native/aria2/aria2c.exe', to: 'native/aria2/aria2c.exe' },
      { from: 'native/mouse-hook.exe', to: 'native/mouse-hook.exe' },
    ];
  }

  if (targetPlatform === 'win32' && targetArch === 'ia32') {
    return [
      { from: 'plugins/win32', to: 'plugins/win32' },
      { from: 'native/aria2/win32/aria2c.exe', to: 'native/aria2/aria2c.exe' },
      { from: 'native/mouse-hook.exe', to: 'native/mouse-hook.exe' },
    ];
  }

  if (targetPlatform === 'linux' && targetArch === 'x64') {
    return [
      { from: 'plugins/linux64', to: 'plugins/linux64' },
      { from: 'native/aria2/aria2c', to: 'native/aria2/aria2c' },
      { from: 'native/mouse-hook-linux', to: 'native/mouse-hook-linux' },
    ];
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
  directories: { output: 'release' },
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
    artifactName: '${productName}-${version}-${arch}.${ext}',
  },
  beforePack: async () => {
    if (targetPlatform !== 'linux') return;
    for (const file of ['native/aria2/aria2c', 'native/mouse-hook-linux']) {
      fs.chmodSync(path.resolve(__dirname, '..', file), 0o755);
    }
  },
  afterPack: async (context) => {
    if (context.electronPlatformName !== 'linux') return;
    for (const file of ['native/aria2/aria2c', 'native/mouse-hook-linux']) {
      fs.chmodSync(path.join(context.appOutDir, 'resources', file), 0o755);
    }
  },
};
