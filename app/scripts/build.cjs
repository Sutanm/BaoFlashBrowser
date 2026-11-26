const { spawnSync, spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } = require('node:fs')
const { basename, dirname, join, resolve } = require('node:path')
const { tmpdir } = require('node:os')

const ROOT = resolve(__dirname, '..')

function runNode(args, options = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true,
    ...options
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function electronViteBin() {
  return resolve(dirname(require.resolve('electron-vite/package.json')), 'bin/electron-vite.js')
}

const STAMP_FILE = () => join(ROOT, '.cache', 'build.stamp')

/**
 * 记下「当前源码 = 刚构建出来的产物」，让下一次 `test.cjs` 能跳过构建。
 *
 * 为什么手工 `npm run build` 也必须写：指纹是**源码内容**的哈希。手工构建后若不写戳，
 * 戳会停在更早那份源码上；此时 `git stash`/`pop`、或任何把源码改回"戳对应版本"的操作，
 * 都会让 `buildIfChanged()` 认为产物是新的，于是**跑到手工构建的那份旧产物上**。
 * 2026-11-26 已因此连续误判两次（新用例失败、实为旧 out/）。
 */
function writeStamp(typecheck = process.env.BAO_SKIP_TYPECHECK !== '1') {
  mkdirSync(dirname(STAMP_FILE()), { recursive: true })
  writeFileSync(STAMP_FILE(), `${fingerprint()}:${typecheck}`)
}

function build() {
  runNode([resolve(dirname(require.resolve('vue-tsc/package.json')), 'bin/vue-tsc.js'), '--noEmit'])
  runNode(['--require', resolve(__dirname, 'windows-build-spawn.cjs'), electronViteBin(), 'build'])
  writeStamp(true)
}

/**
 * 输入指纹：源码、脚本、配置、测试与 index.html 的内容哈希。
 *
 * 只用来判断「能不能跳过构建」，所以宁可多算几个文件，也不要漏算导致跑旧产物。
 */
function fingerprint() {
  const hash = createHash('sha256')
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name === '.runtime' || entry.name === 'out' || entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!/\.(ts|tsx|vue|css|html|json|cjs|mjs)$/.test(entry.name)) continue
      hash.update(entry.name)
      hash.update(readFileSync(path))
    }
  }
  for (const dir of ['src', 'scripts', 'tests']) {
    if (existsSync(join(ROOT, dir))) walk(join(ROOT, dir))
  }
  // 锁文件与配置也必须进指纹：依赖版本变了却复用旧产物，会出现「类型能过、运行时缺 API」的假象。
  for (const file of ['package.json', 'package-lock.json', 'electron.vite.config.ts', 'tsconfig.json']) {
    if (existsSync(join(ROOT, file))) hash.update(readFileSync(join(ROOT, file)))
  }
  return hash.digest('hex')
}

/**
 * 只有输入变了才重新构建（typecheck + electron-vite build 一次要 5–7 秒，
 * 连续跑冒烟时纯属重复劳动）。`BAO_FORCE_BUILD=1` 可强制重建，
 * `BAO_SKIP_TYPECHECK=1` 只构建不跑 vue-tsc。
 */
function buildIfChanged() {
  const stampFile = STAMP_FILE()
  const stampText = existsSync(stampFile) ? readFileSync(stampFile, 'utf8').trim() : ''
  const [stampHash, stampTypecheck] = stampText.split(':')
  const hash = fingerprint()
  const typecheck = process.env.BAO_SKIP_TYPECHECK !== '1'
  // 每个内部页都要在：只查其中几个的话，新增一个页面（收藏夹管理页就是第一例）时
  // 可能出现"产物目录缺文件、构建却判定为最新"，于是那个页面永远 404。
  const outExists = [
    ['out', 'main', 'index.js'],
    ['out', 'preload', 'index.js'],
    ['out', 'renderer', 'index.html'],
    ['out', 'renderer', 'settings.html'],
    ['out', 'renderer', 'newtab.html'],
    ['out', 'renderer', 'favorites.html']
  ].every((parts) => existsSync(join(ROOT, ...parts)))
  const fresh = process.env.BAO_FORCE_BUILD !== '1' && outExists && stampHash === hash && stampTypecheck === String(typecheck)
  if (fresh) {
    console.log('构建产物是最新的，跳过 typecheck + build（BAO_FORCE_BUILD=1 可强制重建）')
    return
  }
  if (typecheck) {
    runNode([resolve(dirname(require.resolve('vue-tsc/package.json')), 'bin/vue-tsc.js'), '--noEmit'])
  }
  runNode(['--require', resolve(__dirname, 'windows-build-spawn.cjs'), electronViteBin(), 'build'])
  writeStamp(typecheck)
}

const DURATIONS_FILE = () => join(ROOT, '.cache', 'test-durations.json')

function readDurations() {
  try {
    return JSON.parse(readFileSync(DURATIONS_FILE(), 'utf8'))
  } catch {
    return {}
  }
}

function writeDurations(durations) {
  mkdirSync(dirname(DURATIONS_FILE()), { recursive: true })
  writeFileSync(DURATIONS_FILE(), JSON.stringify(durations, null, 2))
}

/**
 * 按文件并行：每个文件一个 node 进程，动态队列（谁先跑完谁领下一个），
 * 长文件优先（用上次的耗时排序），输出落盘后只打印失败文件与结果摘要，避免 TAP 交错。
 */
function runPool(files, args, env, jobs) {
  const durations = readDurations()
  const pending = [...files].sort((a, b) => (durations[b] ?? 0) - (durations[a] ?? 0))
  const results = []
  const startedAt = Date.now()
  let active = 0

  // 序号必须在**派发时**自增：之前用 `results.length + 1`（已完成数），首批 worker 同时启动时
  // 全部拿到 1，四个子进程往同一个日志文件里写，TAP 摘要和失败输出会互相覆盖（审计 P2）。
  let nextLogId = 0
  const spawnOne = (file) => new Promise((resolveFile) => {
    nextLogId += 1
    const logFile = join(tmpdir(), `bao-test-${process.pid}-${nextLogId}-${basename(file, '.cjs')}.log`)
    const fd = openSync(logFile, 'w')
    const child = spawn(process.execPath, [...args, file], {
      cwd: ROOT,
      env,
      stdio: ['ignore', fd, fd],
      windowsHide: true
    })
    const t0 = Date.now()
    const done = (code) => {
      closeSync(fd)
      const seconds = (Date.now() - t0) / 1000
      results.push({ file, code, logFile, seconds })
      durations[file] = Math.round(seconds * 10) / 10
      const tally = /ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/.exec(readFileSync(logFile, 'utf8'))
      console.log(`${code === 0 ? '✔' : '✖'} ${file}  ${seconds.toFixed(1)}s`
        + (tally ? `  pass ${tally[1]} / fail ${tally[2]}` : ''))
      resolveFile()
    }
    child.on('exit', (code) => done(code ?? 1))
    child.on('error', (error) => {
      writeFileSync(logFile, `启动子进程失败：${error && error.stack ? error.stack : String(error)}\n`)
      done(1)
    })
  })

  const worker = async () => {
    while (pending.length > 0 && active < jobs) {
      active += 1
      const file = pending.shift()
      await spawnOne(file)
      active -= 1
    }
  }

  return Promise.all(Array.from({ length: Math.min(jobs, files.length) }, () => worker())).then(() => {
    writeDurations(durations)
    const seconds = (Date.now() - startedAt) / 1000
    const failed = results.filter((result) => result.code !== 0)
    for (const result of failed) {
      console.log(`\n===== ${result.file} 失败，完整输出 =====`)
      process.stdout.write(readFileSync(result.logFile))
    }
    console.log(`\n并行 ${jobs} 个文件跑完：${results.length} 个文件，用时 ${seconds.toFixed(1)} s，失败 ${failed.length} 个`)
    const slow = [...results].sort((a, b) => b.seconds - a.seconds).slice(0, 5)
    console.log('最慢的 5 个：' + slow.map((item) => `${item.file.replace('tests/smoke/', '')} ${item.seconds.toFixed(1)}s`).join('，'))
    return failed.length
  })
}

if (require.main === module) build()

module.exports = { build, buildIfChanged, fingerprint, runPool, runNode, ROOT }
