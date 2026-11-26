const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
  internalEval, internalUrlOf, launchApp, overlayEval, page, pageViewBounds, startFixtureServer, waitFor
} = require('./helpers.cjs')

/**
 * 收藏夹管理页（`bao://favorites`）的合同验证。
 *
 * 为什么是**独立标签页**：`chrome://bookmarks` 在 Chromium 里就是独立 WebUI
 * （`chrome/browser/ui/webui/bookmarks/bookmarks_ui.cc`），要摆下「文件夹树 + 条目列表 +
 * 工具栏」三块；飞窗卡片只有 264 宽（`shared/overlay-geometry.ts`）。
 *
 * 交互口径（都能在源码里对上）：
 * - 单击只选中、**双击**才打开，且打开是**新前台标签页**
 *   （`chrome/browser/resources/bookmarks/command_manager.ts:556-558`）；
 * - 改名是行内输入框：Enter/失焦提交、Esc 取消（Chromium 用对话框，我们没那个对话框）；
 * - 删带子项的文件夹先确认（我们没有 Ctrl+Z 撤销）；
 * - 管理页拿不到外壳桥（`window.baoBrowser` 不存在），因此也只能做它那几条窄命令。
 */

const FAV = 'bao://favorites/'
/** 管理页的视图顶边：标签栏 41 + 工具栏 46（`shared/browser.ts` 的常量；横条在内部页不显示）。 */
const PAGE_TOP = 87

const snapshot = (shell) => shell.evaluate(() =>
  window.baoBrowser.run({ type: 'snapshot' }).then((result) => result.state))

/** 管理页 DOM 的全部事实（一次取完，避免"两次采样差一帧"）。 */
const favFacts = (app) => internalEval(app, FAV, `(() => {
  const box = (selector) => {
    const element = document.querySelector(selector)
    if (!element) return null
    const rect = element.getBoundingClientRect()
    return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
  }
  return {
    title: document.title,
    bridge: typeof window.baoFavorites,
    shellBridge: typeof window.baoBrowser,
    overlayBridge: typeof window.baoOverlay,
    theme: document.documentElement.dataset.theme,
    toolbar: box('.fav-toolbar'),
    tree: box('.fav-tree'),
    list: box('.fav-list'),
    firstRow: box('.fav-row'),
    treeLabels: [...document.querySelectorAll('.tree-label')].map((el) => el.textContent.trim()),
    rows: [...document.querySelectorAll('.fav-row')].map((el) => ({
      id: el.dataset.bookmarkId,
      kind: el.dataset.kind,
      title: el.querySelector('.row-title')?.textContent.trim() ?? null,
      meta: el.querySelector('.row-meta')?.textContent.trim() ?? null,
      selected: el.classList.contains('selected')
    })),
    heading: document.querySelector('.fav-heading')?.textContent.trim() ?? null,
    empty: document.querySelector('.fav-empty')?.textContent.trim() ?? null,
    confirm: document.querySelector('.fav-confirm')?.textContent.trim() ?? null,
    status: document.querySelector('.fav-status')?.textContent.trim() ?? null,
    editing: document.querySelector('.tree-input, .row-input')?.value ?? null,
    selectedTree: document.querySelector('.tree-row.selected')?.dataset.bookmarkId ?? null,
    disabled: {
      newFolder: Boolean(document.querySelector('.fav-new-folder')?.disabled),
      rename: Boolean(document.querySelector('.fav-rename')?.disabled),
      remove: Boolean(document.querySelector('.fav-remove')?.disabled)
    },
    buttons: [...document.querySelectorAll('.fav-action')].map((el) => el.textContent.trim())
  }
})()`)

/** 按选择器点管理页里的按钮（找不到就报错，不静默通过）。 */
const clickFav = (app, selector) => internalEval(app, FAV, `(() => {
  const element = document.querySelector(${JSON.stringify(selector)})
  if (!element) throw new Error('管理页里没有这个元素：' + ${JSON.stringify(selector)})
  element.click()
  return true
})()`)

/** 按可见文字点（树行/列表行用；行里没有其它文字，箭头是 svg）。 */
const clickFavText = (app, scope, text) => internalEval(app, FAV, `(() => {
  const element = [...document.querySelectorAll(${JSON.stringify(scope)})]
    .find((item) => item.textContent.trim() === ${JSON.stringify(text)})
  if (!element) throw new Error('管理页里没有这一行：' + ${JSON.stringify(text)})
  element.click()
  return true
})()`)

/** 在输入框里输入（走真实 v-model 的 input 事件），可选回车提交。 */
const typeFav = (app, selector, value, submit = true) => internalEval(app, FAV, `(() => {
  const field = document.querySelector(${JSON.stringify(selector)})
  if (!field) throw new Error('管理页里没有输入框：' + ${JSON.stringify(selector)})
  field.focus()
  field.value = ${JSON.stringify(value)}
  field.dispatchEvent(new Event('input', { bubbles: true }))
  if (${submit ? 'true' : 'false'}) {
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  }
  return true
})()`)

/** 双击一行（Chromium 的"打开"手势）。 */
const doubleClickFavText = (app, scope, text) => internalEval(app, FAV, `(() => {
  const element = [...document.querySelectorAll(${JSON.stringify(scope)})]
    .find((item) => item.textContent.trim().includes(${JSON.stringify(text)}))
  if (!element) throw new Error('管理页里没有这一行：' + ${JSON.stringify(text)})
  element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  return true
})()`)

/** 在收藏夹栏里收藏一个地址（复用主进程的 bookmark-page，效果与点星标一致）。 */
async function bookmarkPage(shell, url) {
  await shell.evaluate((address) => window.baoBrowser.run({ type: 'navigate', address }), url)
  await waitFor(async () => {
    const state = await snapshot(shell)
    const active = state.tabs.find((tab) => tab.id === state.activeId)
    return active && active.address === url && !active.loading ? active : null
  }, { message: `页面没有加载完成：${url}` })
  const result = await shell.evaluate(() => window.baoBrowser.run({ type: 'bookmark-page' }))
  assert.equal(result.ok, true, `收藏失败：${JSON.stringify(result)}`)
  return waitFor(async () => {
    const state = await snapshot(shell)
    return state.bookmarks.find((node) => node.url === url) ?? null
  }, { message: `收藏没有落库：${url}` })
}

/**
 * 等管理页**真的就绪**：URL 对上只是文档开始加载，DOM 与桥可能还没到。
 * 先等 URL、再等工具栏与 `baoFavorites` 都在，后面的点击/读取才不会打在加载中的文档上。
 */
const waitForFavorites = (app) => waitFor(async () => {
  const url = await internalUrlOf(app, FAV)
  if (!url) return null
  const ready = await internalEval(app, FAV, `Boolean(window.baoFavorites && document.querySelector('.fav-toolbar'))`)
    .catch(() => false)
  return ready ? url : null
}, { message: '收藏夹管理页没有打开（或 DOM 没就绪）' })

test('收藏夹管理页：从横条空态打开，树/列表/只读边界都对', { timeout: 180_000 }, async () => {
  const { app, shell, close } = await launchApp()
  try {
    /*
     * ① 入口：收藏夹栏空着时横条上的「立即管理收藏夹」直接开管理页（不是打开飞窗）。
     * 这条要求是"画出来必须能点"：按钮旁边就是空态提示，点它却弹一个只能浏览的小面板，
     * 用户就得多点一次才能整理。
     */
    const hint = shell.locator('.bar-hint-action')
    await hint.waitFor({ timeout: 20_000 })
    assert.equal((await hint.textContent()).trim(), '立即管理收藏夹')
    await hint.click()
    await waitForFavorites(app)

    // ② 是独立标签页，标题「收藏夹」；视图顶边压在被让开的位置（标签栏+工具栏 = 87）。
    await waitFor(async () => {
      const labels = await shell.evaluate(() =>
        [...document.querySelectorAll('.tab')].map((el) => el.textContent.trim()))
      return labels.some((label) => label.includes('收藏夹')) ? labels : null
    }, { message: '标签栏里没有出现「收藏夹」' })
    const bounds = await pageViewBounds(app)
    assert.equal(bounds.y, PAGE_TOP, '管理页视图的顶边应在工具栏下方')
    assert.equal(bounds.x, 0)
    assert.ok(bounds.height > 400, `视图高度异常：${JSON.stringify(bounds)}`)

    const facts = await favFacts(app)
    // ③ 只读边界：内部页只有自己的窄桥，没有外壳桥（也没有叠加层桥）。
    assert.equal(facts.bridge, 'object', '管理页应拿到 baoFavorites')
    assert.equal(facts.shellBridge, 'undefined', '管理页拿不到 baoBrowser（与设置页同一条边界）')
    assert.equal(facts.overlayBridge, 'undefined', '管理页拿不到 baoOverlay')
    assert.equal(facts.title, '收藏夹')
    assert.ok(facts.theme === 'light' || facts.theme === 'dark', `主题标记异常：${facts.theme}`)

    // ④ 布局：工具栏 48、左树 232、行高 40（尺寸都来自 tokens，不另立一套）。
    assert.equal(facts.toolbar.h, 48)
    assert.equal(facts.tree.w, 232)
    assert.equal(facts.list.x, 232, '列表紧贴左树（工具栏与内容同一张面）')
    assert.deepEqual(facts.buttons, ['新建文件夹', '重命名', '删除'])

    // ⑤ 空收藏夹：两个永久根都在树里，列表是空状态，按钮该禁用的都禁用。
    assert.deepEqual(facts.treeLabels, ['收藏夹栏', '其他收藏夹'])
    assert.deepEqual(facts.rows, [])
    assert.match(facts.empty ?? '', /还没有收藏/)
    assert.equal(facts.disabled.newFolder, false, '空收藏夹也能建文件夹')
    assert.equal(facts.disabled.rename, false, '选中的是「收藏夹栏」根，可以改名')
    assert.equal(facts.disabled.remove, true, '永久根不能删：删除必须禁用而不是点了没反应')
  } finally {
    await close()
  }
})

test('收藏夹管理页：新建 / 改名 / 删除文件夹（带子项先确认）', { timeout: 180_000 }, async () => {
  const { app, shell, close } = await launchApp()
  try {
    // 当前是新标签页：打开管理页应当**就地覆盖**，不多开一个标签（Chromium 的单例语义）。
    const before = (await snapshot(shell)).tabs.length
    const opened = await shell.evaluate(() => window.baoBrowser.run({ type: 'open-favorites' }))
    assert.equal(opened.ok, true)
    assert.equal((await snapshot(shell)).tabs.length, before, '新标签页上打开管理页应就地覆盖，而不是新开标签')
    await waitForFavorites(app)

    // ① 新建文件夹：建完立刻进入改名态（Edge 的「新建文件夹」就是这样）。
    await clickFav(app, '.fav-new-folder')
    const created = await waitFor(async () => {
      const facts = await favFacts(app)
      return facts.editing ? facts : null
    }, { message: '新建文件夹后没有进入改名态（画一个输入框却没聚焦，等于假控件）' })
    assert.equal(created.editing, '新建文件夹', '默认名字与 Edge 一致')
    await typeFav(app, '.tree-input, .row-input', '技术')
    const renamed = await waitFor(async () => {
      const state = await snapshot(shell)
      const folder = state.bookmarks.find((node) => node.kind === 'folder' && node.title === '技术')
      return folder ?? null
    }, { message: '改名没有落库' })
    assert.equal(renamed.parentId, 'bar', '在「收藏夹栏」下新建，就该进收藏夹栏')

    // ② 树里选中它，再在它里面建子文件夹（父节点来自当前浏览的文件夹）。
    await clickFavText(app, '.tree-row', '技术')
    await clickFav(app, '.fav-new-folder')
    await waitFor(async () => (await favFacts(app)).editing ? true : null, { message: '没有进入改名态' })
    await typeFav(app, '.tree-input, .row-input', '前端')
    const nested = await waitFor(async () => {
      const state = await snapshot(shell)
      const folder = state.bookmarks.find((node) => node.kind === 'folder' && node.title === '前端')
      return folder ?? null
    }, { message: '子文件夹没有落库' })
    assert.equal(nested.parentId, renamed.id, '子文件夹应挂在「技术」下面')

    // ③ 空文件夹直接删（没有子项就没有确认条）。
    // 「前端」此刻在列表里（当前浏览的是「技术」），树的「技术」还没展开——按 id 点最稳。
    await clickFav(app, `.fav-row[data-bookmark-id="${nested.id}"]`)
    await clickFav(app, '.fav-remove')
    const goneEmpty = await waitFor(async () => {
      const state = await snapshot(shell)
      return state.bookmarks.some((node) => node.title === '前端') ? null : true
    }, { message: '空文件夹没有删掉' })
    assert.equal(goneEmpty, true)
    assert.equal((await favFacts(app)).confirm, null, '空文件夹不该弹确认')

    // ④ 带子项的文件夹：先确认，取消不写库。
    await clickFavText(app, '.tree-row', '技术')
    await clickFav(app, '.fav-new-folder')
    await waitFor(async () => (await favFacts(app)).editing ? true : null, { message: '没有进入改名态' })
    await typeFav(app, '.tree-input, .row-input', '工具')
    await waitFor(async () => {
      const state = await snapshot(shell)
      return state.bookmarks.some((node) => node.id !== renamed.id && node.parentId === renamed.id) ? true : null
    }, { message: '子文件夹没有落库' })
    await clickFavText(app, '.tree-row', '技术')
    await clickFav(app, '.fav-remove')
    const confirm = await waitFor(async () => {
      const facts = await favFacts(app)
      return facts.confirm ? facts : null
    }, { message: '删带子项的文件夹没有确认条（我们没有撤销，删了就找不回来）' })
    assert.match(confirm.confirm ?? '', /技术/)
    assert.match(confirm.confirm ?? '', /1 项/)
    await clickFav(app, '.fav-confirm-no')
    await waitFor(async () => (await favFacts(app)).confirm === null ? true : null, { message: '取消后确认条没有收起' })
    let state = await snapshot(shell)
    assert.ok(state.bookmarks.some((node) => node.id === renamed.id), '点「取消」不该删掉文件夹')

    // ⑤ 再来一次，这回确认：整棵子树一起消失。
    await clickFav(app, '.fav-remove')
    await waitFor(async () => (await favFacts(app)).confirm ? true : null, { message: '确认条没有再次出现' })
    await clickFav(app, '.fav-confirm-yes')
    const cleared = await waitFor(async () => {
      const current = await snapshot(shell)
      return current.bookmarks.some((node) => node.title === '技术' || node.title === '工具') ? null : current
    }, { message: '确认删除后子树仍在库里' })
    assert.equal(cleared.bookmarks.filter((node) => node.kind === 'folder').length, 2,
      '删完只剩两个永久根')
    // 树回到只有两个根：数据没了，界面不能还挂着已经不存在的行。
    const after = await waitFor(async () => {
      const facts = await favFacts(app)
      return facts.treeLabels.length === 2 ? facts : null
    }, { message: '树里还留着已删除的文件夹' })
    assert.deepEqual(after.treeLabels, ['收藏夹栏', '其他收藏夹'])
  } finally {
    await close()
  }
})

test('收藏夹管理页：双击在新标签打开、搜索过滤、飞窗底部入口', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({
    '/alpha': page('Alpha 页面'),
    '/beta': page('Beta 页面')
  })
  const { app, shell, close } = await launchApp()
  try {
    const first = await bookmarkPage(shell, `${server.baseUrl}/alpha`)
    await bookmarkPage(shell, `${server.baseUrl}/beta`)
    await shell.evaluate(() => window.baoBrowser.run({ type: 'open-favorites' }))
    await waitForFavorites(app)

    // 飞窗底部也有入口：面板只做浏览，整理在管理页（这里验证它能点、点了能到）。
    await shell.locator('.bookmarks-button').click()
    await waitFor(async () => (await overlayEval(app, `(() => {
      const button = document.querySelector('.hub-manage')
      return button ? button.textContent.trim() : null
    })()`)) === '管理收藏夹' ? true : null, { message: '收藏夹飞窗底部没有「管理收藏夹」' })
    await overlayEval(app, `document.querySelector('.hub-manage').click()`)
    // 已经有管理页标签：单例语义下切过去，不新开。
    const tabsBefore = (await snapshot(shell)).tabs.length
    await waitFor(async () => {
      const state = await snapshot(shell)
      const active = state.tabs.find((tab) => tab.id === state.activeId)
      return active?.internal === 'favorites' ? active : null
    }, { message: '飞窗里的「管理收藏夹」没有把管理页带到前台' })
    assert.equal((await snapshot(shell)).tabs.length, tabsBefore, '管理页是单例：不该多开一个')

    // ① 双击 = 新前台标签（Chromium 的 Command.OPEN）。
    const rows = (await favFacts(app)).rows
    assert.equal(rows.length, 2, `收藏夹栏应有两条：${JSON.stringify(rows)}`)
    assert.equal(rows[0].title, 'Alpha 页面')
    assert.equal(rows[0].meta, `${server.baseUrl}/alpha`, '列表右侧显示地址（不是空列）')
    const tabCountBefore = (await snapshot(shell)).tabs.length
    await doubleClickFavText(app, '.fav-row', 'Alpha 页面')
    const opened = await waitFor(async () => {
      const state = await snapshot(shell)
      const active = state.tabs.find((tab) => tab.id === state.activeId)
      return active?.address === `${server.baseUrl}/alpha` ? state : null
    }, { message: '双击收藏没有在新标签里打开' })
    assert.equal(opened.tabs.length, tabCountBefore + 1, '双击应新开一个标签，而不是把管理页顶掉')
    assert.ok(opened.tabs.some((tab) => tab.internal === 'favorites'), '管理页标签应当还在（Chromium 同样保留）')
    assert.ok(await internalUrlOf(app, FAV), '管理页文档不该被销毁')

    // ② 搜索：标题与地址都参与，结果是跨文件夹的平铺列表（右侧显示所属文件夹路径）。
    await shell.evaluate(() => window.baoBrowser.run({ type: 'open-favorites' }))
    await clickFav(app, '.fav-search-input')
    await typeFav(app, '.fav-search-input', 'beta', false)
    const searched = await waitFor(async () => {
      const facts = await favFacts(app)
      return facts.rows.length === 1 ? facts : null
    }, { message: '搜索没有过滤出唯一一条' })
    assert.equal(searched.rows[0].title, 'Beta 页面')
    assert.match(searched.heading ?? '', /搜索「beta」/)
    // 清空搜索：回到当前文件夹的完整列表。
    await typeFav(app, '.fav-search-input', '', false)
    await waitFor(async () => (await favFacts(app)).rows.length === 2 ? true : null,
      { message: '清空搜索后列表没有恢复' })

    // ③ 状态区没有报错（有错就说明命令被拒了）。
    assert.equal((await favFacts(app)).status, '', '正常操作不该在状态区留错误')
    assert.ok(first.id)
  } finally {
    await close()
    await server.close()
  }
})
