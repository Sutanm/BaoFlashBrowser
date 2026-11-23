const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs')
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

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex').toUpperCase()
}

/**
 * 来源门禁（2026-11-23 审计 P2）。
 *
 * 原先只比较"所选输入与产物的 EXE 大小"，无法证明输入是我们批准的自编译内核。
 * 现在按 `scripts/runtime-manifest.json` 逐项校验 SHA-256：内核 EXE、PPAPI 插件、
 * Ruffle 运行时。任何一项不匹配即失败——除非显式设置
 * `BAO_ALLOW_UNVERIFIED_RUNTIME=1`（内核开发者换版本时用，且必须在提交信息里写明来源）。
 */
function verifyProvenance() {
  const manifestPath = join(root, 'scripts/runtime-manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const allowUnverified = process.env.BAO_ALLOW_UNVERIFIED_RUNTIME === '1'
  const problems = []
  for (const [relative, expected] of Object.entries(manifest.files)) {
    const file = join(root, relative)
    if (!existsSync(file)) {
      problems.push(`缺少文件：${relative}`)
      continue
    }
    const actual = sha256(file)
    if (actual !== expected) problems.push(`SHA-256 不符：${relative}\n  期望 ${expected}\n  实际 ${actual}`)
  }
  if (problems.length > 0) {
    const detail = problems.join('\n')
    if (allowUnverified) {
      console.warn(`[pack] 跳过来源校验（BAO_ALLOW_UNVERIFIED_RUNTIME=1）：\n${detail}`)
      return
    }
    console.error(`[pack] 内核/插件来源校验失败：\n${detail}\n`)
    console.error('[pack] 如果确实换了内核或插件，请更新 app/scripts/runtime-manifest.json 并在提交信息里写明来源与 tag。')
    console.error('[pack] 临时放行（不推荐）：设置 BAO_ALLOW_UNVERIFIED_RUNTIME=1。')
    process.exit(1)
  }
  console.log(`[pack] 来源校验通过（内核 tag ${manifest.kernel?.tag ?? '未知'}）：${Object.keys(manifest.files).length} 个文件`)
  return manifest
}

const manifestSource = verifyProvenance()

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

/** 产物自检：内核来源、插件唯一性、许可文件。 */
const unpacked = join(output, 'win-unpacked')
const packaged = join(unpacked, 'BaoFlashBrowser Next.exe')
const runtimeSize = statSync(electronExecutable).size
const packagedSize = statSync(packaged).size
// PE 资源写入会让产物与运行时差几十字节到几 KB；差到 MB 级说明换了内核。
// 签名/资源编辑会改变 PE 体积，有证书时放宽到 1MB。
const sizeTolerance = process.env.WIN_CSC_LINK || process.env.CSC_LINK ? 1024 * 1024 : 128 * 1024
if (Math.abs(packagedSize - runtimeSize) > sizeTolerance) {
  console.error(
    `打包产物不是自编译内核：运行时 ${runtimeSize} 字节，产物 ${packagedSize} 字节。` +
    ' 请确认 ELECTRON_EXEC_PATH 指向自编译 Electron。'
  )
  process.exit(1)
}

const pluginCopies = []
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (entry.name === 'pepflashplayer64.dll') pluginCopies.push(path)
  }
}
walk(unpacked)
if (pluginCopies.length !== 1) {
  console.error(`包内 Flash 插件应有且只有一份，实际 ${pluginCopies.length} 份：\n${pluginCopies.join('\n')}`)
  process.exit(1)
}
if (sha256(pluginCopies[0]) !== sha256(plugin)) {
  console.error('包内 Flash 插件与来源文件不一致。')
  process.exit(1)
}

const notice = join(unpacked, 'NOTICE.md')
const licenseFiles = [join(unpacked, 'licenses', 'LICENSES.chromium.html'), join(unpacked, 'licenses', 'LICENSE.electron')]
if (!existsSync(notice)) {
  console.error('包内缺少 NOTICE.md（第三方组件与许可说明）。')
  process.exit(1)
}
for (const file of licenseFiles) {
  if (!existsSync(file) || statSync(file).size === 0) {
    console.error(`包内缺少许可文件：${file}`)
    process.exit(1)
  }
}

/**
 * 代码签名状态（发布门禁）。
 *
 * 直接解析 PE 的**证书表**（可选头数据目录第 4 项）判断有没有签名块：
 * 运行环境里 `powershell.exe` 常常加载不了 Security 模块（受限环境），PowerShell 不可靠。
 * 这里只判断「有没有签名块」，签名链是否可信需发布时用 signtool 另行验证。
 */
function hasCertificateTable(exe) {
  const buffer = readFileSync(exe)
  if (buffer.length < 0x40) return false
  const peOffset = buffer.readUInt32LE(0x3c)
  if (peOffset + 0x18 > buffer.length) return false
  if (buffer.readUInt32LE(peOffset) !== 0x00004550) return false
  const optionalHeader = peOffset + 0x18
  const magic = buffer.readUInt16LE(optionalHeader)
  const directoriesOffset = optionalHeader + (magic === 0x20b ? 112 : 96)
  if (directoriesOffset + 8 * 5 > buffer.length) return false
  const certificateEntry = directoriesOffset + 8 * 4
  const size = buffer.readUInt32LE(certificateEntry + 4)
  return size > 0
}

function signatureStatus(exe) {
  const signed = hasCertificateTable(exe)
  return {
    signed,
    status: signed ? 'signed (certificate table present; chain not verified)' : 'not-signed'
  }
}
const signature = signatureStatus(packaged)
const manifest = {
  product: 'BaoFlashBrowser Next',
  kernel: manifestSource.kernel,
  generatedAt: new Date().toISOString(),
  executable: {
    name: 'BaoFlashBrowser Next.exe',
    bytes: packagedSize,
    runtimeBytes: runtimeSize,
    signature
  },
  components: {
    electron: '.runtime/win-x64/electron.exe',
    flashPlugin: { file: 'pepflashplayer64.dll', sha256: sha256(pluginCopies[0]) },
    ruffle: Object.entries(manifestSource.files)
      .filter(([file]) => file.startsWith('vendor/ruffle/'))
      .map(([file, hash]) => ({ file: file.replace('vendor/ruffle/', ''), sha256: hash }))
  },
  licenses: {
    notice: 'NOTICE.md',
    electron: 'licenses/LICENSE.electron',
    chromium: 'licenses/LICENSES.chromium.html',
    chromiumNote: '取自官方 Electron 39.8.10 发行包（同版本近似），非本内核构建产物',
    ruffle: ['vendor/ruffle/LICENSE_MIT', 'vendor/ruffle/LICENSE_APACHE']
  },
  releaseBlockers: [
    '代码签名未完成（未提供 WIN_CSC_LINK / CSC_LINK）',
    'Chromium 许可为同版本近似，需由内核构建生成替换',
    'Adobe Flash 插件再分发授权未确认',
    '独立复建与依赖校验未完成'
  ].filter((item) => !(item.startsWith('代码签名') && signature.signed))
}
writeFileSync(join(unpacked, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

console.log('Win x64 验证版：', packaged)
console.log(`内核校验：运行时 ${runtimeSize} 字节 / 产物 ${packagedSize} 字节`)
console.log(`插件：1 份，SHA-256 ${sha256(pluginCopies[0]).slice(0, 16)}…；许可：NOTICE.md 已随包`)
console.log(`[pack] 签名状态：${signature.status}${signature.signed ? '' : '（发布门禁）'}`)
console.log('[pack] 提醒：Flash 插件再分发授权未确认，仅限内部验证（见 NOTICE.md）；产物清单见 manifest.json。')
