const { createHash } = require('node:crypto')
const { existsSync, readFileSync, statSync } = require('node:fs')
const { join, resolve } = require('node:path')

/**
 * 本地开发环境的自检（换机器 / 重装 / 拉新分支后先跑这个）。
 *
 * 我们用的是**自编译内核**，它不在仓库里（`.runtime/` 被忽略），所以新机器上最常见的失败
 * 不是代码问题，而是「运行时缺失或来路不对」。这个脚本把结论说清楚并给出下一步命令。
 */
const root = resolve(__dirname, '..')
const manifest = JSON.parse(readFileSync(join(root, 'scripts', 'runtime-manifest.json'), 'utf8'))

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex').toUpperCase()
}

const problems = []
const warnings = []
const lines = []

const plugin = join(root, '.runtime', 'win-x64', 'pepflashplayer64.dll')
const runtime = join(root, '.runtime', 'win-x64', 'electron.exe')

if (!existsSync(runtime)) {
  problems.push('.runtime/win-x64/electron.exe 不存在')
} else {
  const actual = sha256(runtime)
  const expected = manifest.files['.runtime/win-x64/electron.exe']
  if (actual !== expected) {
    problems.push(`运行时内核 SHA-256 与清单不符\n  期望 ${expected}\n  实际 ${actual}`)
  } else {
    lines.push(`内核 electron.exe 匹配（${manifest.kernel?.tag ?? '未知 tag'}，${(statSync(runtime).size / 1024 / 1024).toFixed(0)} MB）`)
  }
}

for (const [file, expected] of Object.entries(manifest.files)) {
  if (file.startsWith('.runtime/')) continue
  const path = join(root, file)
  if (!existsSync(path)) {
    problems.push(`缺少随仓库文件：${file}`)
    continue
  }
  const actual = sha256(path)
  if (actual !== expected) problems.push(`SHA-256 不符：${file}`)
}

if (!existsSync(plugin)) {
  warnings.push('未检测到 pepflashplayer64.dll：原生引擎将停用（BYOP，开发时可自行放置到 .runtime/win-x64/）')
} else {
  const expected = manifest.files['.runtime/win-x64/pepflashplayer64.dll']
  const actual = sha256(plugin)
  if (expected && actual !== expected) {
    warnings.push(`插件 SHA-256 与清单不同（可能是自行准备的其他版本）\n  期望 ${expected}\n  实际 ${actual}`)
  } else {
    lines.push('PPAPI 插件匹配（原生引擎可用）')
  }
}

for (const line of lines) console.log(`  ✔ ${line}`)
for (const line of warnings) console.warn(`  ! ${line}`)
for (const line of problems) console.error(`  ✘ ${line}`)

if (problems.length > 0) {
  console.error(`
本地运行时不可用。两种恢复方式：

A. 从已有环境的机器复制（推荐，几分钟）
   在旧机器：  Compress-Archive -Path app\\.runtime\\win-x64 -DestinationPath runtime-win-x64.zip
   在新机器：  Expand-Archive runtime-win-x64.zip -DestinationPath app\\.runtime
   然后：      npm run runtime:check

B. 自己重建内核（数小时，需要 VS BuildTools + depot_tools + 约 100GB 磁盘）
   见 docs/kernel/README.md「重建与验证」；
   组装 dist：pwsh -NoProfile -File scripts\\assemble-kernel-dist.ps1 -Out <cr\\src\\out\\Rel> -Dist <dist>
   刷新运行时：npm run runtime:prepare -- <dist>

细节见 docs/kickoff/dev-environment.md。
`)
  process.exit(1)
}

console.log('\n本地运行时可用。下一步：npm run smoke（应用冒烟 21 项）')
