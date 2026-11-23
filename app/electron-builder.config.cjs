const { statSync } = require('node:fs')
const { dirname, isAbsolute } = require('node:path')

module.exports = {
  appId: 'com.baoflashbrowser.next',
  electronVersion: '39.8.10',
  // `vendor/` 里是版本固定的 Ruffle 运行时（见 vendor/ruffle/PROVENANCE.md），
  // 主进程按 app.getAppPath() 读取，必须打进 asar。
  files: ['out/**/*', 'vendor/**/*'],
  // PPAPI 插件必须随包分发，否则打包版的原生引擎会静默停用（`plugins.ts` 会去
  // `process.resourcesPath` 找它）。来源是 `.runtime/win-x64/`——由
  // `npm run runtime:prepare` 准备，`pack-win.cjs` 在缺失时直接报错。
  // 版权提示：Flash Player 二进制随包分发受 Adobe 许可约束，发布前需确认分发范围。
  extraResources: [
    { from: '.runtime/win-x64/pepflashplayer64.dll', to: 'pepflashplayer64.dll' }
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
