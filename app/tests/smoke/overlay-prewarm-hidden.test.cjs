const assert = require('node:assert/strict')
const { test } = require('node:test')
const { launchApp, waitFor } = require('./helpers.cjs')

/**
 * 叠加层"预热后空白"的回归用例。
 *
 * 为什么单独一条：`backgroundThrottling: false` 在全仓库只有叠加层视图一处
 * （`shell-overlays.ts`），而上游 #52844 描述的正是"窗口隐藏期间设了它，显示后 WCV 空白"。
 * 架构 §2 当年跑过的 24 个用例覆盖的是**页面视图**，没覆盖叠加层。
 * 本用例保证：预热过的飞窗在打开时**真的有内容**（不是一张空白视图）。
 *
 * 相关候选补丁见 docs/kernel/patch-candidates.md 的"后台渲染三件套"。
 */

const OVERLAY_URL = 'baoOverlay=overlay'

async function overlayId(app) {
  return app.evaluate(({ webContents }, marker) => {
    const target = webContents.getAllWebContents().find((contents) => (contents.getURL() ?? '').includes(marker))
    return target ? target.id : null
  }, OVERLAY_URL)
}

async function overlayView(app, id) {
  return app.evaluate(({ BrowserWindow }, targetId) => {
    const win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().endsWith('index.html'))
    if (!win) return null
    const child = win.contentView.children.find((view) => view.webContents?.id === targetId)
    return child
      ? { bounds: child.getBounds(), visible: child.getVisible(), attached: true }
      : { bounds: null, visible: false, attached: false }
  }, id)
}

/** 叠加层文档是否"有内容"：根元素存在、有尺寸、文案非空。 */
const CONTENT_FACTS = `(() => {
  const root = document.querySelector('.quick') || document.querySelector('.engine-panel')
  const rect = root ? root.getBoundingClientRect() : null
  return {
    root: root ? (root.className || root.tagName) : null,
    display: root ? getComputedStyle(root).display : null,
    width: rect ? Math.round(rect.width) : 0,
    height: rect ? Math.round(rect.height) : 0,
    text: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
    ready: document.readyState
  }
})()`

async function inOverlay(app, id, code) {
  return app.evaluate(async ({ webContents }, payload) => {
    const target = webContents.fromId(payload.id)
    if (!target || target.isDestroyed()) return { error: 'destroyed' }
    return target.executeJavaScript(payload.code).catch((error) => ({ error: String(error?.message ?? error) }))
  }, { id, code })
}

// 预热在自动化窗口模式（隐藏/后台）下被主进程主动禁用：多出来的视图会干扰
// "页面视图计数" 类断言（见 shell-overlays 的 canPrewarm）。而 #52844 的症状只在
// "窗口隐藏期间预热 → 显示" 时出现，所以这条只能用前台模式跑：
//   npm run smoke:foreground
const hiddenMode =
  process.env.BAO_SMOKE_HIDDEN === '1' || process.env.BAO_SMOKE_BACKGROUND === '1'

test('叠加层预热后打开不是空白（窗口隐藏期间设了 backgroundThrottling:false）', {
  timeout: 120_000,
  skip: hiddenMode && '预热在隐藏模式下被禁用，需前台运行：npm run smoke:foreground'
}, async () => {
  const { app, shell, close } = await launchApp()
  try {
    const gear = shell.getByRole('button', { name: '快捷设置', exact: true })
    await gear.waitFor({ timeout: 30_000 })

    // 悬停触发预热：这一步会在窗口仍隐藏时把叠加层视图建起来（首创即隐藏的场景）。
    await gear.hover()
    await waitFor(async () => (await overlayId(app)) ? true : null, { message: '悬停没有预热叠加层视图' })

    const prewarmed = await waitFor(async () => {
      const id = await overlayId(app)
      if (!id) return null
      const facts = await inOverlay(app, id, CONTENT_FACTS)
      return facts && !facts.error && facts.ready === 'complete' ? { id, facts } : null
    }, { message: '预热的叠加层文档没有加载完成' })
    // 预热后视图应当是隐藏且未挂到窗口上的。
    const beforeOpen = await overlayView(app, prewarmed.id)
    assert.equal(beforeOpen?.visible ?? false, false, '预热后的叠加层应当是隐藏的')

    // 打开飞窗：视图被挂上并显示。
    await gear.click()
    const opened = await waitFor(async () => {
      const view = await overlayView(app, prewarmed.id)
      return view && view.attached && view.visible ? view : null
    }, { message: '齿轮没有把叠加层视图显示出来' })
    assert.ok(opened.bounds.width > 0 && opened.bounds.height > 0, `叠加层 bounds 非法：${JSON.stringify(opened.bounds)}`)

    // 核心断言：显示之后文档里真的有内容（不是空白视图）。
    const content = await waitFor(async () => {
      const facts = await inOverlay(app, prewarmed.id, CONTENT_FACTS)
      return facts && !facts.error && facts.width > 0 && facts.height > 0 && facts.text.length > 0 ? facts : null
    }, { message: '叠加层显示后仍然是空白（预热→显示的空白 WCV 回归）' })

    assert.match(String(content.root), /quick/, '叠加层显示的不是快捷设置内容')
    assert.ok(content.width > 0 && content.height > 0, `叠加层内容尺寸为 0：${JSON.stringify(content)}`)
    assert.match(content.text, /主题|全部设置/, `叠加层内容不像快捷设置：${content.text}`)
  } finally {
    await close()
  }
})
