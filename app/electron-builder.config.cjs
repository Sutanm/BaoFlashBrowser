const { statSync } = require('node:fs')
const { dirname, isAbsolute } = require('node:path')

module.exports = {
  appId: 'com.baoflashbrowser.next',
  electronVersion: '39.8.10',
  // `vendor/` 里是版本固定的 Ruffle 运行时（见 vendor/ruffle/PROVENANCE.md），
  // 主进程按 app.getAppPath() 读取，必须打进 asar。
  files: ['out/**/*', 'vendor/**/*'],
  // PPAPI 插件随**内核 dist 目录**进入 `win-unpacked/`（与 `BaoFlashBrowser Next.exe` 同目录），
  // `plugins.ts` 的候选路径里有 `dirname(process.execPath)`，因此不需要再复制一份到
  // `resources/`——之前用 extraResources 会让包里出现两份相同的 30MB DLL（审计 P2）。
  // 版权提示见 NOTICE.md：Flash Player 二进制再分发受 Adobe 许可约束。
  //
  // NOTICE.md 必须随包，便于分发时核对第三方许可（审计 P2 的另一项）。
  extraFiles: [
    { from: 'NOTICE.md', to: 'NOTICE.md' }
  ],
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
