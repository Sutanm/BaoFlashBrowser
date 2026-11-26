const { spawnSync } = require('node:child_process')
const { existsSync, readFileSync, rmSync } = require('node:fs')
const { join, resolve } = require('node:path')

/**
 * 运行时归档**双 profile 往返**门禁（2026-11-26 审计）。
 *
 * 背景：导出与导入曾经各自"成功"，但把导出物原样交给导入脚本会返回 1——导入把「关键件清单」
 * 当成「完整文件白名单」，`.pak`、语言包、配套 DLL 全被判成多余文件，BYOP 包还因为按设计不含
 * Adobe 插件而被要求"补上插件"。**两种归档都装不回来**，只有真正跑一遍往返才能发现。
 *
 * 做法：对 internal / byop 各跑一次
 *   export → import（装到 `.runtime/roundtrip-<profile>`）→ 断言关键件与 profile 一致 → 清理
 * 不碰开发者正在用的 `.runtime/win-x64`。
 *
 * 退出码：0 = 通过或显式跳过（没有自编译运行时）；1 = 往返失败。
 */
const root = resolve(__dirname, '..')
const runtime = join(root, '.runtime', 'win-x64')
if (!existsSync(join(runtime, 'electron.exe'))) {
  console.log('[roundtrip] 跳过：没有 .runtime/win-x64（先 npm run runtime:prepare -- <dist>）。')
  process.exit(0)
}

const repoManifest = JSON.parse(readFileSync(join(root, 'scripts', 'runtime-manifest.json'), 'utf8'))
const kernelTag = repoManifest.kernel?.tag ?? 'unknown-kernel'
const profiles = process.argv.includes('--internal-only') ? ['internal'] : ['internal', 'byop']

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true })
  if (result.status !== 0) {
    console.error(`[roundtrip] 失败：node ${args.join(' ')}（退出码 ${result.status}）`)
    process.exit(1)
  }
}

for (const profile of profiles) {
  const zip = join(root, 'dist', `runtime-win-x64-${kernelTag}-${profile}.zip`)
  const target = join(root, '.runtime', `roundtrip-${profile}`)
  console.log(`\n[roundtrip] ${profile}：export → import → 校验 → 清理`)
  try {
    rmSync(target, { recursive: true, force: true })
    run(['scripts/runtime-export.cjs', ...(profile === 'byop' ? ['--byop'] : [])])
    if (!existsSync(zip)) throw new Error(`导出没有产出 ${zip}`)
    run(['scripts/runtime-import.cjs', zip, `--target=${target}`])

    if (!existsSync(join(target, 'electron.exe'))) throw new Error('导入后缺少 electron.exe')
    const hasPlugin = existsSync(join(target, 'pepflashplayer64.dll'))
    if (profile === 'internal' && !hasPlugin) throw new Error('internal 包导入后缺少 pepflashplayer64.dll')
    if (profile === 'byop' && hasPlugin) throw new Error('byop 包不应包含 pepflashplayer64.dll')
    // 关键件必须真的在：这是"能跑起来"的最小集合。
    for (const rel of Object.keys(repoManifest.files ?? {})) {
      if (!rel.startsWith('.runtime/win-x64/')) continue
      if (profile === 'byop' && rel.endsWith('pepflashplayer64.dll')) continue
      const name = rel.slice('.runtime/win-x64/'.length)
      if (!existsSync(join(target, name))) throw new Error(`导入后缺少关键件：${name}`)
    }
    console.log(`[roundtrip] ${profile}：通过`)
  } finally {
    rmSync(target, { recursive: true, force: true })
    rmSync(zip, { force: true })
  }
}

console.log('\n[roundtrip] 双 profile 往返通过。')
