const { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } = require('node:fs')
const { dirname, join, relative, resolve } = require('node:path')

const source = process.argv[2]
if (!source || !existsSync(join(source, 'electron.exe'))) {
  throw new Error('用法：npm run runtime:prepare -- <自编译 Electron 的 dist 目录>')
}

const launcher = join(dirname(require.resolve('electron/package.json')), 'dist/resources/default_app.asar')
if (!existsSync(launcher)) {
  throw new Error('缺少 Electron 默认启动器。请运行 npm rebuild electron，确认未设置 ELECTRON_SKIP_BINARY_DOWNLOAD。')
}

const runtimeRoot = resolve(__dirname, '../.runtime')
const runtime = join(runtimeRoot, 'win-x64')
if (existsSync(runtime)) {
  throw new Error('本地运行时已准备。更换内核时，请先移走 .runtime/win-x64。')
}

mkdirSync(runtimeRoot, { recursive: true })
const staging = mkdtempSync(join(runtimeRoot, 'stage-'))

try {
  cpSync(source, staging, {
    recursive: true,
    filter(path) {
      const item = relative(source, path).replaceAll('\\', '/')
      return !['resources/app', 'resources/app.asar', 'resources/default_app.asar'].includes(item)
    }
  })
  mkdirSync(join(staging, 'resources'), { recursive: true })
  copyFileSync(launcher, join(staging, 'resources/default_app.asar'))
  renameSync(staging, runtime)
} finally {
  rmSync(staging, { recursive: true, force: true })
}

console.log('本地运行时已准备：', join(runtime, 'electron.exe'))
