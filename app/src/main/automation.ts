import { app } from 'electron'

// 发布包只有在 Playwright 显式使用自动化开关和调试端口时才允许无窗口启动。
// 仅继承开发/测试环境变量不会让正常启动的发布包消失。
const packagedSmoke = app.commandLine.hasSwitch('bao-smoke-hidden') &&
  app.commandLine.getSwitchValue('remote-debugging-port') === '0'

export const hiddenSmoke = process.env.BAO_SMOKE_HIDDEN === '1' && (!app.isPackaged || packagedSmoke)
export const backgroundSmoke = !app.isPackaged && !hiddenSmoke && process.env.BAO_SMOKE_BACKGROUND === '1'
