const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } = require('node:fs')
const { join, relative, resolve } = require('node:path')

/**
 * 导入 `npm run runtime:export` 产出的运行时包。
 *
 * 关键点：**先校验再落盘**。包内 `RUNTIME-MANIFEST.json` 记录了逐文件 SHA-256 与内核 tag，
 * 只有全部匹配仓库 `scripts/runtime-manifest.json` 期望的内核时才会安装——避免"来路不对但
 * 静默能用"（我们踩过：未设置 ELECTRON_EXEC_PATH 时打包静默换成官方 Electron）。
 */
const root = resolve(__dirname, '..')
const zip = process.argv[2]
if (!zip || !existsSync(zip)) {
  console.error('用法：npm run runtime:import -- <runtime-win-x64-*.zip>')
  process.exit(1)
}
const force = process.argv.includes('--force')

const target = join(root, '.runtime', 'win-x64')
if (existsSync(target) && !force) {
  console.error(`目标已存在：${target}`)
  console.error('如需替换，先把旧目录移走（Move-Item .runtime\\win-x64 .runtime\\win-x64-previous），或加 --force。')
  process.exit(1)
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex').toUpperCase()
}

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
  if (result.status !== 0) {
    console.error('解压失败。')
    process.exit(1)
  }

  const manifestPath = join(staging, 'RUNTIME-MANIFEST.json')
  if (!existsSync(manifestPath)) {
    console.error('包内缺少 RUNTIME-MANIFEST.json：这不是 npm run runtime:export 产出的包。')
    process.exit(1)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const repoManifest = JSON.parse(readFileSync(join(root, 'scripts', 'runtime-manifest.json'), 'utf8'))
  const expectedKernel = repoManifest.files['.runtime/win-x64/electron.exe']
  const actualKernel = manifest.files?.['electron.exe']

  // 校验依据以**仓库清单**为准，而不是包内自报的哈希：
  // 旧实现只比对「包内清单说的哈希」和「包内文件」，篡改者可以两边一起改。
  const expectedFiles = Object.entries(repoManifest.files ?? {}).map(([key, hash]) => [
    key.replace(/^\.runtime\/win-x64\//, ''), hash
  ])
  const problems = []
  if (!actualKernel) problems.push('包内清单没有 electron.exe')
  else if (actualKernel !== expectedKernel) {
    problems.push(
      `包内内核不是本仓库期望的内核\n  包内 ${manifest.kernel?.tag ?? '未知 tag'} / ${actualKernel}\n  期望 ${repoManifest.kernel?.tag ?? '未知 tag'} / ${expectedKernel}`
    )
  }
  for (const [rel, hash] of expectedFiles) {
    const file = join(staging, rel)
    if (!existsSync(file)) {
      problems.push(`包内缺少仓库清单要求的文件：${rel}`)
      continue
    }
    const actual = sha256(file)
    if (actual !== hash) problems.push(`文件哈希与仓库清单不符：${rel}（${actual}）`)
    // 包内清单若声明了同一文件，两处必须一致（防止自报与实测打架）。
    const claimed = manifest.files?.[rel]
    if (claimed && claimed !== actual) problems.push(`包内清单与实际文件不符：${rel}`)
  }
  // 包里多出来的文件照装会绕过校验，这里至少明确报出来。
  const declared = new Set(expectedFiles.map(([rel]) => rel))
  for (const rel of Object.keys(manifest.files ?? {})) {
    if (rel !== 'RUNTIME-MANIFEST.json' && !declared.has(rel)) problems.push(`包内存在仓库清单未列出的文件：${rel}`)
  }

  if (problems.length > 0) {
    console.error('校验失败，未安装：')
    for (const line of problems) console.error(`  ✘ ${line}`)
    process.exit(1)
  }

  // 先整体换成新目录再清理旧的：逐个文件移动在中途失败会留下半个运行时。
  mkdirSync(join(root, '.runtime'), { recursive: true })
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

  const fileCount = Object.keys(manifest.files ?? {}).length
  console.log('')
  console.log(`已安装运行时到 ${relative(root, target)}`)
  console.log(`  内核：${manifest.kernel?.tag ?? '未知'}（${manifest.kernel?.commit ?? '未知 commit'}）`)
  console.log(`  包类型：${manifest.profile ?? 'internal'}${manifest.internalOnly ? '（仅限内部）' : ''}`)
  console.log(`  文件：${fileCount} 个；导出时间 ${manifest.exportedAt ?? '未知'}（来自 ${manifest.exportedFrom ?? '未知机器'}）`)
  if (manifest.files?.['pepflashplayer64.dll']) {
    console.log('  含 PPAPI 插件：原生引擎可用，npm run smoke 应 21/21')
  } else {
    console.log('  不含 PPAPI 插件：flash / plugin-input 两条用例会跳过；需要时把 pepflashplayer64.dll 放到该目录')
  }
  if (previous) console.log(`  旧运行时已移到 ${relative(root, previous)}`)
  console.log('')
  console.log('下一步：npm run runtime:check && npm run smoke')
} finally {
  rmSync(staging, { recursive: true, force: true })
}
