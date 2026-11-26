const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } = require('node:fs')
const { join, relative, resolve } = require('node:path')

/**
 * 导入 `npm run runtime:export` 产出的运行时包。
 *
 * 两类校验必须**分开**（2026-11-26 审计）：
 *
 * 1. **关键件（provenance）**：内核 `electron.exe` 等仓库清单里声明的文件必须存在，且哈希
 *    等于 `scripts/runtime-manifest.json`。这是"来路对不对"的唯一判据——包内自报的哈希不能
 *    当依据（篡改者可以两边一起改）。
 * 2. **包完整性（integrity）**：包内**每个**文件都必须出现在包自己的 `RUNTIME-MANIFEST.json`
 *    里且哈希一致；只有"清单未声明的文件"才拒绝。
 *
 * 旧实现把「关键件清单」当成「完整文件白名单」，于是 `.pak`、语言包、配套 DLL 全被判成
 * 多余文件；BYOP 包还会因为按设计不含 Adobe 插件而被要求"补上插件"。结果两种归档都装不回来。
 */
const root = resolve(__dirname, '..')
const zip = process.argv[2]
if (!zip || !existsSync(zip)) {
  console.error('用法：npm run runtime:import -- <runtime-win-x64-*.zip>')
  process.exit(1)
}
const force = process.argv.includes('--force')
/** `--target=<dir>` 只给往返测试用：默认装进 `.runtime/win-x64`。 */
const targetOption = process.argv.find((arg) => arg.startsWith('--target='))
const target = targetOption ? resolve(targetOption.slice('--target='.length)) : join(root, '.runtime', 'win-x64')
const RUNTIME_PREFIX = '.runtime/win-x64/'
if (existsSync(target) && !force) {
  console.error(`目标已存在：${target}`)
  console.error('如需替换，先把旧目录移走（Move-Item .runtime\\win-x64 .runtime\\win-x64-previous），或加 --force。')
  process.exit(1)
}

const MANIFEST_NAME = 'RUNTIME-MANIFEST.json'
const KERNEL_KEY = '.runtime/win-x64/electron.exe'
const PLUGIN_KEY = '.runtime/win-x64/pepflashplayer64.dll'

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex').toUpperCase()
}

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(path, out)
    else out.push(path)
  }
  return out
}

/** 校验并安装；返回 `undefined` 表示成功，否则返回失败原因（用于打印）。 */
function install() {
  // 首次导入时 .runtime 还不存在：先建父目录，否则 mkdtemp 直接 ENOENT（审计复现项）。
  mkdirSync(join(root, '.runtime'), { recursive: true })
  const staging = mkdtempSync(join(root, '.runtime', 'import-'))
  try {
    // 直接用 .NET 解压：Windows PowerShell 5.1 的 Expand-Archive 在部分环境会报
    // "Cannot find an overload for ExtractToDirectory and the argument count 3"。
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const script = [
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      `[System.IO.Compression.ZipFile]::ExtractToDirectory('${resolve(zip).replace(/'/g, "''")}', '${staging.replace(/'/g, "''")}')`
    ].join('; ')
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'inherit', windowsHide: true })
    if (result.status !== 0) return '解压失败。'

    const manifestPath = join(staging, MANIFEST_NAME)
    if (!existsSync(manifestPath)) {
      return '包内缺少 RUNTIME-MANIFEST.json：这不是 npm run runtime:export 产出的包。'
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const repoManifest = JSON.parse(readFileSync(join(root, 'scripts', 'runtime-manifest.json'), 'utf8'))
    const declared = manifest.files && typeof manifest.files === 'object' ? manifest.files : {}
    const profile = manifest.profile === 'byop' ? 'byop' : 'internal'
    const problems = []

    // ── 1. 关键件：内核必须与仓库清单一致 ───────────────────────────────
    const expectedKernel = repoManifest.files?.[KERNEL_KEY]
    const actualKernel = declared['electron.exe']
    if (!expectedKernel) problems.push('仓库清单没有声明内核哈希，无法校验来路')
    if (!actualKernel) problems.push('包内清单没有 electron.exe')
    else if (expectedKernel && actualKernel !== expectedKernel) {
      problems.push(
        `包内内核不是本仓库期望的内核\n  包内 ${manifest.kernel?.tag ?? '未知 tag'} / ${actualKernel}\n  期望 ${repoManifest.kernel?.tag ?? '未知 tag'} / ${expectedKernel}`
      )
    }
    if (declared['electron.exe'] && existsSync(join(staging, 'electron.exe'))) {
      const actual = sha256(join(staging, 'electron.exe'))
      if (actual !== declared['electron.exe']) problems.push('electron.exe 的实际哈希与包内清单不符')
    }

    // ── 2. 关键件：**只校验归档里该有的那些**（BYOP 按设计不含 Adobe 插件）────────
    // 仓库清单里的 `vendor/ruffle/*` 是应用侧资源，不在运行时归档里——把它们当成归档
    // 必备文件是旧实现装不回来的另一个原因（2026-11-26 审计）。
    for (const rel of Object.keys(repoManifest.files ?? {})) {
      if (!rel.startsWith(RUNTIME_PREFIX)) continue
      if (rel === KERNEL_KEY) continue
      if (profile === 'byop' && rel === PLUGIN_KEY) continue
      const name = rel.slice(RUNTIME_PREFIX.length)
      if (!existsSync(join(staging, name))) problems.push(`包内缺少仓库清单要求的关键件：${name}`)
    }

    // ── 3. 完整性：包内每个文件都必须被包内清单声明且哈希一致 ──────────────
    const actualFiles = walkFiles(staging)
      .map((path) => relative(staging, path).replaceAll('\\', '/'))
      .filter((rel) => rel !== MANIFEST_NAME)
    const actualSet = new Set(actualFiles)
    for (const rel of actualFiles) {
      if (!Object.hasOwn(declared, rel)) {
        problems.push(`包内存在清单未声明的文件：${rel}`)
        continue
      }
      const actual = sha256(join(staging, rel))
      if (actual !== declared[rel]) problems.push(`文件哈希与包内清单不符：${rel}`)
    }
    for (const rel of Object.keys(declared)) {
      if (!actualSet.has(rel)) problems.push(`包内清单声明了不存在的文件：${rel}`)
    }

    if (problems.length > 0) {
      console.error('校验失败，未安装：')
      for (const line of problems) console.error(`  ✘ ${line}`)
      return 'failed'
    }

    // 先整体换成新目录再清理旧的：逐个文件移动在中途失败会留下半个运行时。
    const previous = existsSync(target) ? join(root, '.runtime', `win-x64-previous-${Date.now()}`) : undefined
    if (previous) renameSync(target, previous)
    try {
      renameSync(staging, target)
    } catch (error) {
      if (previous) renameSync(previous, target)
      throw error
    }
    if (previous) {
      try {
        rmSync(previous, { recursive: true, force: true })
      } catch {
        console.warn(`旧运行时未能删除，保留在 ${relative(root, previous)}`)
      }
    }

    console.log('')
    console.log(`已安装运行时到 ${relative(root, target)}`)
    console.log(`  内核：${manifest.kernel?.tag ?? '未知'}（${manifest.kernel?.commit ?? '未知 commit'}）`)
    console.log(`  包类型：${profile}${manifest.internalOnly ? '（仅限内部）' : ''}`)
    console.log(`  文件：${actualFiles.length} 个；导出时间 ${manifest.exportedAt ?? '未知'}（来自 ${manifest.exportedFrom ?? '未知机器'}）`)
    if (actualSet.has('pepflashplayer64.dll')) {
      console.log('  含 PPAPI 插件：原生引擎可用，npm run smoke 应 21/21')
    } else {
      console.log('  不含 PPAPI 插件：flash / plugin-input 两条用例会跳过；需要时把 pepflashplayer64.dll 放到该目录')
    }
    if (previous) console.log(`  旧运行时已移到 ${relative(root, previous)}`)
    console.log('')
    console.log('下一步：npm run runtime:check && npm run smoke')
    return undefined
  } finally {
    // 失败路径同样要清理：`process.exit()` 不会执行 finally，所以这里只 return。
    rmSync(staging, { recursive: true, force: true })
  }
}

const failure = install()
process.exit(failure === undefined ? 0 : 1)
