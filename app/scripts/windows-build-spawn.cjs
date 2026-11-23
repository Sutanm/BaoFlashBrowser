// Vite calls exec('net use') to resolve Windows mapped drives.
// Keep the probe working without starting cmd.exe.
if (process.platform === 'win32') {
  const childProcess = require('node:child_process')
  const { join } = require('node:path')
  const exec = childProcess.exec
  const net = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'net.exe')
  childProcess.exec = function (command, options, callback) {
    if (command !== 'net use') return exec.apply(this, arguments)
    if (typeof options === 'function') {
      callback = options
      options = undefined
    }
    return childProcess.execFile(net, ['use'], { ...options, shell: false, windowsHide: true }, callback)
  }
  require('node:module').syncBuiltinESMExports()
}
