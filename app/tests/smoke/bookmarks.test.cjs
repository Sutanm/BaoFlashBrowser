const assert = require('node:assert/strict')
const { test } = require('node:test')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { launchApp, launchAppAt, page, startFixtureServer, waitFor } = require('./helpers.cjs')

/**
 * 收藏夹（M2「书签与历史」）的合同验证。
 *
 * 交互按 Chromium 142 的源码对齐（`chrome/browser/ui/browser_commands.cc:1634`
 * `BookmarkCurrentTab` → `AddIfNotBookmarked` + `ShowBookmarkBubble`）：
 * - **地址栏里的星标**：点一次就落库（名称=页面标题、位置=收藏夹栏），并弹出「编辑收藏夹」气泡；
 * - 气泡里改名 / 换文件夹（**下拉**，列出所有文件夹）/ 删除，关闭后星标跟着变；
 * - 气泡里的「更多」打开完整编辑器（名称 / URL / 文件夹树 / 新建文件夹 / 保存 / 取消）；
 * - **工具栏「收藏夹」按钮**是另一件事：打开收藏夹树（这里的 `#bookmarks-panel`）；
 * - 数据落库：重启后收藏还在、星标认得出来；
 * - 独立进程模式（`BAO_OVERLAY_SHARED=0`）下气泡是 `quick` 角色：改名命令必须被放行。
 *
 * 按钮的主次是产品决定（不是 Chromium 的）：点星标即已收藏，所以**删除**在最右且用危险色，
 * 「完成」退成次要按钮——用例把顺序与颜色一起钉住。
 */

const OVERLAY_URL = 'baoOverlay=overlay'

async function overlayContentsId(app) {
  return app.evaluate(({ webContents }, marker) => {
    const target = webContents.getAllWebContents().find((contents) => (contents.getURL() ?? '').includes(marker))
    return target ? target.id : null
  }, OVERLAY_URL)
}

/** 在叠加层文档里执行脚本（视图可能正在创建：重试一次）。 */
async function inOverlay(app, code) {
  let lastError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const id = await overlayContentsId(app)
    if (!id) {
      lastError = new Error('没有找到叠加层文档')
    } else {
      try {
        return await app.evaluate(async ({ webContents }, payload) => {
          const target = webContents.fromId(payload.id)
          if (!target) throw new Error('叠加层已销毁')
          return target.executeJavaScript(payload.code)
        }, { id, code })
      } catch (error) {
        lastError = error
      }
    }
    await new Promise((done) => setTimeout(done, 250))
  }
  throw lastError
}

/** 按可见文字点面板里的按钮（按钮是 `overlay-button`，文字是唯一稳定标识）。 */
async function clickButton(app, scope, text) {
  await inOverlay(app, `(() => {
    const button = [...document.querySelectorAll(${JSON.stringify(scope)})]
      .find((el) => el.textContent.trim() === ${JSON.stringify(text)})
    if (!button) throw new Error('没有找到按钮：${text}')
    button.click()
    return true
  })()`)
}

/** 叠加层视图：是否挂载（=显示中）以及真实 bounds。 */
async function overlayView(app) {
  return app.evaluate(({ webContents, BrowserWindow }, marker) => {
    const target = webContents.getAllWebContents().find((contents) => (contents.getURL() ?? '').includes(marker))
    const win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().endsWith('index.html'))
    if (!target || !win) return null
    // 边界属于 WebContentsView，不属于 webContents。
    const child = win.contentView.children.find((view) => view.webContents?.id === target.id)
    return { id: target.id, attached: Boolean(child), bounds: child ? child.getBounds() : null, contentSize: win.getContentSize() }
  }, OVERLAY_URL)
}

/**
 * 飞窗各页的真实 DOM 事实。
 *
 * 四个页面常驻挂载（`v-show`），所以"显示没显示"看高度：wrapper 被 `display:none` 时是 0。
 * 注意：视图本身被 detach 之后 DOM 仍然有布局（文档还活着），要判"飞窗开没开"必须看 `attached`。
 */
async function panelFacts(app) {
  return inOverlay(app, `(() => {
    const heightOf = (selector) => {
      const el = document.querySelector(selector)
      return el ? Math.round(el.getBoundingClientRect().height) : 0
    }
    const bubble = document.querySelector('#bookmark-edit-panel')
    const editor = document.querySelector('#bookmark-editor-panel')
    const hub = document.querySelector('#bookmarks-panel')
    return {
      bubble: heightOf('#bookmark-edit-panel') > 0,
      editor: heightOf('#bookmark-editor-panel') > 0,
      hub: heightOf('#bookmarks-panel') > 0,
      settings: heightOf('#quick-settings') > 0,
      bubbleTitle: bubble?.querySelector('h2')?.textContent?.trim() ?? null,
      name: bubble?.querySelector('#bookmark-name')?.value ?? null,
      folderLabel: bubble?.querySelector('.folder-trigger .trigger-label')?.textContent?.trim() ?? null,
      folderOpen: Boolean(bubble?.querySelector('.folder-menu')),
      folderOptions: [...(bubble?.querySelectorAll('.folder-option') ?? [])].map((el) => el.textContent.trim()),
      actions: [...(bubble?.querySelectorAll('.bubble-actions button') ?? [])].map((el) => el.textContent.trim()),
      danger: bubble?.querySelector('.bubble-actions .danger')?.textContent?.trim() ?? null,
      editorName: editor?.querySelector('#editor-name')?.value ?? null,
      editorUrl: editor?.querySelector('#editor-url')?.value ?? null,
      editorFolders: [...(editor?.querySelectorAll('.folder-row') ?? [])].map((el) => el.textContent.trim()),
      editorSelected: editor?.querySelector('.folder-row[aria-checked="true"]')?.textContent?.trim() ?? null,
      editorActions: [...(editor?.querySelectorAll('.editor-actions button') ?? [])].map((el) => el.textContent.trim()),
      hubRows: [...(hub?.querySelectorAll('.hub-row .row-title') ?? [])].map((el) => el.textContent.trim()),
      hubGroups: [...(hub?.querySelectorAll('.hub-lists .overlay-label') ?? [])].map((el) => [
        el.querySelector('span')?.textContent.trim() ?? '',
        el.querySelector('.count')?.textContent.trim() ?? ''
      ]),
      hubEmpty: Boolean(hub?.querySelector('.overlay-empty'))
    }
  })()`)
}

const snapshot = (shell) => shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' }).then((result) => result.state))

const starFacts = (shell) => shell.evaluate(() => {
  const button = document.querySelector('.address-bar .bookmark-star')
  // 内部页没有星标（Chromium 对 chrome:// 页同样不显示），所以这里必须允许 null。
  return button
    ? { label: button.getAttribute('aria-label'), filled: button.classList.contains('bookmarked') }
    : null
})

const starRect = (shell) => shell.evaluate(() => {
  const rect = document.querySelector('.address-bar .bookmark-star').getBoundingClientRect()
  return { right: Math.round(rect.right), bottom: Math.round(rect.bottom) }
})

const openBubble = (app, message = '编辑收藏夹气泡没有打开') => waitFor(async () => {
  const view = await overlayView(app)
  if (!view?.attached) return null
  const facts = await panelFacts(app)
  return facts.bubble ? { ...facts, bounds: view.bounds, contentSize: view.contentSize } : null
}, { message })

const openEditor = (app, message = '完整编辑器没有打开') => waitFor(async () => {
  const view = await overlayView(app)
  if (!view?.attached) return null
  const facts = await panelFacts(app)
  return facts.editor ? { ...facts, bounds: view.bounds } : null
}, { message })

const openHub = (app, message = '收藏夹飞窗没有打开') => waitFor(async () => {
  const view = await overlayView(app)
  if (!view?.attached) return null
  const facts = await panelFacts(app)
  return facts.hub ? { ...facts, bounds: view.bounds, contentSize: view.contentSize } : null
}, { message })

const flyoutClosed = (app) => waitFor(async () => (await overlayView(app))?.attached !== true ? true : null,
  { message: '飞窗没有关闭' })

/** 点外壳其它地方收起飞窗（飞窗自己没有关闭按钮时就是这条路）。 */
async function dismissFlyout(app, shell) {
  await shell.evaluate(() => {
    document.querySelector('.address-bar input')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  })
  await flyoutClosed(app)
}

async function openPage(shell, url, title) {
  const address = shell.getByRole('textbox', { name: '地址栏' })
  await address.fill(url)
  await address.press('Enter')
  await shell.getByRole('button', { name: title, exact: true }).waitFor({ timeout: 30_000 })
}

/** 改名走真实的输入路径（v-model 的 input 事件），等落库生效。 */
async function renameInBubble(app, shell, title) {
  await inOverlay(app, `(() => {
    const field = document.querySelector('#bookmark-name')
    field.focus()
    field.value = ${JSON.stringify(title)}
    field.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  return waitFor(async () => {
    const state = await snapshot(shell)
    const node = state.bookmarks.find((entry) => entry.kind === 'url')
    return node?.title === title ? node : null
  }, { message: `改名没有生效：${title}` })
}

/** 展开气泡里的文件夹下拉并选一项。 */
async function chooseFolder(app, label) {
  await inOverlay(app, `document.querySelector('.folder-trigger').click()`)
  await waitFor(async () => {
    const facts = await panelFacts(app)
    return facts.folderOpen ? facts : null
  }, { message: '文件夹下拉没有展开' })
  await inOverlay(app, `(() => {
    const option = [...document.querySelectorAll('#bookmark-edit-panel .folder-option')]
      .find((el) => el.textContent.includes(${JSON.stringify(label)}))
    if (!option) throw new Error('下拉里没有这个文件夹：${label}')
    option.click()
    return true
  })()`)
}

test('收藏夹：星标 = 收藏 + 气泡，文件夹是下拉，更多打开编辑器', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({
    '/first': page('第一个收藏页'),
    '/second': page('第二个页面')
  })
  const { app, shell, close } = await launchApp()
  try {
    // ① 内部页没有星标（Chromium 对内部页同样不显示），但收藏夹按钮一直在。
    await shell.waitForSelector('.bookmarks-button')
    assert.equal(await shell.locator('.address-bar .bookmark-star').count(), 0,
      '新标签页不该出现星标（没有可收藏的地址）')

    // ② 空收藏夹：点工具栏的「收藏夹」→ 树打开、显示空状态；宽度与快捷设置同为 320。
    await shell.locator('.bookmarks-button').click()
    const empty = await openHub(app)
    assert.equal(empty.hubEmpty, true)
    assert.deepEqual(empty.hubRows, [])
    const hubRect = await shell.evaluate(() => {
      const rect = document.querySelector('.bookmarks-button').getBoundingClientRect()
      return { right: Math.round(rect.right), bottom: Math.round(rect.bottom) }
    })
    // 视图比卡片大一圈投影边距（OVERLAY_GUTTER=12，顶边不留），见 overlay-geometry.ts。
    const GUTTER = 12
    assert.equal(empty.bounds.y, hubRect.bottom, '收藏夹卡片顶边应贴着按钮下沿')
    assert.equal(empty.bounds.x + empty.bounds.width - GUTTER, hubRect.right, '收藏夹卡片右缘应与按钮对齐')
    assert.equal(empty.bounds.width, 320 + 2 * GUTTER, '收藏夹卡片应与快捷设置同宽（三只飞窗挂在一起）')
    await dismissFlyout(app, shell)

    // ③ 网页上出现星标（空心）。
    await openPage(shell, `${server.baseUrl}/first`, '第一个收藏页')
    const fresh = await waitFor(async () => {
      const facts = await starFacts(shell)
      return facts ? facts : null
    }, { message: '网页上星标没有出现' })
    assert.equal(fresh.label, '收藏此页面')
    assert.equal(fresh.filled, false)

    // ④ 点星标：先落库，再弹「编辑收藏夹」气泡；按钮是「更多 / 完成 / 删除」，删除在右且是危险色。
    await shell.locator('.address-bar .bookmark-star').click()
    const bubble = await openBubble(app)
    const rect = await starRect(shell)
    assert.equal(bubble.bounds.y, rect.bottom, '气泡卡片顶边应贴着星标下沿')
    assert.equal(bubble.bounds.x + bubble.bounds.width - 12, rect.right, '气泡卡片右缘应与星标对齐')
    assert.equal(bubble.bounds.width, 320 + 24, '气泡卡片应与快捷设置同宽（反馈"飞窗宽了"）')
    assert.equal(bubble.bubbleTitle, '编辑收藏夹')
    assert.equal(bubble.name, '第一个收藏页', '名称默认就是页面标题（Chromium 的 AddIfNotBookmarked）')
    assert.equal(bubble.folderLabel, '收藏夹栏')
    assert.equal(bubble.folderOpen, false, '下拉默认收起')
    assert.deepEqual(bubble.actions, ['更多', '完成', '删除'], '删除在最右，完成退成次要按钮')
    assert.equal(bubble.danger, '删除', '最右那颗按钮就是"删除"，并且用危险色')
    assert.equal(bubble.settings, false, '打开气泡时不该同时显示快捷设置')

    const saved = (await snapshot(shell)).bookmarks.filter((node) => node.kind === 'url')
    assert.equal(saved.length, 1, `点一次星标就该有一条收藏：${JSON.stringify(saved)}`)
    assert.equal(saved[0].title, '第一个收藏页')
    assert.equal(saved[0].url, `${server.baseUrl}/first`)
    assert.equal(saved[0].parentId, 'bar')
    const starred = await starFacts(shell)
    assert.equal(starred.filled, true, '收藏后星标应变实心')
    assert.equal(starred.label, '编辑收藏夹')

    // ⑤ 改名：输入后停顿 400 ms 自动保存（我们的气泡没法在"关闭时保存"，见组件注释）。
    const renamed = await renameInBubble(app, shell, '我的收藏')
    assert.equal(renamed.title, '我的收藏')

    // ⑥ 文件夹是**下拉**：展开后列出所有文件夹，选一项立即生效。
    await inOverlay(app, `document.querySelector('.folder-trigger').click()`)
    const opened = await waitFor(async () => {
      const facts = await panelFacts(app)
      return facts.folderOpen ? facts : null
    }, { message: '文件夹下拉没有展开' })
    assert.deepEqual(opened.folderOptions, ['收藏夹栏', '其他收藏夹'], '下拉里是文件夹，不是"两个写死的根"')
    await inOverlay(app, `[...document.querySelectorAll('#bookmark-edit-panel .folder-option')]
      .find((el) => el.textContent.includes('其他收藏夹')).click()`)
    const moved = await waitFor(async () => {
      const state = await snapshot(shell)
      const node = state.bookmarks.find((entry) => entry.kind === 'url')
      return node?.parentId === 'other' ? node : null
    }, { message: '换文件夹没有生效' })
    assert.equal(moved.title, '我的收藏', '换文件夹不该丢名字')

    // ⑦ 「完成」收起气泡；再点星标是编辑同一条，不会攒出第二条。
    await clickButton(app, '#bookmark-edit-panel .bubble-actions button', '完成')
    await flyoutClosed(app)
    await shell.locator('.address-bar .bookmark-star').click()
    const reopened = await openBubble(app)
    assert.equal(reopened.name, '我的收藏')
    assert.equal(reopened.folderLabel, '其他收藏夹')
    assert.equal((await snapshot(shell)).bookmarks.filter((node) => node.kind === 'url').length, 1,
      '重复点星标不能新增第二条')

    // ⑧ 「更多」→ 完整编辑器：名称 / URL / 文件夹树都对上；新建文件夹后能被选中并保存。
    await clickButton(app, '#bookmark-edit-panel .bubble-actions button', '更多')
    const editor = await openEditor(app)
    assert.equal(editor.actions.length, 3, '气泡的按钮不该和编辑器混在一起')
    assert.equal(editor.editorName, '我的收藏')
    assert.equal(editor.editorUrl, `${server.baseUrl}/first`, '编辑器里能改 URL')
    assert.deepEqual(editor.editorFolders, ['收藏夹栏', '其他收藏夹'])
    assert.equal(editor.editorSelected, '其他收藏夹')
    assert.deepEqual(editor.editorActions, ['取消', '保存'])

    await clickButton(app, '#bookmark-editor-panel .overlay-button', '新建文件夹')
    await inOverlay(app, `(() => {
      const input = document.querySelector('.create-row .overlay-input')
      input.focus()
      input.value = '专题'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await clickButton(app, '.create-row .overlay-button', '添加')
    const created = await waitFor(async () => {
      const state = await snapshot(shell)
      const folder = state.bookmarks.find((node) => node.kind === 'folder' && node.title === '专题')
      return folder ? folder : null
    }, { message: '新建文件夹没有落库' })
    assert.ok(created.id)
    const withFolder = await waitFor(async () => {
      const facts = await panelFacts(app)
      return facts.editorFolders.includes('专题') ? facts : null
    }, { message: '新建的文件夹没有出现在编辑器树里（没和收藏夹联动）' })
    assert.equal(withFolder.editorSelected, '专题', '新建后应当选中它，避免"建了还要再点一次"')

    await clickButton(app, '#bookmark-editor-panel .editor-actions button', '保存')
    await flyoutClosed(app)
    const afterSave = await waitFor(async () => {
      const state = await snapshot(shell)
      const node = state.bookmarks.find((entry) => entry.kind === 'url')
      return node?.parentId === created.id ? node : null
    }, { message: '保存后收藏没有进新建的文件夹' })
    assert.equal(afterSave.title, '我的收藏', '编辑器保存不该改名字（没改就不写）')
    assert.equal(afterSave.url, `${server.baseUrl}/first`)

    // ⑨ 「取消」不写：编辑器里改了名字，点取消后库里还是原值。
    await shell.locator('.address-bar .bookmark-star').click()
    await openBubble(app)
    await clickButton(app, '#bookmark-edit-panel .bubble-actions button', '更多')
    await openEditor(app)
    await inOverlay(app, `(() => {
      const input = document.querySelector('#editor-name')
      input.focus()
      input.value = '不该保存的名字'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await clickButton(app, '#bookmark-editor-panel .editor-actions button', '取消')
    await flyoutClosed(app)
    const afterCancel = (await snapshot(shell)).bookmarks.find((entry) => entry.kind === 'url')
    assert.equal(afterCancel.title, '我的收藏', '「取消」不该改库里的名字')

    // ⑩ 「删除」：条目消失、星标回到空心、树回到空状态。
    await shell.locator('.address-bar .bookmark-star').click()
    await openBubble(app)
    await clickButton(app, '#bookmark-edit-panel .bubble-actions button', '删除')
    await flyoutClosed(app)
    const cleared = await waitFor(async () => {
      const state = await snapshot(shell)
      const urls = state.bookmarks.filter((node) => node.kind === 'url')
      return urls.length === 0 ? state : null
    }, { message: '删除后收藏里仍有网址条目' })
    assert.equal(cleared.bookmarks.filter((node) => node.kind === 'folder').length, 3,
      '文件夹（两个根 + 新建的专题）应当保留')
    const unstarred = await waitFor(async () => {
      const facts = await starFacts(shell)
      return facts?.label === '收藏此页面' ? facts : null
    }, { message: '删除后星标没有回到未收藏态' })
    assert.equal(unstarred.filled, false)

    // ⑪ 再收藏一页 + 从树里打开它（地址取自库里，不取自界面）。
    await openPage(shell, `${server.baseUrl}/second`, '第二个页面')
    await shell.locator('.address-bar .bookmark-star').click()
    await openBubble(app)
    await clickButton(app, '#bookmark-edit-panel .bubble-actions button', '完成')
    await flyoutClosed(app)
    await shell.locator('.bookmarks-button').click()
    const hub = await openHub(app)
    // 树里还有上一步留下的「专题」文件夹（在「其他收藏夹」下），所以两组都各有一条。
    assert.deepEqual(hub.hubGroups, [['收藏夹栏', '1'], ['其他收藏夹', '1']])
    assert.deepEqual(hub.hubRows, ['第二个页面', '专题'])
    await inOverlay(app, `(() => {
      const row = [...document.querySelectorAll('#bookmarks-panel .hub-row .row-title')]
        .find((el) => el.textContent.trim() === '第二个页面')
      if (!row) throw new Error('树里没有第二个页面那一条')
      row.click()
      return true
    })()`)
    await waitFor(async () => {
      const state = await snapshot(shell)
      const active = state.tabs.find((tab) => tab.id === state.activeId)
      return active?.address === `${server.baseUrl}/second` ? active : null
    }, { message: '点收藏行没有导航' })
    await flyoutClosed(app)

    // ⑫ 齿轮飞窗里的「收藏夹」入口：换到同一只飞窗的收藏夹页（并重新锚定到那颗按钮）。
    await shell.locator('.gear-button').click()
    const quick = await waitFor(async () => {
      const facts = await panelFacts(app)
      return facts.settings ? facts : null
    }, { message: '齿轮飞窗没有打开' })
    assert.equal(quick.hub, false)
    await inOverlay(app, `[...document.querySelectorAll('#quick-settings .overlay-row.footer')]
      .find((el) => el.textContent.includes('收藏夹')).click()`)
    const switched = await openHub(app, '齿轮里的「收藏夹」没有切到收藏夹页')
    assert.equal(switched.settings, false, '换页后快捷设置那页必须收起')
    const anchor = await shell.evaluate(() => {
      const rect = document.querySelector('.bookmarks-button').getBoundingClientRect()
      return { right: Math.round(rect.right), bottom: Math.round(rect.bottom) }
    })
    assert.equal(switched.bounds.y, anchor.bottom, '换页后应重新锚定到收藏夹按钮下沿')
    assert.equal(switched.bounds.x + switched.bounds.width - 12, anchor.right, '换页后应重新对齐收藏夹按钮右缘')
  } finally {
    await close()
    await server.close()
  }
})

test('收藏夹：重启后收藏还在，星标认得出来', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({ '/saved': page('保存过的页面') })
  const profilePath = await mkdtemp(join(tmpdir(), 'bao-next-bookmarks-'))
  try {
    const first = await launchAppAt(profilePath)
    try {
      await openPage(first.shell, `${server.baseUrl}/saved`, '保存过的页面')
      await first.shell.locator('.address-bar .bookmark-star').waitFor()
      await first.shell.locator('.address-bar .bookmark-star').click()
      await openBubble(first.app)
      await clickButton(first.app, '#bookmark-edit-panel .bubble-actions button', '完成')
      await flyoutClosed(first.app)
      await waitFor(async () => {
        const state = await snapshot(first.shell)
        return state.bookmarks.some((node) => node.kind === 'url') ? true : null
      }, { message: '收藏没有写进投影' })
    } finally {
      await first.close()
    }

    const second = await launchAppAt(profilePath)
    try {
      const state = await snapshot(second.shell)
      const nodes = state.bookmarks.filter((node) => node.kind === 'url')
      assert.equal(nodes.length, 1, `重启后收藏丢了：${JSON.stringify(state.bookmarks)}`)
      assert.equal(nodes[0].url, `${server.baseUrl}/saved`)
      assert.equal(nodes[0].title, '保存过的页面')

      // 同一个地址重新打开：星标必须已经是实心（"有没有收藏"来自投影，不是界面自己记的）。
      await openPage(second.shell, `${server.baseUrl}/saved`, '保存过的页面')
      const starred = await waitFor(async () => {
        const facts = await starFacts(second.shell)
        return facts?.filled ? facts : null
      }, { message: '重启后星标没有认出已收藏的地址' })
      assert.equal(starred.label, '编辑收藏夹')

      // 树里也有它。
      await second.shell.locator('.bookmarks-button').click()
      const hub = await openHub(second.app)
      assert.deepEqual(hub.hubRows, ['保存过的页面'])
    } finally {
      await second.close()
    }
  } finally {
    await rm(profilePath, { recursive: true, force: true, maxRetries: 3 })
    await server.close()
  }
})

test('收藏夹：独立进程模式（quick 角色）下气泡也能改名', { timeout: 120_000 }, async () => {
  // 共享进程模式下浮层的命令以"外壳"身份到达（`window.open` 的 guest 用外壳 preload），
  // 独立进程模式才是 `quick` 角色：这条用例专门盯住那条授权分支。
  const server = await startFixtureServer({ '/solo': page('独立进程页') })
  const { app, shell, close } = await launchApp({ env: { BAO_OVERLAY_SHARED: '0' } })
  try {
    await openPage(shell, `${server.baseUrl}/solo`, '独立进程页')
    await shell.locator('.address-bar .bookmark-star').click()
    const bubble = await openBubble(app, '独立进程模式下编辑气泡没有打开')
    assert.equal(bubble.name, '独立进程页')
    const renamed = await renameInBubble(app, shell, '独立进程里的名字')
    assert.equal(renamed.title, '独立进程里的名字')
    // 新建文件夹同样走 quick 角色：它是编辑器里唯一会"写目录结构"的命令。
    await clickButton(app, '#bookmark-edit-panel .bubble-actions button', '更多')
    await openEditor(app)
    await clickButton(app, '#bookmark-editor-panel .overlay-button', '新建文件夹')
    await inOverlay(app, `(() => {
      const input = document.querySelector('.create-row .overlay-input')
      input.focus()
      input.value = '独立进程文件夹'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await clickButton(app, '.create-row .overlay-button', '添加')
    await waitFor(async () => {
      const state = await snapshot(shell)
      return state.bookmarks.some((node) => node.kind === 'folder' && node.title === '独立进程文件夹') ? true : null
    }, { message: '独立进程模式下新建文件夹没有落库' })
  } finally {
    await close()
    await server.close()
  }
})
