/**
 * 探针 2：窗口**不在前台**时创建浮层文档，会不会抢走 OS 激活 / WebContents 焦点。
 *
 * 为什么单独一条：交接文档说「启动后空闲时建文档会抢焦点、吞掉用户正在敲的键」，
 * 但探针 1（窗口在前台时悬停预热）实测**没有任何焦点变化**。差别在窗口是否 active：
 *
 * - Chromium `WebContentsImpl::CreateNewWindow` 在 `!renderer_started_hidden` 时会
 *   `widget_view->Show()` 并 `contents_to_load->Focus()`（web_contents_impl.cc:5408/5529）；
 * - 是否走到那一步取决于"新建窗口初始是否隐藏"，而 shell 是不是活动窗口会改变后果：
 *   活动窗口内换焦点只是"文档丢焦点"，非活动窗口上显示 native widget 可能直接改 OS 激活。
 *
 * 判定方式（不需要 Win32 调用，直接从应用内部读）：
 *   BrowserWindow.getFocusedWindow() / win.isFocused()  → OS 激活有没有变
 *   webContents.getFocusedWebContents()                → 按键会被路由到谁
 *
 * 用法：
 *   $env:ELECTRON_EXEC_PATH=(Resolve-Path '.runtime\win-x64\electron.exe').Path
 *   node scripts/probe-overlay-focus-background.cjs
 */
const { execFileSync } = require('node:child_process')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { _electron: electron } = require('playwright')

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function runPowerShell(script) {
  return execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim()
}

/** 把前台交给记事本（返回它的标题，便于确认真的切走了）。 */
function focusNotepad() {
  return runPowerShell(
    "$p = Start-Process notepad -PassThru; Start-Sleep -Milliseconds 700; " +
    "$w = New-Object -ComObject WScript.Shell; [void]$w.AppActivate($p.Id); Start-Sleep -Milliseconds 400; " +
    "'notepad pid=' + $p.Id"
  )
}

async function state(app, shell, label) {
  const main = await app.evaluate(({ BrowserWindow, webContents }) => {
    const win = BrowserWindow.getAllWindows()[0]
    const focusedContents = webContents.getFocusedWebContents()
    return {
      windowActive: win ? win.isFocused() : null,
      focusedWindow: BrowserWindow.getFocusedWindow() ? BrowserWindow.getFocusedWindow().id : null,
      focusedContents: focusedContents ? focusedContents.id : null,
      focusedUrl: focusedContents
        ? (focusedContents.getURL().includes('baoOverlay') ? 'overlay' : focusedContents.getURL().replace(/^.*[\\/]/, ''))
        : null,
      overlayPresent: webContents.getAllWebContents().some((item) => item.getURL().includes('baoOverlay=overlay')),
      overlayFocused: webContents.getAllWebContents()
        .some((item) => item.getURL().includes('baoOverlay=overlay') && item.isFocused())
    }
  })
  const page = await shell.evaluate(() => ({ hasFocus: document.hasFocus() }))
  console.log(`\n=== ${label} ===\nmain : ${JSON.stringify(main)}\nshell: ${JSON.stringify(page)}`)
  return { main, page }
}

async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE
  const executablePath = process.env.ELECTRON_EXEC_PATH
  if (!executablePath) throw new Error('请设置 ELECTRON_EXEC_PATH')
  const profilePath = mkdtempSync(join(tmpdir(), 'bao-focus-bg-'))
  const app = await electron.launch({
    executablePath,
    args: [resolve(__dirname, '..'), `--user-data-dir=${profilePath}`],
    timeout: 20_000
  })
  let notepadPid
  try {
    const shell = app.windows().find((page) => page.url().endsWith('/out/renderer/index.html')) ??
      await app.waitForEvent('window', { predicate: (page) => page.url().endsWith('/out/renderer/index.html') })
    shell.setDefaultTimeout(10_000)
    await shell.waitForSelector('.gear-button')
    await sleep(500)
    await state(app, shell, '基线：应用窗口刚启动')

    const notepad = focusNotepad()
    notepadPid = Number((/pid=(\d+)/.exec(notepad) ?? [])[1]) || undefined
    console.log(`\n切走前台 → ${notepad}`)
    await sleep(500)
    await state(app, shell, '切走之后（应用应当不是活动窗口）')

    // 不经任何用户交互，直接调用外壳的 window.open（等价于「空闲时建文档」）。
    const opened = await shell.evaluate(() => {
      const url = new URL(location.href)
      url.search = '?baoOverlay=overlay'
      const proxy = window.open(url.href, 'bao-overlay-probe', 'width=600,height=520')
      return Boolean(proxy)
    })
    console.log(`\nwindow.open 返回: ${opened}`)
    await sleep(1200)
    await state(app, shell, '非前台创建浮层文档之后')

    await sleep(1500)
    await state(app, shell, '再等 1.5 s（看是否会延迟抢焦点）')
  } finally {
    if (notepadPid) {
      try { runPowerShell(`Stop-Process -Id ${notepadPid} -ErrorAction SilentlyContinue`) } catch { /* ignore */ }
    }
    try {
      runPowerShell("Get-Process -Name notepad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*无标题*' -or $_.MainWindowTitle -like '*Untitled*' } | Stop-Process -ErrorAction SilentlyContinue")
    } catch { /* ignore */ }
    await app.close().catch(() => {})
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
