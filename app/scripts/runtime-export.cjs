const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } = require('node:fs')
const { join, relative, resolve } = require('node:path')

/**
 * 导出自编译内核运行时，供其它机器搭建开发环境。
 *
 * 两种包（差异只在于是否带 Adobe 插件）：
 * - `--internal`（默认）：**含** `pepflashplayer64.dll`。开发环境跑 `npm run smoke` 需要它
 *   （`flash`、`plugin-input` 两条 PPAPI 用例），与 `pack:win` 的 internal profile 定位一致。
 *   **只能在私有仓库 / draft release / 受限云盘内部分发。**
 * - `--byop`：不含 Adobe 二进制，许可最干净；没有插件时那两条用例会跳过并说明原因。
 */
const root = resolve(__dirname, '..')
const mode = process.argv.includes('--byop') ? 'byop' : 'internal'
const runtime = join(root, '.runtime', 'win-x64')
const plugin = join(runtime, 'pepflashplayer64.dll')

if (!existsSync(join(runtime, 'electron.exe'))) {
  console.error('缺少 .runtime/win-x64/electron.exe：先按 docs/kickoff/dev-environment.md 准备运行时。')
  process.exit(1)
}
if (mode === 'internal' && !existsSync(plugin)) {
  console.error('internal 包需要 .runtime/win-x64/pepflashplayer64.dll（BYOP 插件请自行放到该目录）。')
  console.error('若只想要不含 Adobe 二进制的包，用 --byop。')
  process.exit(1)
}

const repoManifest = JSON.parse(readFileSync(join(root, 'scripts', 'runtime-manifest.json'), 'utf8'))
const kernelTag = repoManifest.kernel?.tag ?? 'unknown-kernel'

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex').toUpperCase()
}

const files = {}
const skipped = []
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(path)
      continue
    }
    const rel = relative(runtime, path).replaceAll('\\', '/')
    if (mode === 'byop' && entry.name === 'pepflashplayer64.dll') {
      skipped.push(rel)
      continue
    }
    files[rel] = sha256(path)
  }
}
walk(runtime)

const staging = mkdtempSync(join(root, '.runtime', 'export-'))
try {
  cpSync(runtime, staging, {
    recursive: true,
    filter(path) {
      if (mode !== 'byop') return true
      return !path.endsWith('pepflashplayer64.dll')
    }
  })
  const manifest = {
    product: 'BaoFlashBrowser Next · 开发运行时',
    profile: mode,
    internalOnly: mode === 'internal',
    kernel: repoManifest.kernel,
    exportedAt: new Date().toISOString(),
    exportedFrom: process.env.COMPUTERNAME ?? 'unknown',
    node: process.version,
    files,
    note: mode === 'internal'
      ? '含 Adobe Flash Player 二进制（BYOP 插件的内部副本）。仅限内部分发，不得公开上传。'
      : '不含 Adobe 二进制；把 pepflashplayer64.dll 放到 .runtime/win-x64/ 后 PPAPI 用例才会运行。'
  }
  require('node:fs').writeFileSync(join(staging, 'RUNTIME-MANIFEST.json'), JSON.stringify(manifest, null, 2), 'utf8')

  const dist = join(root, 'dist')
  mkdirSync(dist, { recursive: true })
  const zip = join(dist, `runtime-win-x64-${kernelTag}-${mode}.zip`)
  rmSync(zip, { force: true })

  // Windows 自带 Compress-Archive（项目只在 Windows 上构建）
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const result = spawnSync(powershell, [
    '-NoProfile', '-NonInteractive', '-Command',
    `Compress-Archive -Path '${join(staging, '*').replace(/'/g, "''")}' -DestinationPath '${zip.replace(/'/g, "''")}' -CompressionLevel Optimal`
  ], { stdio: 'inherit' })
  if (result.status !== 0) {
    console.error('压缩失败。')
    process.exit(1)
  }

  const sizeMb = (statSync(zip).size / 1024 / 1024).toFixed(0)
  console.log('')
  console.log(`已导出：${zip}`)
  console.log(`  包类型：${mode}${mode === 'internal' ? '（含 Adobe 插件，仅限内部分发）' : '（不含 Adobe 二进制）'}`)
  console.log(`  内核：${kernelTag}（${repoManifest.kernel?.commit ?? '未知 commit'}）`)
  console.log(`  文件：${Object.keys(files).length} 个，${sizeMb} MB${skipped.length ? `；排除 ${skipped.join(', ')}` : ''}`)
  console.log(`  ZIP SHA-256：${sha256(zip)}`)
  console.log('')
  console.log('发布与取用见 docs/kickoff/dev-environment.md §2；对方用：')
  console.log(`  npm run runtime:import -- <下载到的 zip>`)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
