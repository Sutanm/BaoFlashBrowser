const { spawnSync } = require('node:child_process')
const { existsSync, mkdirSync, readdirSync, rmSync, statSync } = require('node:fs')
const { join, resolve } = require('node:path')

const root = resolve(__dirname, '..')
const dist = join(root, 'dist')
mkdirSync(dist, { recursive: true })

/**
 * 输出目录固定为 `dist/win-preview`。
 *
 * 之前每次用 `mkdtempSync` 生成 `win-preview-<随机>`，每条打包验证都留下 ~450MB，
 * 开发几天就攒到几 GB。固定目录 + 打包前清空，保证磁盘上最多只有一份。
 * 历史遗留的随机目录一并清掉。
 */
const output = join(dist, 'win-preview')
rmSync(output, { recursive: true, force: true })
for (const entry of readdirSync(dist, { withFileTypes: true })) {
  if (entry.isDirectory() && /^win-preview-/.test(entry.name) && entry.name !== 'win-preview') {
    rmSync(join(dist, entry.name), { recursive: true, force: true })
  }
}

/** 打包版必须带 PPAPI 插件，否则原生引擎在真产物里会静默停用。 */
const plugin = join(root, '.runtime', 'win-x64', 'pepflashplayer64.dll')
if (!existsSync(plugin)) {
  console.error('缺少 .runtime/win-x64/pepflashplayer64.dll，先运行 npm run runtime:prepare。')
  process.exit(1)
}

/**
 * 必须显式把 `ELECTRON_EXEC_PATH` 传给 electron-builder。
 *
 * 踩过的坑（2026-11-23）：未设置该变量时 electron-builder 会**静默下载官方 Electron**
 * 来打包，产物大小 210MB（自编译运行时 232MB），`smoke:packaged` 因此报
 * `flash:timeout bridge-unavailable`——因为官方内核没有 PPAPI 补丁。
 * 这里既兜底设置，又在校验阶段断言产物就是我们自己的内核。
 */
const electronExecutable = process.env.ELECTRON_EXEC_PATH ?? join(root, '.runtime', 'win-x64', 'electron.exe')
if (!existsSync(electronExecutable)) {
  console.error(`找不到自编译 Electron：${electronExecutable}，先运行 npm run runtime:prepare。`)
  process.exit(1)
}

const result = spawnSync(process.execPath, [
  require.resolve('electron-builder/cli.js'),
  '--config', 'electron-builder.config.cjs',
  `--config.directories.output=${output}`,
  '--win', '--x64', '--dir', '--publish', 'never'
], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_EXEC_PATH: electronExecutable }
})

if (result.error) throw result.error
process.exitCode = result.status ?? 1
if (result.status !== 0) process.exit()

const packaged = join(output, 'win-unpacked', 'BaoFlashBrowser Next.exe')
const runtimeSize = statSync(electronExecutable).size
const packagedSize = statSync(packaged).size
// PE 资源写入会让产物与运行时差几十字节到几 KB；差到 MB 级说明换了内核。
if (Math.abs(packagedSize - runtimeSize) > 128 * 1024) {
  console.error(
    `打包产物不是自编译内核：运行时 ${runtimeSize} 字节，产物 ${packagedSize} 字节。` +
    ' 请确认 ELECTRON_EXEC_PATH 指向自编译 Electron。'
  )
  process.exit(1)
}
console.log('Win x64 验证版：', packaged)
console.log(`内核校验：运行时 ${runtimeSize} 字节 / 产物 ${packagedSize} 字节`)
