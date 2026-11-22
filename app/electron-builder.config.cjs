const { statSync } = require('node:fs')
const { dirname, isAbsolute } = require('node:path')

module.exports = {
  appId: 'com.baoflashbrowser.next',
  electronVersion: '39.8.10',
  // `vendor/` 里是版本固定的 Ruffle 运行时（见 vendor/ruffle/PROVENANCE.md），
  // 主进程按 app.getAppPath() 读取，必须打进 asar。
  files: ['out/**/*', 'vendor/**/*'],
  npmRebuild: false,
  electronDist() {
    const executable = process.env.ELECTRON_EXEC_PATH
    if (!executable || !isAbsolute(executable) || !statSync(executable, { throwIfNoEntry: false })?.isFile()) {
      throw new Error('请将 ELECTRON_EXEC_PATH 指向自编译 Electron 的绝对路径。')
    }
    return dirname(executable)
  },
  win: {
    signAndEditExecutable: false
  }
}
