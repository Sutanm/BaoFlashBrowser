const { buildIfChanged, runNode, runPool } = require('./build.cjs')
const { existsSync, readFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { dirname, resolve } = require('node:path')
const { selectTests } = require('./test-map.cjs')

const ROOT = resolve(__dirname, '..')
const [suite, ...flags] = process.argv.slice(2)
const suites = {
  smoke: ['startup', 'tabs', 'tab-ops', 'engine', 'engine-switch', 'input', 'plugin-input', 'ruffle-input',
    'ruffle-cors', 'engine-broker', 'popup', 'permissions', 'theme', 'titlebar',
    'internal-page', 'newtab', 'favicon', 'quick-settings', 'bookmarks', 'bookmark-bar',
    'settings-search-engine',
    'overlay-prewarm-hidden', 'overlay-prewarm-policy',
    'tab-discard', 'tab-duplicate-ruffle', 'session-restore', 'data-cleanup',
    'link-target', 'flash', 'isolation', 'engine-rules', 'tearoff', 'shell-crash-heal', 'heartbeat'].map((name) => `tests/smoke/${name}.test.cjs`),
  data: ['tests/data/settings-store.test.cjs', 'tests/data/session-store.test.cjs'],
  packaged: ['tests/smoke/packaged.test.cjs']
}
const known = new Set(['--foreground', '--serial', '--public', '--changed'])
const jobsFlag = flags.find((flag) => flag.startsWith('--jobs='))
const onlyFlag = flags.find((flag) => flag.startsWith('--only='))
const changedFlag = flags.find((flag) => flag === '--changed' || flag.startsWith('--changed='))
const isUnit = suite === 'unit'
if ((!isUnit && !Object.hasOwn(suites, suite)) ||
    flags.some((flag) => !known.has(flag) && !flag.startsWith('--jobs=') && !flag.startsWith('--only=') && !flag.startsWith('--changed='))) {
  throw new Error('用法：node scripts/test.cjs <unit|smoke|data|packaged> [--foreground] [--jobs=N] [--serial] [--public]\n' +
    '       [--only=name[,name...]] [--changed[=<git-ref>]]')
}
if (onlyFlag && changedFlag) throw new Error('--only 与 --changed 只能给一个。')
if ((onlyFlag || changedFlag) && suite !== 'smoke') throw new Error('--only / --changed 只用于 smoke 套件（单元层/data 层本身就很便宜）。')

/** 每个用例文件的历史耗时（`.cache/test-durations.json`，由 runPool 维护）。 */
function durations() {
  try {
    return JSON.parse(readFileSync(resolve(ROOT, '.cache/test-durations.json'), 'utf8'))
  } catch {
    return {}
  }
}

/**
 * 用历史耗时估一下这批要跑多久，比让人干等强。
 *
 * 按并发折算：总量 / 并发数，但不低于最慢的那个文件（它就是尾部长板）。
 */
function estimate(files, jobs = 4) {
  const cache = durations()
  let total = 0
  let longest = 0
  let missing = 0
  for (const file of files) {
    const seconds = Number(cache[file])
    if (Number.isFinite(seconds) && seconds > 0) {
      total += seconds
      longest = Math.max(longest, seconds)
    } else {
      missing += 1
      total += 12 // 没有历史记录的按 12 s 估（一条用例一次应用冷启动的量级）
      longest = Math.max(longest, 12)
    }
  }
  const guessed = Math.max(total / Math.max(1, Math.min(jobs, files.length)), longest)
  return guessed < 60 ? `约 ${Math.round(guessed)} s` : `约 ${Math.round(guessed / 60)} min`
}

/** 实际并发数（与下面的调度保持一致），给耗时估算用。 */
function plannedJobs(fileCount) {
  const requested = flags.includes('--serial')
    ? 1
    : jobsFlag
      ? Number(jobsFlag.split('=')[1])
      : Math.min(4, fileCount)
  return Math.max(1, Math.min(Number.isFinite(requested) ? requested : 4, fileCount))
}

/** `git` 改动路径（相对 app/）。`ref` 为空时用 HEAD。 */
function changedPaths(ref) {
  const run = (args) => {
    const result = spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', windowsHide: true })
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} 失败：${(result.stderr ?? '').trim() || '未知错误'}`)
    }
    return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  }
  const tracked = run(['diff', '--name-only', ref])
  const untracked = run(['ls-files', '--others', '--exclude-standard'])
  // 两种命令的路径基准不同：`git -C app diff` 相对**仓库根**（`app/src/...`），
  // `git -C app ls-files` 相对**当前目录**（`src/...`）。下面统一裁一次 `app/`，
  // 仓库根上的其它改动（`docs/…`）保持原样，由映射表的 IGNORED 处理。
  return [...new Set([...tracked, ...untracked])]
    .map((path) => path.replace(/\\/g, '/'))
    .map((path) => (path.startsWith('app/') ? path.slice('app/'.length) : path))
    .filter((path) => !path.startsWith('..'))
}

/** 把用例名解析成文件，顺带校验名字写错（拼错要当场报，不能静默少跑）。 */
function filesOfNames(names) {
  return names.map((name) => {
    const cleaned = name.trim().replace(/^tests\/smoke\//, '').replace(/\.test\.cjs$/, '')
    const file = `tests/smoke/${cleaned}.test.cjs`
    if (!existsSync(resolve(ROOT, file))) throw new Error(`未知用例：${name}（没有 ${file}）`)
    return file
  })
}

let selectedFiles = suites[suite]
if (suite === 'smoke' && onlyFlag) {
  const names = onlyFlag.slice('--only='.length).split(',').map((name) => name.trim()).filter(Boolean)
  if (names.length === 0) throw new Error('--only= 后面要给用例名，逗号分隔。')
  selectedFiles = filesOfNames(names)
  console.log(`[only] ${selectedFiles.length} 个用例文件，${estimate(selectedFiles, plannedJobs(selectedFiles.length))}`)
}
if (suite === 'smoke' && changedFlag) {
  const ref = changedFlag.includes('=') ? changedFlag.slice('--changed='.length) : 'HEAD'
  const changed = changedPaths(ref || 'HEAD')
  const { tests, reason } = selectTests(changed)
  if (tests === null) {
    selectedFiles = suites.smoke
    console.log(`[changed] ${changed.length} 个改动 → 全量（${reason}），${estimate(selectedFiles, plannedJobs(selectedFiles.length))}`)
  } else if (tests.length === 0) {
    console.log(`[changed] ${changed.length} 个改动 → 无需跑冒烟（${reason}）。`)
    process.exit(0)
  } else {
    selectedFiles = filesOfNames(tests)
    console.log(`[changed] ${changed.length} 个改动 → ${selectedFiles.length} 个用例文件（${reason}），${estimate(selectedFiles, plannedJobs(selectedFiles.length))}`)
    console.log(`          ${selectedFiles.map((file) => file.replace('tests/smoke/', '').replace('.test.cjs', '')).join(', ')}`)
  }
}

// 单元层：纯逻辑，不启动 Electron、不需要构建产物，毫秒级跑完。
if (isUnit) {
  const vitest = resolve(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
  runNode([vitest, 'run'], { env: process.env })
  process.exit(0)
}

const env = { ...process.env }
const foreground = flags.includes('--foreground')
delete env.BAO_SMOKE_BACKGROUND
if (foreground) delete env.BAO_SMOKE_HIDDEN
// 成品门禁：显式声明应为哪种 profile；产物与声明不符时必须失败（审计 P1）。
if (flags.includes('--public')) env.BAO_EXPECT_PROFILE = 'public'
else if (suite === 'packaged') env.BAO_EXPECT_PROFILE = 'internal'
// 注意：默认隐藏只对"非前台"生效。之前这里写成上面 if/else 链的 else，
// 会把 --foreground 删掉的 BAO_SMOKE_HIDDEN 又设回来，导致前台用例永远被跳过
// （2026-11-25 修复；见 docs/reports/2026-11-25-foreground-smoke.md）。
if (!foreground) env.BAO_SMOKE_HIDDEN = '1'

if (suite !== 'packaged') buildIfChanged()

const files = selectedFiles
const requested = flags.includes('--serial')
  ? 1
  : jobsFlag
    ? Number(jobsFlag.split('=')[1])
    : Math.min(4, files.length)
const jobs = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 4, files.length))

// 单个隐藏的 Node 进程串行跑用例。默认的文件隔离会另起 Node 子进程，
// Node 的测试运行器没有为那些子进程设置 windowsHide。
const args = ['--require', './scripts/windows-test-spawn.cjs', '--test',
  '--experimental-test-isolation=none', '--test-concurrency=1']

if (jobs === 1) {
  runNode([...args, ...files], { env })
  process.exit(0)
}

runPool(files, args, env, jobs).then((failed) => {
  process.exit(failed === 0 ? 0 : 1)
})


