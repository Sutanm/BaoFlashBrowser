const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs')
const { dirname, join, resolve } = require('node:path')
const { build } = require('./build.cjs')

build()

/**
 * 发布门禁（2026-11-26 审计）：**导出物必须能被导入脚本装回来**。
 *
 * 两种 profile 各跑一次往返（export → import → 校验关键件 → 清理），只校验「关键件」与
 * 「包完整性」两份契约，不碰开发者正在用的 `.runtime/win-x64`。慢（约 1–2 分钟），但比发布
 * 一个装不回来的归档便宜——上一版两种归档都装不回来，而"导出成功"给了相反的暗示。
 * 没有自编译运行时的机器上，脚本自己会跳过并返回 0。
 */
if (process.env.BAO_SKIP_RUNTIME_ROUNDTRIP !== '1') {
  const roundtrip = spawnSync(process.execPath, [join(__dirname, 'runtime-roundtrip.cjs')], {
    stdio: 'inherit',
    windowsHide: true
  })
  if (roundtrip.status !== 0) {
    console.error('运行时归档往返校验失败：导出物装不回来，拒绝打包。')
    process.exit(roundtrip.status ?? 1)
  }
}

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
// profile 先算：来源校验是否要求 Adobe 插件取决于它（public 是 BYOP，不要求）。
const PROFILE = process.argv.includes('--public') || process.env.BAO_PACK_PROFILE === 'public'
  ? 'public'
  : 'internal'

function verifyProvenance() {
  const manifestPath = join(root, 'scripts/runtime-manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const allowUnverified = process.env.BAO_ALLOW_UNVERIFIED_RUNTIME === '1'
  // 校验**实际会被打包的那份运行时**：electron-builder 从 ELECTRON_EXEC_PATH 所在目录复制，
  // 而仓库清单里的路径是 `.runtime/win-x64/...`。两者可能不是同一个目录（审计 P1）。
  const execPath = process.env.ELECTRON_EXEC_PATH ? resolve(process.env.ELECTRON_EXEC_PATH) : undefined
  const runtimeDir = execPath ? dirname(execPath) : join(root, '.runtime', 'win-x64')
  if (execPath && !existsSync(execPath)) {
    console.error(`[pack] ELECTRON_EXEC_PATH 指向不存在的文件：${execPath}`)
    process.exit(1)
  }
  const problems = []
  for (const [relative, expected] of Object.entries(manifest.files)) {
    // public 是 BYOP：运行时里本来就可以没有 Adobe 插件，产物反正会剔除。
    if (PROFILE === 'public' && relative.endsWith('pepflashplayer64.dll')) continue
    // 清单里混了两类路径：`.runtime/win-x64/...`（运行时输入，按实际目录解析）与
    // `vendor/ruffle/...`（应用资源，按仓库根解析）。
    const inRuntime = relative.startsWith('.runtime/win-x64/')
    const rel = inRuntime ? relative.slice('.runtime/win-x64/'.length) : relative
    const file = inRuntime ? join(runtimeDir, rel) : join(root, rel)
    if (!existsSync(file)) {
      problems.push(`缺少文件：${rel}`)
      continue
    }
    const actual = sha256(file)
    if (actual !== expected) problems.push(`SHA-256 不符：${rel}\n  期望 ${expected}\n  实际 ${actual}`)
  }
  let verified = true
  if (problems.length > 0) {
    const detail = problems.join('\n')
    if (allowUnverified) {
      console.warn(`[pack] 跳过来源校验（BAO_ALLOW_UNVERIFIED_RUNTIME=1）：\n${detail}`)
      verified = false
    } else {
      console.error(`[pack] 内核/插件来源校验失败（目录：${runtimeDir}）：\n${detail}\n`)
      console.error('[pack] 如果确实换了内核或插件，请更新 app/scripts/runtime-manifest.json 并在提交信息里写明来源与 tag。')
      console.error('[pack] 临时放行（不推荐）：设置 BAO_ALLOW_UNVERIFIED_RUNTIME=1。')
      process.exit(1)
    }
  } else {
    console.log(`[pack] 来源校验通过（目录 ${runtimeDir}，内核 tag ${manifest.kernel?.tag ?? '未知'}）：${Object.keys(manifest.files).length} 个文件`)
  }
  // 声明必须来自**本次实际校验的输入**：未通过校验时不能沿用仓库内核 tag。
  return { ...manifest, verified, runtimeDir }
}

const manifestSource = verifyProvenance()

rmSync(output, { recursive: true, force: true })
for (const entry of readdirSync(dist, { withFileTypes: true })) {
  if (entry.isDirectory() && /^win-preview-/.test(entry.name) && entry.name !== 'win-preview') {
    rmSync(join(dist, entry.name), { recursive: true, force: true })
  }
}


const signingRequested = Boolean(process.env.WIN_CSC_LINK || process.env.CSC_LINK)
if (PROFILE === 'internal' && signingRequested && process.env.BAO_ALLOW_SIGN_INTERNAL !== '1') {
  console.error('[pack] 内部包携带 Adobe Flash 插件，默认不允许签名（签名＝背书分发该二进制）。')
  console.error('[pack] 若明确知晓风险且仅用于内部审计，设置 BAO_ALLOW_SIGN_INTERNAL=1。')
  process.exit(1)
}
console.log(`[pack] profile=${PROFILE}${signingRequested ? '（已请求签名）' : ''}`)

/** 插件是 BYOP 素材：内部包需要它，公开包必须把它剔掉。 */
const plugin = join(root, '.runtime', 'win-x64', 'pepflashplayer64.dll')
if (PROFILE === 'internal' && !existsSync(plugin)) {
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
  // 隐藏宿主里跑时不要弹出控制台窗口。
  windowsHide: true,
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
if (PROFILE === 'public') {
  // BYOP：公开包不带任何 Adobe 二进制。electron-builder 会把内核 dist 目录整体复制过来，
  // 插件就是随内核目录进来的，所以在打完之后剔除并断言清零。
  for (const copy of pluginCopies) rmSync(copy, { force: true })
  const leftover = []
  const rescan = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) rescan(path)
      else if (entry.name === 'pepflashplayer64.dll') leftover.push(path)
    }
  }
  rescan(unpacked)
  if (leftover.length > 0) {
    console.error(`公开包仍包含 Flash 插件：\n${leftover.join('\n')}`)
    process.exit(1)
  }
  console.log('[pack] 公开包已剔除 Flash 插件（BYOP：由用户自行放到 <exe目录>\\flash\\）')
} else {
  if (pluginCopies.length !== 1) {
    console.error(`包内 Flash 插件应有且只有一份，实际 ${pluginCopies.length} 份：\n${pluginCopies.join('\n')}`)
    process.exit(1)
  }
  if (sha256(pluginCopies[0]) !== sha256(plugin)) {
    console.error('包内 Flash 插件与来源文件不一致。')
    process.exit(1)
  }
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
 * 代码签名状态（发布门禁）——**真校验**，不是「有没有证书表」。
 *
 * 旧实现只解析 PE 证书目录大小，把「有签名块」当成「签名有效」；审计用系统检查证明那不等价
 * （本轮公开包实际是 NotSigned）。现在走 scripts/authenticode.cjs：
 * signtool → PowerShell Get-AuthenticodeSignature → 都不可用时只报「无法验证」。
 */
const { verifyAuthenticode } = require('./authenticode.cjs')

function signatureStatus(exe) {
  const result = verifyAuthenticode(exe)
  return {
    signed: result.signed,
    verified: result.verified,
    status: result.verified ? 'Valid' : result.status,
    signer: result.signer,
    tool: result.tool
  }
}
const signature = signatureStatus(packaged)
const manifest = {
  product: 'BaoFlashBrowser Next',
  profile: PROFILE,
  smokeHiddenSupported: true,
  kernel: manifestSource.verified ? manifestSource.kernel : { ...manifestSource.kernel, tag: String(manifestSource.kernel?.tag ?? 'unknown') + '(unverified)' },
  runtimeInput: { dir: manifestSource.runtimeDir, verified: manifestSource.verified },
  generatedAt: new Date().toISOString(),
  executable: {
    name: 'BaoFlashBrowser Next.exe',
    bytes: packagedSize,
    runtimeBytes: runtimeSize,
    signature
  },
  components: {
    electron: '.runtime/win-x64/electron.exe',
    ruffle: Object.entries(manifestSource.files)
      .filter(([file]) => file.startsWith('vendor/ruffle/'))
      .map(([file, hash]) => ({ file: file.replace('vendor/ruffle/', ''), sha256: hash }))
  },
  flash: PROFILE === 'public'
    ? {
        bundled: false,
        mode: 'byop',
        hint: '把 pepflashplayer64.dll 放到 <exe目录>\\flash\\ 后重启；本产品不随包分发 Flash'
      }
    : { bundled: true, file: 'pepflashplayer64.dll', sha256: sha256(pluginCopies[0]) },
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
    ...(PROFILE === 'internal'
      ? ['内部包携带 Adobe Flash 插件：仅限内部验证，不得对外分发']
      : []),
    '独立复建与依赖校验未完成'
    // 只有**验证通过**（链 + 签名完整）才算关掉这一项；「有证书表」不够。
  ].filter((item) => !(item.startsWith('代码签名') && signature.verified === true))
}
writeFileSync(join(unpacked, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

console.log('Win x64 验证版：', packaged)
console.log(`profile=${PROFILE}；内核校验：运行时 ${runtimeSize} 字节 / 产物 ${packagedSize} 字节`)
if (PROFILE === 'public') {
  console.log('Flash：未随包（BYOP），用户放到 <exe目录>\\flash\\pepflashplayer64.dll')
} else {
  console.log(`Flash：1 份，SHA-256 ${sha256(pluginCopies[0]).slice(0, 16)}…（仅限内部验证）`)
}
console.log('许可：NOTICE.md + licenses/ 已随包')
console.log(`[pack] 签名状态：${signature.status}${signature.signed ? '' : '（发布门禁）'}`)
console.log(
  PROFILE === 'public'
    ? '[pack] 产物不含 Adobe 二进制（BYOP），许可证齐全；产物清单见 manifest.json。'
    : '[pack] 内部包携带 Adobe Flash 插件：仅限内部验证，不得对外分发；产物清单见 manifest.json。'
)
