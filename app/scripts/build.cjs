const { spawnSync } = require('node:child_process')
const { dirname, resolve } = require('node:path')

function runNode(args, options = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: resolve(__dirname, '..'),
    stdio: 'inherit',
    windowsHide: true,
    ...options
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function build() {
  runNode([resolve(dirname(require.resolve('vue-tsc/package.json')), 'bin/vue-tsc.js'), '--noEmit'])
  const electronVite = resolve(dirname(require.resolve('electron-vite/package.json')), 'bin/electron-vite.js')
  runNode(['--require', resolve(__dirname, 'windows-build-spawn.cjs'), electronVite, 'build'])
}

if (require.main === module) build()
module.exports = { build, runNode }
