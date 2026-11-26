const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createServer } = require('node:http')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { launchApp, launchAppAt, page, startFixtureServer, waitFor } = require('./helpers.cjs')

/**
 * 收藏夹横条（M2 收藏夹第三轮）：工具栏下面那第三行。
 *
 * 三件事必须一起对，否则用户看到的就是"条画出来了、页面压在下面一截"：
 * 1. **显示规则**（`showsBookmarkBar()`）：仅新标签页 / 始终 / 从不；
 * 2. **页面视图的 y 坐标**：`40 + 44 + 32`（横条显示）或 `40 + 44`（隐藏）——
 *    这条由主进程按同一个纯函数算，用例直接量视图 bounds；
 * 3. **横条内容**：网址项点击导航当前标签、文件夹项打开收藏夹面板（锚在那颗按钮下）。
 *
 * 空态按 Edge（提示条 + 「立即管理收藏夹」），不是 Chrome 的"整条不占位"——
 * 产品裁决见 docs/reports/2026-11-26-bookmarks-store.md §1。
 */

const TAB = 41
const TOOLBAR = 46
const BAR = 34

const snapshot = (shell) => shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' }).then((result) => result.state))

/** 横条的 DOM 事实（显示没显示、有哪些项、哪些被挤掉）。 */
const barFacts = (shell) => shell.evaluate(() => {
  const bar = document.querySelector('.bookmark-bar')
  if (!bar) return { present: false, height: 0, items: [], overflow: false, hint: null }
  return {
    present: true,
    height: Math.round(bar.getBoundingClientRect().height),
    items: [...bar.querySelectorAll('.bar-item:not(.bar-overflow)')].map((el) => {
      const style = getComputedStyle(el)
      return {
        label: el.querySelector('.bar-label').textContent.trim(),
        folder: el.classList.contains('folder'),
        clipped: el.classList.contains('clipped'),
        // 尺寸照抄 Chromium 的 BookmarkButtonBase：高 28、最大宽 150、左右内距 6。
        height: Math.round(el.getBoundingClientRect().height),
        maxWidth: style.maxWidth,
        padding: style.padding,
        gap: style.gap,
        cursor: style.cursor
      }
    }),
    overflow: Boolean(bar.querySelector('.bar-overflow')),
    hint: bar.querySelector('.bar-hint')?.textContent.trim() ?? null
  }
})

/** 页面视图（外壳之外、非叠加层的那个 WebContentsView）的 bounds。 */
const pageBounds = (app) => app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()
    .find((item) => (item.webContents.getURL() ?? '').endsWith('index.html'))
  if (!win) return null
  const view = win.contentView.children
    .map((child) => ({ url: child.webContents?.getURL?.() ?? '', bounds: child.getBounds() }))
    .find((entry) => !entry.url.endsWith('index.html') && !entry.url.includes('baoOverlay=overlay'))
  return view ? view.bounds : null
})

/** 叠加层（飞窗）视图：挂着就是非 null，返回它的 bounds。 */
const overlayView = (app) => app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()
    .find((item) => (item.webContents.getURL() ?? '').endsWith('index.html'))
  const guest = win?.contentView.children
    .find((child) => (child.webContents?.getURL?.() ?? '').includes('baoOverlay=overlay'))
  return guest ? guest.getBounds() : null
})

/** 在叠加层文档里执行脚本（视图可能正在创建：重试一次）。 */
async function inOverlay(app, code) {
  let lastError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const id = await app.evaluate(({ webContents }) => {
        const target = webContents.getAllWebContents().find((contents) =>
          (contents.getURL() ?? '').includes('baoOverlay=overlay'))
        return target ? target.id : null
      })
      if (!id) throw new Error('叠加层文档还不存在')
      return await app.evaluate(async ({ webContents }, payload) => {
        const target = webContents.fromId(payload.id)
        if (!target || target.isDestroyed()) throw new Error('叠加层已销毁')
        return target.executeJavaScript(payload.code)
      }, { id, code })
    } catch (error) {
      lastError = error
      await new Promise((done) => setTimeout(done, 250))
    }
  }
  throw lastError
}

const pageTop = (app) => waitFor(async () => {
  const bounds = await pageBounds(app)
  return bounds ? bounds.y : null
}, { message: '拿不到页面视图的 y 坐标' })

async function openPage(shell, url, title) {
  const address = shell.getByRole('textbox', { name: '地址栏' })
  await address.fill(url)
  await address.press('Enter')
  await shell.getByRole('button', { name: title, exact: true }).waitFor({ timeout: 30_000 })
}

/**
 * 点星标收藏当前页，然后把编辑气泡收起来。
 *
 * 星标是**开关**（第二次点击只是收起气泡，见 `toggleBookmarkBubble`），所以收集完必须
 * 关掉气泡：否则后面点横条、填地址都会被那只飞窗挡住。
 */
async function bookmarkCurrentPage(shell) {
  await shell.locator('.address-bar .bookmark-star').click()
  await waitFor(async () => shell.evaluate(() =>
    document.querySelector('.address-bar .bookmark-star')?.classList.contains('bookmarked') === true),
  { message: '星标没有变成已收藏' })
  await shell.evaluate(() => {
    document.querySelector('.address-bar input')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  })
  await waitFor(async () => shell.evaluate(() =>
    document.querySelector('.address-bar .bookmark-star')?.getAttribute('aria-expanded') !== 'true'),
  { message: '编辑气泡没有收起' })
}

const run = (shell, command) => shell.evaluate((payload) => window.baoBrowser.run(payload), command)

test('收藏夹横条：显示规则、页面让位、点击导航', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({
    '/first': page('第一个收藏页'),
    '/second': page('第二个页面')
  })
  const { app, shell, close } = await launchApp()
  try {
    // ① 新标签页 + 默认档（仅新标签页）：横条在、32 高、空态是 Edge 的提示条，
    //    页面视图让开 40 + 44 + 32。
    await shell.waitForSelector('.bookmark-bar')
    assert.equal((await snapshot(shell)).settings.bookmarkBar, 'ntp',
      '默认档应是「仅在新标签页上显示」（对齐全家桶的产品裁决）')
    const empty = await barFacts(shell)
    assert.equal(empty.height, BAR, '横条高度应与主进程的 BOOKMARK_BAR_HEIGHT 一致')
    assert.deepEqual(empty.items, [])
    assert.match(empty.hint ?? '', /收藏/, `空态应给一行提示：${empty.hint}`)
    assert.equal(await pageTop(app), TAB + TOOLBAR + BAR, '横条显示时页面视图必须让开这一行')

    // ② 普通网页 + 默认档：横条整条不占位，页面视图回到 40 + 44。
    await openPage(shell, `${server.baseUrl}/first`, '第一个收藏页')
    await waitFor(async () => (await barFacts(shell)).present ? null : true,
      { message: '默认档下普通网页不该有横条' })
    assert.equal(await pageTop(app), TAB + TOOLBAR, '横条隐藏时页面视图应贴着工具栏下沿')

    // ③ 收藏当前页（星标落库）→ 横条仍然不出现（默认档只认新标签页）。
    await bookmarkCurrentPage(shell)
    assert.equal((await barFacts(shell)).present, false, '默认档下收藏一条网址不该让横条冒出来')

    // ④ 切到「始终显示」：横条出现在网页上，项就是刚收藏的那条，页面视图再次让位。
    const switched = await run(shell, { type: 'set-setting', key: 'bookmark.bar', value: 'always' })
    assert.equal(switched.ok, true, `写设置失败：${JSON.stringify(switched)}`)
    const always = await waitFor(async () => {
      const facts = await barFacts(shell)
      return facts.present ? facts : null
    }, { message: '「始终显示」后横条没有出现' })
    assert.deepEqual(always.items.map((item) => [item.label, item.folder]), [['第一个收藏页', false]])
    // 尺寸对齐 Chromium 的 BookmarkButtonBase（2026-11-26 反馈："高度矮了几px、会不会太宽"）。
    assert.equal(always.items[0].height, 28, '横条项高 28（BOOKMARK_BAR_BUTTON_HEIGHT）')
    assert.equal(always.items[0].maxWidth, '150px', '横条项最大宽 150（kMaxButtonWidth）')
    assert.equal(always.items[0].padding, '0px 6px', '左右内距 6（INSETS_BOOKMARKS_BAR_BUTTON）')
    assert.equal(always.items[0].gap, '6px', '图标与文字间距 6（BOOKMARK_BAR_BUTTON_IMAGE_LABEL_PADDING）')
    // 悬停已经有底色变化，不要再出手型（2026-11-26 反馈）。
    assert.equal(always.items[0].cursor, 'default', '横条项用默认箭头，不用手型')
    assert.equal(always.overflow, false, '放得下就不该出现「其余收藏」')
    assert.equal(await pageTop(app), TAB + TOOLBAR + BAR, '「始终显示」下页面视图同样要让位')

    // ⑤ 再收藏一条，点横条上的第一项 → 当前标签导航到它（地址取自库里，界面不传地址）。
    await openPage(shell, `${server.baseUrl}/second`, '第二个页面')
    await bookmarkCurrentPage(shell)
    await waitFor(async () => {
      const facts = await barFacts(shell)
      return facts.items.length === 2 ? facts : null
    }, { message: '第二条收藏没有进横条' })
    await shell.evaluate(() => {
      const item = [...document.querySelectorAll('.bookmark-bar .bar-item')]
        .find((el) => el.querySelector('.bar-label').textContent.trim() === '第一个收藏页')
      if (!item) throw new Error('横条上没有「第一个收藏页」')
      item.click()
    })
    await waitFor(async () => {
      const state = await snapshot(shell)
      const active = state.tabs.find((tab) => tab.id === state.activeId)
      return active?.address === `${server.baseUrl}/first` ? active : null
    }, { message: '点横条上的网址项没有导航' })

    // ⑥ 文件夹项：弹出的是**同一只飞窗**（与设置齿轮同一机制），锚在这颗按钮下沿。
    //
    // 2026-11-27 的反转：先做过一版原生 `Menu.popup`，实测它会浮在别的应用之上（独立顶层窗口，
    // 失去激活也不收），且主题/动画/点击外部收起都得另说一套。现在走飞窗 —— 用户在验收里
    // 直接点出来了："这个下拉实现方法不是和设置按钮展开一个实现方式吗"。
    await run(shell, { type: 'create-bookmark-folder', title: '常用站点', parentId: 'bar' })
    const withFolder = await waitFor(async () => {
      const facts = await barFacts(shell)
      return facts.items.some((item) => item.folder && item.label === '常用站点') ? facts : null
    }, { message: '新建的文件夹没有出现在横条上' })
    assert.equal(withFolder.items.at(-1).folder, true, '文件夹排在根层末尾')

    // 往里放一条**另一个**地址（这样点它能看出"导航了"，而不是停在原地）。
    await openPage(shell, `${server.baseUrl}/second`, '第二个页面')
    await bookmarkCurrentPage(shell)
    const folderNode = (await snapshot(shell)).bookmarks.find((node) => node.title === '常用站点')
    const secondNode = (await snapshot(shell)).bookmarks.find((node) => node.url === `${server.baseUrl}/second`)
    assert.ok(folderNode && secondNode)
    const moved = await run(shell, { type: 'update-bookmark', id: secondNode.id, parentId: folderNode.id })
    assert.equal(moved.ok, true, `把收藏移进文件夹失败：${JSON.stringify(moved)}`)
    // 回到 /first：这样点菜单里的那条才看得出"导航了"（否则本来就在 /second 上）。
    await openPage(shell, `${server.baseUrl}/first`, '第一个收藏页')

    const folderRect = await shell.evaluate(() => {
      const button = [...document.querySelectorAll('.bookmark-bar .bar-item')]
        .find((el) => el.querySelector('.bar-label').textContent.trim() === '常用站点')
      const rect = button.getBoundingClientRect()
      return { left: Math.round(rect.left), right: Math.round(rect.right), bottom: Math.round(rect.bottom) }
    })
    await shell.evaluate(() => {
      const button = [...document.querySelectorAll('.bookmark-bar .bar-item')]
        .find((el) => el.querySelector('.bar-label').textContent.trim() === '常用站点')
      button.click()
    })
    const menu = await waitFor(async () => {
      const view = await overlayView(app)
      if (!view) return null
      const rows = await inOverlay(app, `[...document.querySelectorAll('#bookmark-folder-menu .folder-row .row-title')].map((el) => el.textContent.trim())`)
      const title = await inOverlay(app, `document.querySelector('#bookmark-folder-menu .folder-title')?.textContent?.trim() ?? null`)
      return rows.length ? { rows, title, view } : null
    }, { message: '点横条文件夹后菜单没有打开' })
    assert.equal(menu.title, '常用站点', '菜单标题是被点开的那个文件夹')
    assert.deepEqual(menu.rows, ['第二个页面'], '菜单里是这个文件夹的直接子项')
    // 锚定：顶边贴着按钮下沿；宽度是菜单宽 + 两侧投影边距。
    const GUTTER = 6
    assert.equal(menu.view.y, folderRect.bottom, '菜单卡片顶边应贴着横条上那颗文件夹按钮的下沿')
    assert.equal(menu.view.width, 280 + 2 * GUTTER, '菜单宽 280（比面板窄，菜单行只有图标 + 标题）')
    // 横条上的按钮普遍靠左：右边放不下时改成左对齐（`flyoutBounds` 的 anchorLeft）。
    assert.equal(menu.view.x + GUTTER, folderRect.left, '右边放不下时菜单左缘贴住按钮左缘')

    // 点菜单里的一条：导航当前标签并收起菜单。
    await inOverlay(app, `document.querySelector('#bookmark-folder-menu .folder-row').click()`)
    await waitFor(async () => {
      const state = await snapshot(shell)
      const active = state.tabs.find((tab) => tab.id === state.activeId)
      return active?.address === `${server.baseUrl}/second` ? active : null
    }, { message: '点菜单里的收藏没有导航' })
    await waitFor(async () => (await overlayView(app)) ? null : true, { message: '导航后菜单没有收起' })

    // 同一个横条项再点一次 = 收起（与齿轮按钮同一套开关语义）。
    await shell.evaluate(() => {
      const button = [...document.querySelectorAll('.bookmark-bar .bar-item')]
        .find((el) => el.querySelector('.bar-label').textContent.trim() === '常用站点')
      button.click()
    })
    await waitFor(async () => (await overlayView(app)) ? true : null, { message: '再点文件夹没有打开菜单' })
    await shell.evaluate(() => {
      const button = [...document.querySelectorAll('.bookmark-bar .bar-item')]
        .find((el) => el.querySelector('.bar-label').textContent.trim() === '常用站点')
      button.click()
    })
    await waitFor(async () => (await overlayView(app)) ? null : true, { message: '再点一次没有收起菜单' })

    // 空文件夹也要给一句实话（不是弹个空菜单）。
    const emptyFolder = await run(shell, { type: 'create-bookmark-folder', title: '空文件夹', parentId: 'bar' })
    assert.equal(emptyFolder.ok, true)
    await waitFor(async () => {
      const facts = await barFacts(shell)
      return facts.items.some((item) => item.label === '空文件夹') ? facts : null
    }, { message: '空文件夹没有出现在横条上' })
    await shell.evaluate(() => {
      const button = [...document.querySelectorAll('.bookmark-bar .bar-item')]
        .find((el) => el.querySelector('.bar-label').textContent.trim() === '空文件夹')
      button.click()
    })
    const emptyMenu = await waitFor(async () => {
      if (!await overlayView(app)) return null
      const text = await inOverlay(app, `document.querySelector('#bookmark-folder-menu .overlay-empty')?.textContent?.trim() ?? null`)
      return text ? { text } : null
    }, { message: '空文件夹的菜单没有给空状态' })
    assert.match(emptyMenu.text, /空/)
    await shell.evaluate(() => {
      const input = document.querySelector('.address-bar input')
      input?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    await waitFor(async () => (await overlayView(app)) ? null : true, { message: '点外部没有收起菜单' })

    // ⑦ 「从不显示」：连新标签页也没有横条，页面视图回到 40 + 44。
    await shell.evaluate(() => {
      const input = document.querySelector('.address-bar input')
      input?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    await run(shell, { type: 'set-setting', key: 'bookmark.bar', value: 'never' })
    await waitFor(async () => (await barFacts(shell)).present ? null : true,
      { message: '「从不显示」后横条还在' })
    assert.equal(await pageTop(app), TAB + TOOLBAR, '「从不显示」下页面视图应贴着工具栏下沿')

    // ⑧ 设置页「外观 → 收藏夹栏」：三档都在，当前档是选中态；点一下立即生效。
    //    设置页是**独立的内部页视图**（`bao://settings`），要到那个 WebContents 里查 DOM。
    await run(shell, { type: 'open-settings' })
    const settingsId = await waitFor(async () => app.evaluate(({ webContents }) =>
      webContents.getAllWebContents()
        .find((contents) => (contents.getURL() ?? '').startsWith('bao://settings'))?.id ?? null),
    { message: '设置页没有打开' })
    const settingsEval = (code) => app.evaluate(async ({ webContents }, payload) => {
      const target = webContents.fromId(payload.id)
      if (!target) throw new Error('设置页已销毁')
      return target.executeJavaScript(payload.code)
    }, { id: settingsId, code })
    const choices = await waitFor(async () => {
      const value = await settingsEval(`(() => {
        const group = [...document.querySelectorAll('.choices')]
          .find((el) => el.getAttribute('aria-label') === '显示收藏夹栏')
        return group
          ? [...group.querySelectorAll('.choice')].map((el) => [el.textContent.trim(), el.getAttribute('aria-checked')])
          : null
      })()`)
      return value ?? null
    }, { message: '设置页没有「收藏夹栏」分区' })
    // 顺序 = 默认档排第一（此刻选中的是上一步刚设的「从不显示」）。
    assert.deepEqual(choices, [['仅在新标签页上显示', 'false'], ['始终显示', 'false'], ['从不显示', 'true']],
      '默认档必须排在第一行')
    await settingsEval(`[...document.querySelectorAll('.choices .choice')]
      .find((el) => el.textContent.trim() === '仅在新标签页上显示').click()`)
    await waitFor(async () => (await snapshot(shell)).settings.bookmarkBar === 'ntp' ? true : null,
      { message: '设置页选择没有写回「仅在新标签页上显示」' })
  } finally {
    await close()
    await server.close()
  }
})

test('收藏夹横条：从新标签页进网页时，横条等新页面提交才收', { timeout: 150_000 }, async () => {
  /**
   * 时序用例：用一个**慢**服务器（800 ms 才回 HTML）把"导航途中"那一段拉长。
   *
   * 规则来自 Chromium：`BookmarkBarController::DidFinishNavigation` 才
   * `UpdateBookmarkBarState(kTabState)`（`bookmark_bar_controller.cc:218`），也就是横条在
   * 新页面**提交**时才收。我们在导航开始就清了 `internal`，若不按住，用户看到的是
   * "横条先消失、页面区域先变白、然后页面才出现"。
   */
  const slow = createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(page('慢页面'))
    }, 800)
  })
  await new Promise((done) => slow.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${slow.address().port}`
  const { app, shell, close } = await launchApp()
  try {
    await shell.waitForSelector('.bookmark-bar')
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${origin}/slow`)
    await address.press('Enter')

    // 导航途中：反复采样 250 ms（远小于 800 ms 的响应延迟），横条与页面视图位置都不能动。
    for (let index = 0; index < 5; index += 1) {
      assert.equal((await barFacts(shell)).present, true,
        `导航途中横条收早了（第 ${index + 1} 次采样）——那会变成"先消失再跳转"`)
      assert.equal(await pageTop(app), TAB + TOOLBAR + BAR, '导航途中页面视图不该先让位')
      await new Promise((done) => setTimeout(done, 50))
    }

    // 新页面提交后：横条收掉、页面视图上移一行。
    await shell.getByRole('button', { name: '慢页面', exact: true }).waitFor({ timeout: 30_000 })
    await waitFor(async () => (await barFacts(shell)).present ? null : true,
      { message: '页面提交后横条没有收起来' })
    assert.equal(await pageTop(app), TAB + TOOLBAR, '页面提交后页面视图应让开横条那一行')
  } finally {
    await close()
    await new Promise((done) => slow.close(done))
  }
})

test('外壳 chrome：按钮统一用默认箭头（悬停已有底色变化）', { timeout: 120_000 }, async () => {
  const { app, shell, close } = await launchApp()
  try {
    await shell.waitForSelector('.bookmark-bar')
    const cursors = await shell.evaluate(() => {
      const read = (selector) => {
        const el = document.querySelector(selector)
        return el ? getComputedStyle(el).cursor : 'missing'
      }
      return {
        tabClose: read('.tab .close-tab'),
        addTab: read('.add-tab'),
        back: read('.toolbar .icon-button'),
        bookmarks: read('.bookmarks-button'),
        gear: read('.gear-button')
      }
    })
    assert.deepEqual(cursors, {
      tabClose: 'default',
      addTab: 'default',
      back: 'default',
      bookmarks: 'default',
      gear: 'default'
    }, '标签页 × / + 与工具栏按钮都不该出手型')
  } finally {
    await close()
  }
})

test('收藏夹横条：显示档位跨重启保留', { timeout: 120_000 }, async () => {
  const server = await startFixtureServer({ '/kept': page('收藏过的一页') })
  const profilePath = await mkdtemp(join(tmpdir(), 'bao-next-bar-'))
  try {
    const first = await launchAppAt(profilePath)
    try {
      await openPage(first.shell, `${server.baseUrl}/kept`, '收藏过的一页')
      await first.shell.locator('.address-bar .bookmark-star').click()
      await waitFor(async () => {
        const state = await snapshot(first.shell)
        return state.bookmarks.some((node) => node.kind === 'url') ? true : null
      }, { message: '收藏没有落库' })
      const written = await run(first.shell, { type: 'set-setting', key: 'bookmark.bar', value: 'always' })
      assert.equal(written.ok, true)
    } finally {
      await first.close()
    }

    const second = await launchAppAt(profilePath)
    try {
      // 「始终显示」跨重启生效：新标签页与网页上都该有横条，项还是那条收藏。
      const facts = await waitFor(async () => {
        const bar = await barFacts(second.shell)
        return bar.present ? bar : null
      }, { message: '重启后横条没有按「始终显示」出现' })
      assert.deepEqual(facts.items.map((item) => item.label), ['收藏过的一页'])
      assert.equal((await snapshot(second.shell)).settings.bookmarkBar, 'always')
    } finally {
      await second.close()
    }
  } finally {
    await rm(profilePath, { recursive: true, force: true, maxRetries: 3 })
    await server.close()
  }
})
