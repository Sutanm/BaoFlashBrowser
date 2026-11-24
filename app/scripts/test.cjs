const { buildIfChanged, runNode, runPool } = require('./build.cjs')

const [suite, ...flags] = process.argv.slice(2)
const suites = {
  smoke: ['startup', 'tabs', 'tab-ops', 'engine', 'input', 'plugin-input', 'ruffle-input',
    'ruffle-cors', 'engine-broker', 'popup', 'permissions', 'theme', 'titlebar',
    'internal-page', 'quick-settings', 'flash', 'isolation', 'engine-rules', 'tearoff'].map((name) => `tests/smoke/${name}.test.cjs`),
  data: ['tests/data/settings-store.test.cjs'],
  packaged: ['tests/smoke/packaged.test.cjs']
}
const known = new Set(['--foreground', '--serial'])
const jobsFlag = flags.find((flag) => flag.startsWith('--jobs='))
if (!Object.hasOwn(suites, suite) || flags.some((flag) => !known.has(flag) && !flag.startsWith('--jobs='))) {
  throw new Error('用法：node scripts/test.cjs <smoke|data|packaged> [--foreground] [--jobs=N] [--serial]')
}

const env = { ...process.env }
delete env.BAO_SMOKE_BACKGROUND
if (flags.includes('--foreground')) delete env.BAO_SMOKE_HIDDEN
else env.BAO_SMOKE_HIDDEN = '1'

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
