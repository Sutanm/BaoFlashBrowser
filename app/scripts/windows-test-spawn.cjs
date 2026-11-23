// Windows：让整条测试链不产生任何控制台窗口。
//
// 两类问题都要治：
// 1. Playwright 用 `shell: true` 把 Electron 的整条命令行拼成字符串交给 cmd.exe；
//    在隐藏控制台的宿主里（编辑器/自动化工具），cmd.exe 会自己分配一个**可见**控制台窗口。
//    这里把命令行拆回 argv，用 `shell: false` + `windowsHide: true` 直接 CreateProcess。
// 2. 其余（taskkill、以及任何第三方库的 spawn/exec）统一补上 `windowsHide: true`，
//    免得它们各自弹出控制台。
if (process.platform === 'win32') {
  const childProcess = require('node:child_process')
  const { join } = require('node:path')

  const hidden = (options) => ({ ...(options ?? {}), windowsHide: true })

  const spawn = childProcess.spawn
  childProcess.spawn = function patchedSpawn(command, args, options) {
    // Playwright 的 Electron 启动形态：命令字符串 + 空参数数组 + shell:true。
    if (options?.shell === true && (!args || args.length === 0) &&
        String(command).includes('--remote-debugging-port')) {
      const quoted = /"((?:\\"|[^"])*)"(?= |$)/g
      const parts = [...String(command).matchAll(quoted)]
      if (parts.length > 0 && parts.map((part) => part[0]).join(' ') === String(command)) {
        const [executable, ...electronArgs] = parts.map(([, arg]) => arg.replace(/\\"/g, '"'))
        // 只去掉 shell（不再经 cmd.exe），**不要**加 windowsHide：
        // electron.exe 是 GUI 子系统，本来就不产生控制台；而 windowsHide 会让它的
        // 窗口在 show() 之后仍不可见（2026-11-23 实测：前台冒烟因此看不到窗口）。
        return spawn.call(this, executable, electronArgs, { ...options, shell: false })
      }
      // 无法安全拆分时**明确失败**，不要退回 cmd.exe 弹窗。
      throw new Error('Unrecognized Playwright Electron command line; update the shell-free launcher.')
    }
    return spawn.call(this, command, args, hidden(options))
  }

  const spawnSync = childProcess.spawnSync
  const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
  childProcess.spawnSync = function patchedSpawnSync(command, args, options) {
    // 两种调用形态都要覆盖：`(command, options)` 与 `(command, args, options)`。
    const hasArgs = Array.isArray(args)
    const resolved = hasArgs ? options : args
    // Playwright 的进程树清理：`taskkill /pid N /T /F` 经 shell 执行，同样会弹控制台。
    const match = typeof command === 'string' && resolved && typeof resolved === 'object' &&
      /^taskkill \/pid (\d+) \/T \/F$/.exec(command)
    if (match) {
      return spawnSync.call(this, taskkill, ['/pid', match[1], '/T', '/F'],
        { ...resolved, shell: false, windowsHide: true })
    }
    if (!hasArgs) return spawnSync.call(this, command, hidden(args))
    return spawnSync.call(this, command, args, hidden(options))
  }

  for (const name of ['exec', 'execFile', 'execFileSync']) {
    const original = childProcess[name]
    if (typeof original !== 'function') continue
    childProcess[name] = function patched(...args) {
      const options = args.find((arg) => arg && typeof arg === 'object' && !Array.isArray(arg))
      if (options) Object.assign(options, { windowsHide: true })
      return original.apply(this, args)
    }
  }

  /**
   * 关键：只改 CJS 的 `child_process` 导出还不够。
   *
   * Playwright 内部用 ESM 命名导入（`import { spawn } from 'node:child_process'`）拿到的是
   * **打补丁前的快照**；不调用这个函数，它的 `shell: true` Electron 启动仍然会经 cmd.exe
   * 分配一个可见控制台窗口（2026-11-23 实测：在用户自己的终端里也照样弹）。
   */
  require('node:module').syncBuiltinESMExports()

  // 排障用：`BAO_SPAWN_TRACE=<文件>` 时把每一次子进程调用写进日志，
  // 便于定位「谁还在弹控制台」。默认完全不产生开销。
  const traceFile = process.env.BAO_SPAWN_TRACE
  if (traceFile) {
    const { appendFileSync } = require('node:fs')
    const describe = (command, args, options) => {
      const list = Array.isArray(args) ? args : []
      const opts = Array.isArray(args) ? options : args
      appendFileSync(traceFile, JSON.stringify({
        at: new Date().toISOString(),
        command: String(command),
        args: list.length > 0 ? list : undefined,
        shell: opts?.shell === true,
        windowsHide: opts?.windowsHide !== false,
        detached: opts?.detached === true
      }) + '\n')
    }
    const spawnTraced = childProcess.spawn
    childProcess.spawn = function tracedSpawn(command, args, options) {
      describe(command, args, options)
      return spawnTraced.apply(this, arguments)
    }
    const spawnSyncTraced = childProcess.spawnSync
    childProcess.spawnSync = function tracedSpawnSync(command, args, options) {
      describe(command, args, options)
      return spawnSyncTraced.apply(this, arguments)
    }
    require('node:module').syncBuiltinESMExports()
  }
}
