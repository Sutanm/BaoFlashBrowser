const assert = require('node:assert/strict')
const { once } = require('node:events')
const { createServer } = require('node:http')
const { test } = require('node:test')
const { launchApp, page, startFixtureServer, waitFor } = require('./helpers.cjs')

async function snapshot(shell) {
  const result = await shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' }))
  assert.equal(result.ok, true)
  return result.state
}

async function navigate(shell, url, title) {
  const address = shell.getByRole('textbox', { name: '地址栏' })
  await address.waitFor()
  await address.fill(url)
  await address.press('Enter')
  if (title) await shell.getByRole('button', { name: title, exact: true }).waitFor({ timeout: 30_000 })
}

function activeTabOf(state) {
  return state.tabs.find((tab) => tab.id === state.activeId)
}

async function expectEngine(shell, engine, source, pinnedEngine) {
  await waitFor(async () => {
    const tab = activeTabOf(await snapshot(shell))
    return tab.engine === engine && tab.engineSource === source && tab.pinnedEngine === pinnedEngine
  }, { message: `引擎状态不是 ${engine}/${source}/${pinnedEngine ?? '无规则'}。` })
}

const panelNames = {
  flash: 'Flash 原生播放器',
  ruffle: 'Ruffle 兼容播放器',
  remember: '记住当前引擎',
  replaceWithFlash: '改为记住 Flash',
  forget: '取消记住'
}

// Native overlays are attached WebContentsViews, not BrowserWindows. Find the mounted
// view by URL, then inspect its renderer DOM or send an actual pointer event to it.
function overlay(windowHandle, kind, { name, attribute, value, text, click } = {}) {
  return windowHandle.evaluate(async (window, { kind, name, attribute, value, text, click }) => {
    const view = window.contentView.children.find((child) =>
      child.webContents && new URL(child.webContents.getURL() || 'about:blank').searchParams.get('baoOverlay') === kind)
    if (!view?.getVisible()) return null
    if (!name) return { bounds: view.getBounds() }

    const facts = await view.webContents.executeJavaScript(`(() => {
      const name = ${JSON.stringify(name)}
      const labelOf = (button) => {
        const labelledBy = button.getAttribute('aria-labelledby')
        return (labelledBy ? document.getElementById(labelledBy)?.textContent
          : button.getAttribute('aria-label') ?? button.innerText)?.replace(/\\s+/g, ' ').trim()
      }
      const button = [...document.querySelectorAll('button')].find((button) => labelOf(button) === name)
      if (!button) return null
      const rect = button.getBoundingClientRect()
      const x = Math.floor(rect.left + rect.width / 2)
      const y = Math.floor(rect.top + rect.height / 2)
      return {
        x, y,
        hittable: button.contains(document.elementFromPoint(x, y)),
        disabled: button.disabled,
        role: button.getAttribute('role'),
        value: button.getAttribute(${JSON.stringify(attribute ?? 'aria-pressed')}),
        text: document.body.innerText
      }
    })()`)
    if (!facts?.hittable || (value !== undefined && facts.value !== value) ||
      (text && !facts.text.includes(text))) return null
    if (click) {
      if (facts.disabled) return null
      const { x, y } = facts
      for (const type of ['mouseDown', 'mouseUp']) {
        view.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 })
      }
    }
    return { ...facts, bounds: view.getBounds() }
  }, { kind, name, attribute, value, text, click })
}

function overlayControl(windowHandle, kind, name, options = {}) {
  return waitFor(() => overlay(windowHandle, kind, { name, ...options }), {
    message: `${kind} 叠加层未显示预期控件：${name}。`
  })
}

function engineSettings(shell) {
  return shell.getByRole('button', { name: '引擎设置', exact: true })
}

function pageViewGeometry(windowHandle) {
  return windowHandle.evaluate(async (window) => {
    const view = window.contentView.children.find((child) => {
      const url = child.webContents?.getURL()
      return url && /^https?:/.test(url)
    })
    return {
      id: view.webContents.id,
      bounds: view.getBounds(),
      viewport: await view.webContents.executeJavaScript('({ width: innerWidth, height: innerHeight })')
    }
  })
}

test('快捷切换保留导航栈，Ruffle 接管 SWF', { timeout: 240_000 }, async () => {
  const server = await startFixtureServer({
    '/one': page('第一个页面'),
    '/two': page('第二个页面')
  })
  const { app, shell, close } = await launchApp()
  try {
    await navigate(shell, `${server.baseUrl}/one`, '第一个页面')
    await navigate(shell, `${server.baseUrl}/two`, '第二个页面')

    let state = await snapshot(shell)
    assert.equal(activeTabOf(state).engine, 'ppapi')
    assert.equal(activeTabOf(state).engineSource, 'default')

    // 切到 Ruffle：新 WebContents，地址与导航栈保留。
    await shell.getByRole('switch', { name: '切换到 Ruffle 引擎', exact: true }).click()
    state = await waitFor(async () => {
      const next = await snapshot(shell)
      return activeTabOf(next).engine === 'ruffle' ? next : null
    }, { message: '未切到 Ruffle 引擎。' })
    assert.equal(activeTabOf(state).engineSource, 'manual')
    assert.ok(activeTabOf(state).address.endsWith('/two'), `切换后地址丢失：${activeTabOf(state).address}`)
    assert.equal(activeTabOf(state).canGoBack, true, '切换后导航栈未恢复')

    // Ruffle 运行时注入页面主世界（版本固定），并 polyfill 页面里的 <embed>。
    const windowHandle = await app.browserWindow(shell)
    const runtime = await waitFor(async () => {
      const facts = await windowHandle.evaluate(async (window) => {
        const view = window.contentView.children
          .find((child) => child.webContents && child.webContents !== window.webContents)
        return view.webContents.executeJavaScript(`({
          newest: typeof window.RufflePlayer?.newest,
          version: window.RufflePlayer?.version ?? null
        })`)
      })
      return facts.newest === 'function' ? facts : null
    }, { message: 'Ruffle 运行时未注入。' })
    assert.equal(runtime.newest, 'function')

    await navigate(shell, `${server.baseUrl}/flash.html`)
    const polyfill = await waitFor(async () => {
      const facts = await windowHandle.evaluate(async (window) => {
        const view = window.contentView.children
          .find((child) => child.webContents && child.webContents !== window.webContents)
        return view.webContents.executeJavaScript(`(() => {
          const player = document.querySelector('ruffle-embed, ruffle-object, ruffle-player')
          return {
            players: document.querySelectorAll('ruffle-embed, ruffle-object, ruffle-player').length,
            remaining: document.querySelectorAll('embed').length,
            id: document.getElementById('flash')?.tagName ?? null,
            // 只有 WASM 真的加载成功，Ruffle 才会在 shadow root 里创建播放器画布。
            // 只断言元素存在会在 Ruffle 报错（例如非法 publicPath）时误判通过。
            canvas: Boolean(player?.shadowRoot?.querySelector('canvas'))
          }
        })()`)
      })
      return facts.players > 0 && facts.canvas ? facts : null
    }, { message: 'Ruffle 未接管 <embed>（或播放器未初始化）。' })
    assert.ok(polyfill.players >= 1)
    assert.equal(polyfill.remaining, 0, '原 <embed> 未被替换')
    assert.equal(polyfill.id, 'RUFFLE-EMBED', 'polyfill 丢了元素 id')
    assert.equal(polyfill.canvas, true, 'Ruffle 播放器画布未创建（WASM 未加载）')
  } finally {
    await close()
    await server.close()
  }
})

test('引擎面板分别切换引擎与记住站点规则，起始页不可记住', { timeout: 240_000 }, async () => {
  const server = await startFixtureServer({
    '/one': page('规则测试页'),
    '/two': page('同站点新标签'),
    '/three': page('已取消规则的新标签')
  })
  const { app, shell, close } = await launchApp()
  try {
    const windowHandle = await app.browserWindow(shell)
    const settings = engineSettings(shell)
    const control = (name, options) => overlayControl(windowHandle, 'panel', name, options)
    const rememberSwitch = (value, click = false) => control(panelNames.remember, { attribute: 'aria-checked', value, click })
    const selected = (name, value, click = false) => control(name, { attribute: 'aria-pressed', value, click })
    const panelClosed = () => waitFor(async () => !await overlay(windowHandle, 'panel'), {
      message: '切换引擎后原生面板仍挂在窗口上。'
    })
    const newTab = shell.getByRole('button', { name: '新建标签页', exact: true })

    await settings.click()
    const startPageSwitch = await rememberSwitch('false')
    assert.equal(startPageSwitch.role, 'switch')
    assert.equal(startPageSwitch.disabled, true, '起始页不能写入站点规则')
    await selected(panelNames.flash, 'true')
    await settings.click()
    await panelClosed()

    await navigate(shell, `${server.baseUrl}/one`, '规则测试页')
    await settings.click()
    await selected(panelNames.ruffle, 'false', true)
    await panelClosed()
    await expectEngine(shell, 'ruffle', 'manual')
    await shell.getByRole('button', { name: '规则测试页', exact: true }).waitFor({ timeout: 30_000 })

    await settings.click()
    await selected(panelNames.ruffle, 'true')
    await rememberSwitch('false', true)
    await rememberSwitch('true')
    await expectEngine(shell, 'ruffle', 'site-rule', 'ruffle')

    await newTab.click()
    await navigate(shell, `${server.baseUrl}/two`, '同站点新标签')
    await expectEngine(shell, 'ruffle', 'site-rule', 'ruffle')

    await settings.click()
    await selected(panelNames.flash, 'false', true)
    await panelClosed()
    await expectEngine(shell, 'ppapi', 'manual', 'ruffle')
    await settings.click()
    await control(panelNames.replaceWithFlash, { text: '已记住 Ruffle · 当前使用 Flash', click: true })
    await rememberSwitch('true')
    await expectEngine(shell, 'ppapi', 'site-rule', 'ppapi')

    await selected(panelNames.ruffle, 'false', true)
    await panelClosed()
    await expectEngine(shell, 'ruffle', 'manual', 'ppapi')
    await settings.click()
    await control(panelNames.forget, { text: '已记住 Flash · 当前使用 Ruffle', click: true })
    await rememberSwitch('false')
    await expectEngine(shell, 'ruffle', 'manual')

    await newTab.click()
    await navigate(shell, `${server.baseUrl}/three`, '已取消规则的新标签')
    await expectEngine(shell, 'ppapi', 'default')
  } finally {
    await close()
    await server.close()
  }
})

test('地址错误提示不挤动工具栏或页面，加载失败后可以重试', { timeout: 120_000 }, async () => {
  let retryRequests = 0
  let retryReady = false
  const server = createServer((request, response) => {
    if (request.url === '/retry') {
      retryRequests += 1
      // Fail the navigation at the transport layer, not with an ordinary HTTP error page.
      if (!retryReady) {
        request.socket.destroy()
        return
      }
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' })
    response.end(page(request.url === '/retry' ? '重试成功页' : '布局测试页'))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  try {
    const { app, shell, close } = await launchApp()
    try {
      const windowHandle = await app.browserWindow(shell)
      const address = shell.getByRole('textbox', { name: '地址栏' })
      const geometry = async () => ({
        address: await address.boundingBox(),
        settings: await engineSettings(shell).boundingBox(),
        pageView: await pageViewGeometry(windowHandle)
      })

      await navigate(shell, `${baseUrl}/stable`, '布局测试页')
      const before = await geometry()
      await navigate(shell, 'not a url')
      const toastName = '关闭提示'
      const message = '请输入有效的 HTTP 或 HTTPS 网址'
      await overlayControl(windowHandle, 'toast', toastName, { text: message })
      assert.deepEqual(await geometry(), before, '显示错误提示不应改变工具栏、页面视图或页面视口的几何尺寸')
      await overlayControl(windowHandle, 'toast', toastName, { text: message, click: true })
      await waitFor(async () => !await overlay(windowHandle, 'toast'), { message: '关闭后原生提示仍挂在窗口上。' })
      assert.deepEqual(await geometry(), before)

      const retryUrl = `${baseUrl}/retry`
      await navigate(shell, retryUrl)
      await shell.getByText('页面加载失败', { exact: true }).waitFor()
      const failedRequests = retryRequests
      assert.ok(failedRequests > 0, '首次加载应请求测试服务器')
      assert.equal(activeTabOf(await snapshot(shell)).address, retryUrl)
      retryReady = true
      await shell.getByRole('button', { name: '重试', exact: true }).click()
      await shell.getByRole('button', { name: '重试成功页', exact: true }).waitFor({ timeout: 30_000 })
      assert.ok(retryRequests > failedRequests, '重试应重新请求失败的地址')
      await shell.getByText('页面加载失败', { exact: true }).waitFor({ state: 'hidden' })
      const recovered = activeTabOf(await snapshot(shell))
      assert.equal(recovered.address, retryUrl)
      assert.equal(recovered.error, '')
    } finally {
      await close()
    }
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose))
  }
})
