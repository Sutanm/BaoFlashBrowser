const { build, runNode } = require('./build.cjs')

const [suite, ...flags] = process.argv.slice(2)
const suites = {
  smoke: ['startup', 'tabs', 'tab-ops', 'engine', 'input', 'plugin-input', 'ruffle-input',
    'ruffle-cors', 'engine-broker', 'popup', 'permissions', 'theme', 'titlebar',
    'internal-page', 'quick-settings', 'flash', 'isolation', 'tearoff'].map((name) => `tests/smoke/${name}.test.cjs`),
  data: ['tests/data/settings-store.test.cjs'],
  packaged: ['tests/smoke/packaged.test.cjs']
}
if (!Object.hasOwn(suites, suite) || flags.some((flag) => flag !== '--foreground')) {
  throw new Error('用法：node scripts/test.cjs <smoke|data|packaged> [--foreground]')
}

const env = { ...process.env }
delete env.BAO_SMOKE_BACKGROUND
if (flags.includes('--foreground')) delete env.BAO_SMOKE_HIDDEN
else env.BAO_SMOKE_HIDDEN = '1'

if (suite !== 'packaged') build()
// 单个隐藏的 Node 进程串行跑用例。默认的文件隔离会另起 Node 子进程，
// Node 的测试运行器没有为那些子进程设置 windowsHide。
runNode(['--require', './scripts/windows-test-spawn.cjs', '--test',
  '--experimental-test-isolation=none', '--test-concurrency=1', ...suites[suite]], { env })
