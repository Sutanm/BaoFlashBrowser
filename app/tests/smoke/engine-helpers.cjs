const assert = require('node:assert/strict')
const { createServer } = require('node:http')
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
    // panel 与 quick 共用同一个叠加层视图（?baoOverlay=overlay），toast 仍是自己的视图。
    // 三种内容共用一个叠加层视图（?baoOverlay=overlay），用根元素区分。
    const mode = 'overlay'
    const rootSelector = kind === 'quick' ? '.quick' : kind === 'panel' ? '.engine-panel' : '.toast'
    const view = window.contentView.children.find((child) =>
      child.webContents && new URL(child.webContents.getURL() || 'about:blank').searchParams.get('baoOverlay') === mode)
    if (!view?.getVisible()) return null
    const shown = await view.webContents.executeJavaScript(
      `Boolean(document.querySelector(${JSON.stringify(rootSelector)})?.offsetParent || document.querySelector(${JSON.stringify(rootSelector)})?.closest('[style*="display: none"]') === null)`)
    if (!shown) return null
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

module.exports = {
  activeTabOf,
  engineSettings,
  expectEngine,
  navigate,
  overlay,
  overlayControl,
  pageViewGeometry,
  panelNames,
  snapshot
}