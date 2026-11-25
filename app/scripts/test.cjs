const { buildIfChanged, runNode, runPool } = require('./build.cjs')
const { dirname, resolve } = require('node:path')

const [suite, ...flags] = process.argv.slice(2)
const suites = {
  smoke: ['startup', 'tabs', 'tab-ops', 'engine', 'input', 'plugin-input', 'ruffle-input',
    'ruffle-cors', 'engine-broker', 'popup', 'permissions', 'theme', 'titlebar',
    'internal-page', 'newtab', 'quick-settings', 'overlay-prewarm-hidden', 'tab-discard', 'tab-duplicate-ruffle', 'session-restore', 'data-cleanup',
    'link-target', 'flash', 'isolation', 'engine-rules', 'tearoff'].map((name) => `tests/smoke/${name}.test.cjs`),
  data: ['tests/data/settings-store.test.cjs', 'tests/data/session-store.test.cjs'],
  packaged: ['tests/smoke/packaged.test.cjs']
}
const known = new Set(['--foreground', '--serial', '--public'])
const jobsFlag = flags.find((flag) => flag.startsWith('--jobs='))
const isUnit = suite === 'unit'
if ((!isUnit && !Object.hasOwn(suites, suite)) || flags.some((flag) => !known.has(flag) && !flag.startsWith('--jobs='))) {
  throw new Error('用法：node scripts/test.cjs <unit|smoke|data|packaged> [--foreground] [--jobs=N] [--serial] [--public]')
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

const files = suites[suite]
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


