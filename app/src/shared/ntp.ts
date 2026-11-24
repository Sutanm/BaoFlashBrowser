import type { BrowserFailureCode } from './browser'
import type { Settings, ThemeMode } from './settings'
import type { ShellTheme } from './shell-theme'

/**
 * 新标签页（`bao://newtab`）与主进程之间的窄合同。
 *
 * 与设置页的 `baoSettings` 同一思路：只有「读状态 / 页面动作 / 单项主题写入 / 订阅」，
 * 页面拿不到 `baoBrowser`、拿不到通用设置写入口、也拿不到任意文件路径。发送者身份由主进程按
 * 「本窗口的新标签页标签 ∧ 主帧 ∧ 文档 URL ∈ bao://newtab/*」再验证一次。
 *
 * 两个内部页共用同一个 preload（同一个 WebContents 会在 NTP 与设置之间就地导航），
 * 所以 `baoNtp` 在设置页里也存在，但那边调用会被主进程按发送者拒掉。
 */
export const ntpChannels = {
  read: 'ntp:read',
  command: 'ntp:command',
  changed: 'ntp:changed'
} as const

/** 新标签页需要的状态：只给渲染要用的字段，不下发整份设置。 */
export interface NtpSnapshot {
  theme: ShellTheme
  settings: Pick<Settings, 'themeMode' | 'defaultEngine' | 'locale'>
  /** 原生 Flash 插件是否可用（BYOP：没放插件时页面提示去设置导入）。 */
  flash: boolean
  /** 未检测到插件时的期望投放路径提示。 */
  flashHint?: string
  storage: 'ready' | 'unavailable'
}

export type NtpCommand =
  | { type: 'open-settings' }
  | { type: 'navigate'; address: string }
  /** 新标签页上的主题拨盘只获得这一项设置的写权限。 */
  | { type: 'set-theme'; mode: ThemeMode }

export type NtpCommandResult = { ok: true } | { ok: false; code: BrowserFailureCode }

export interface NtpBridge {
  read(): Promise<NtpSnapshot | undefined>
  run(command: NtpCommand): Promise<NtpCommandResult>
  subscribe(listener: (snapshot: NtpSnapshot) => void): () => void
}
