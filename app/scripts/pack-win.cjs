const { spawnSync } = require('node:child_process')
const { mkdirSync, mkdtempSync } = require('node:fs')
const { join, resolve } = require('node:path')

const root = resolve(__dirname, '..')
const dist = join(root, 'dist')
mkdirSync(dist, { recursive: true })
const output = mkdtempSync(join(dist, 'win-preview-'))

const result = spawnSync(process.execPath, [
  require.resolve('electron-builder/cli.js'),
  '--config', 'electron-builder.config.cjs',
  `--config.directories.output=${output}`,
  '--win', '--x64', '--dir', '--publish', 'never'
], { cwd: root, stdio: 'inherit' })

if (result.error) throw result.error
process.exitCode = result.status ?? 1
if (result.status === 0) {
  console.log('Win x64 验证版：', join(output, 'win-unpacked', 'BaoFlashBrowser Next.exe'))
}
