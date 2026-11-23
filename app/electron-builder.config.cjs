const { statSync } = require('node:fs')
const { dirname, isAbsolute } = require('node:path')

/**
 * 签名只在提供证书时才接入（发布门禁）。
 *
 * - `signAndEditExecutable: false` 会**同时**关掉资源编辑与代码签名，所以未签名时保持 false
 *   （避免无证书构建报错），但会在打包结尾明确报告"未签名"。
 * - 提供 `WIN_CSC_LINK`/`CSC_LINK`（electron-builder 的标准证书入口，可以是 pfx 路径或 base64）
 *   时打开签名，并允许资源编辑；`CSC_KEY_PASSWORD` 提供密码。
 */
const canSign = Boolean(process.env.WIN_CSC_LINK || process.env.CSC_LINK)

module.exports = {
  appId: 'com.baoflashbrowser.next',
  electronVersion: '39.8.10',
  // `vendor/` 里是版本固定的 Ruffle 运行时（见 vendor/ruffle/PROVENANCE.md），
  // 主进程按 app.getAppPath() 读取，必须打进 asar。
  files: ['out/**/*', 'vendor/**/*'],
  // PPAPI 插件随**内核 dist 目录**进入 `win-unpacked/`（与 `BaoFlashBrowser Next.exe` 同目录），
  // `plugins.ts` 的候选路径里有 `dirname(process.execPath)`，因此不需要再复制一份到
  // `resources/`——之前用 extraResources 会让包里出现两份相同的 30MB DLL（审计 P2）。
  //
  // 许可文件必须随包（审计 P2 / 发布门禁）：NOTICE.md 说明组件与缺口，
  // licenses/ 下是 Electron 本体许可与 Chromium 第三方许可（来源见 licenses/README.md）。
  extraFiles: [
    { from: 'NOTICE.md', to: 'NOTICE.md' },
    { from: 'licenses', to: 'licenses' }
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
    // 有证书就签名（并按 electron-builder 默认重写资源）；没有证书则保持不签名，
    // 由 pack-win.cjs 在结尾报告为发布门禁。
    signAndEditExecutable: canSign
  }
}
