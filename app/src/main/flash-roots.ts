import { join } from 'node:path'

/**
 * 自动发现 Flash 插件时的**已知安装位置**（纯函数：不 import electron，可在单测里覆盖）。
 *
 * 为什么要有这一步：真实机器上的 PPAPI 插件几乎总是**已经存在**——flash.cn 的安装器把
 * 它装进 `C:\Windows\System32\Macromed\Flash`（文件名带版本号，如
 * `pepflashplayer64_34_0_0_384.dll`），旧版 Chrome/Chromium 用组件更新把它放在
 * `<User Data>\PepperFlash\<版本>\`，国产双核浏览器（360/QQ/搜狗）也各自带一份。
 * 让用户自己从这些目录里挑一个 16 MB 的 DLL 再复制一遍没有必要：我们能找到，而且能先做
 * PE/Pepper 校验再交给内核。
 *
 * 这里只列**目录**，不预判存在性：不存在的目录 `readdirSync` 失败一次即可，比逐个
 * `existsSync` 更省事。`depth` 是允许进入的层数（1 = 只看该目录自身），全部取很小，
 * 避免进 `User Data\Default` 这种上万文件的分区；真正的兜底上限在 `flash-scan.ts`
 * （条目数与时间预算）。
 */

export interface FlashRootSpec {
  /** 绝对路径。 */
  path: string
  /** 递归深度：1 = 只看该目录自身。 */
  depth: number
  /** 来源标签（状态显示与日志用，渲染层负责翻成中文）。 */
  origin: string
}

export interface FlashRootEnvironment {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  /** 用户主目录；默认取 `USERPROFILE` / `HOME`。 */
  homeDir?: string
}

/** 按平台给出候选目录，按「命中概率」从高到低排列（预算用完时靠后的目录会被放弃）。 */
export function knownFlashRoots(options: FlashRootEnvironment): FlashRootSpec[] {
  const { platform, env } = options
  const home = options.homeDir ?? env.USERPROFILE ?? env.HOME
  const roots = platform === 'win32'
    ? windowsRoots(env, home)
    : platform === 'darwin'
      ? macRoots(env, home)
      : posixRoots(env, home)
  return dedupe(roots)
}

/**
 * Windows：系统级安装 → Chromium 系 → 国产双核浏览器 → 下载/桌面。
 *
 * `Macromed\Flash` 排第一是因为它是国内最常见的**可直接加载**的 64 位 PPAPI 插件；
 * Chrome 的组件式 Flash 在 32 位 Chrome 下是 `pepflashplayer.dll`（32 位），
 * 会在 PE 校验里被拒掉，所以顺序不影响正确性，只影响「先读到谁」。
 */
function windowsRoots(env: Record<string, string | undefined>, home: string | undefined): FlashRootSpec[] {
  const roots: FlashRootSpec[] = []
  const systemRoot = env.WINDIR ?? env.SystemRoot
  if (systemRoot) {
    roots.push({ path: join(systemRoot, 'System32', 'Macromed', 'Flash'), depth: 1, origin: 'system-flash' })
  }

  const local = env.LOCALAPPDATA
  if (local) {
    roots.push(
      { path: join(local, 'Google', 'Chrome', 'User Data', 'PepperFlash'), depth: 2, origin: 'chrome' },
      { path: join(local, 'Chromium', 'User Data', 'PepperFlash'), depth: 2, origin: 'chromium' },
      { path: join(local, 'Microsoft', 'Edge', 'User Data', 'PepperFlash'), depth: 2, origin: 'edge' },
      { path: join(local, '360Chrome', 'Chrome', 'User Data', 'PepperFlash'), depth: 2, origin: 'browser-360' },
      { path: join(local, 'Tencent', 'QQBrowser', 'User Data', 'PepperFlash'), depth: 2, origin: 'browser-qq' }
    )
  }

  const appData = env.APPDATA
  if (appData) {
    roots.push(
      { path: join(appData, '360se6', 'User Data', 'PepperFlash'), depth: 2, origin: 'browser-360' },
      { path: join(appData, 'SogouExplorer', 'PepperFlash'), depth: 2, origin: 'browser-sogou' }
    )
  }

  for (const programFiles of [env.PROGRAMFILES ?? env.ProgramFiles, env['PROGRAMFILES(X86)'] ?? env['ProgramFiles(x86)']]) {
    if (!programFiles) continue
    roots.push(
      { path: join(programFiles, 'Google', 'Chrome', 'Application'), depth: 3, origin: 'chrome' },
      { path: join(programFiles, 'Adobe', 'Flash Player'), depth: 1, origin: 'system-flash' }
    )
  }

  if (home) {
    roots.push(
      { path: join(home, 'Downloads'), depth: 2, origin: 'downloads' },
      { path: join(home, 'Desktop'), depth: 2, origin: 'desktop' }
    )
  }
  return roots
}

/** macOS：Chrome 的组件式 Flash 是 `PepperFlashPlayer.plugin/Contents/MacOS/PepperFlashPlayer`。 */
function macRoots(env: Record<string, string | undefined>, home: string | undefined): FlashRootSpec[] {
  const roots: FlashRootSpec[] = [
    { path: '/Library/Application Support/Google/Chrome/PepperFlash', depth: 2, origin: 'chrome' },
    { path: '/Library/Internet Plug-Ins', depth: 4, origin: 'system-flash' }
  ]
  if (home) {
    roots.push(
      { path: join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'PepperFlash'), depth: 2, origin: 'chrome' },
      { path: join(home, 'Downloads'), depth: 2, origin: 'downloads' }
    )
  }
  const configHome = env.XDG_CONFIG_HOME ?? (home ? join(home, 'Library', 'Application Support') : undefined)
  if (configHome) roots.push({ path: join(configHome, 'Chromium', 'PepperFlash'), depth: 2, origin: 'chromium' })
  return roots
}

/** Linux：发行版包（adobe-flashplugin / pepperflashplugin-nonfree）与 Chromium 自带的铜板目录。 */
function posixRoots(env: Record<string, string | undefined>, home: string | undefined): FlashRootSpec[] {
  const roots: FlashRootSpec[] = [
    { path: '/usr/lib/adobe-flashplugin', depth: 1, origin: 'system-flash' },
    { path: '/usr/lib/flashplugin-installer', depth: 1, origin: 'system-flash' },
    { path: '/usr/lib/pepperflashplugin-nonfree', depth: 1, origin: 'system-flash' },
    { path: '/usr/lib/chromium-browser', depth: 1, origin: 'chromium' },
    { path: '/usr/lib64/flash-plugin', depth: 1, origin: 'system-flash' },
    { path: '/opt/google/chrome/pepper', depth: 2, origin: 'chrome' }
  ]
  const configHome = env.XDG_CONFIG_HOME ?? (home ? join(home, '.config') : undefined)
  if (configHome) {
    roots.push(
      { path: join(configHome, 'google-chrome', 'PepperFlash'), depth: 2, origin: 'chrome' },
      { path: join(configHome, 'chromium', 'PepperFlash'), depth: 2, origin: 'chromium' }
    )
  }
  if (home) roots.push({ path: join(home, 'Downloads'), depth: 2, origin: 'downloads' })
  return roots
}

/** 去重（Windows 路径大小写不敏感，统一按小写比较），顺带丢掉空路径。 */
function dedupe(roots: FlashRootSpec[]): FlashRootSpec[] {
  const seen = new Set<string>()
  const result: FlashRootSpec[] = []
  for (const root of roots) {
    if (!root.path) continue
    const key = root.path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(root)
  }
  return result
}
