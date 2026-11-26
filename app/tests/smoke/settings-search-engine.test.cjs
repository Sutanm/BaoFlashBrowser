const assert = require('node:assert/strict')
const { test } = require('node:test')
const { launchApp, waitFor } = require('./helpers.cjs')

/**
 * 设置页「隐私、搜索和服务 → 搜索引擎」：**下拉框**（2026-11-26 反馈）。
 *
 * 之前是竖排单选，六项铺成六行、占掉半屏却没有信息量；现在是一个下拉框，
 * **当前选中的排第一行**（打开就能看见"现在选的是谁"），并且底部的说明文字去掉了。
 * 键盘要能走完（↓ 打开、↑↓ 移动、Enter 选、Esc 收起并还焦点）。
 */
test('设置页：搜索引擎是下拉框，当前项排第一行', { timeout: 150_000 }, async () => {
  const { app, shell, close } = await launchApp()
  try {
    await shell.evaluate(() => window.baoBrowser.run({ type: 'open-settings' }))
    const settingsId = await waitFor(async () => app.evaluate(({ webContents }) =>
      webContents.getAllWebContents()
        .find((contents) => (contents.getURL() ?? '').startsWith('bao://settings'))?.id ?? null),
    { message: '设置页没有打开' })
    const inPage = (code) => app.evaluate(({ webContents }, payload) => {
      const target = webContents.fromId(payload.id)
      if (!target) throw new Error('设置页已销毁')
      return target.executeJavaScript(payload.code)
    }, { id: settingsId, code })

    // 切到「隐私、搜索和服务」分区。
    await inPage(`[...document.querySelectorAll('.settings-nav button')]
      .find((el) => el.textContent.trim() === '隐私、搜索和服务').click()`)
    const trigger = await waitFor(async () => {
      const value = await inPage(`document.querySelector('.engine-trigger')?.textContent.trim() ?? null`)
      return value ?? null
    }, { message: '没有找到搜索引擎下拉框' })
    assert.match(trigger, /必应/, `默认应显示必应：${trigger}`)

    // 竖排单选与那句说明文字都不该再出现。
    const leftovers = await inPage(`({
      radios: document.querySelectorAll('[role="radiogroup"][aria-label="搜索引擎"]').length,
      caption: [...document.querySelectorAll('.setting-card .lead, .setting-card .section-caption')]
        .some((el) => el.textContent.includes('输入带点号的网址'))
    })`)
    assert.equal(leftovers.radios, 0, '搜索引擎不该还是竖排单选')
    assert.equal(leftovers.caption, false, '那句话说明文字应当去掉')

    // 展开：当前项排第一行且是选中态。
    await inPage(`document.querySelector('.engine-trigger').click()`)
    const menu = await waitFor(async () => {
      const value = await inPage(`(() => {
        const options = [...document.querySelectorAll('.engine-menu .engine-option')]
        if (options.length === 0) return null
        return options.map((el) => ({
          label: el.querySelector('.label').textContent.trim(),
          selected: el.getAttribute('aria-selected') === 'true',
          checked: Boolean(el.querySelector('.engine-check .shell-icon'))
        }))
      })()`)
      return value ?? null
    }, { message: '下拉没有展开' })
    assert.deepEqual(menu.map((option) => option.label), ['必应', '百度', 'Google'],
      '当前选中的应排第一行，其余按目录顺序')
    assert.equal(menu[0].selected, true)
    assert.equal(menu[0].checked, true, '当前项应打勾')

    // 触发按钮的宽度由**最长的引擎名**撑开（Edge 的做法），这样切换选项时按钮不会跳；
    // 菜单按「最长的引擎名 + 自己那一档内距（勾选列）」算——**绝不截字**
    // （2026-11-26 第二轮反馈：菜单硬对齐按钮宽度，Google 显示成「Go…」）。
    const widths = await inPage(`(() => {
      const trigger = document.querySelector('.engine-trigger')
      const label = document.querySelector('.engine-trigger-label')
      const menu = document.querySelector('.engine-menu')
      const options = [...document.querySelectorAll('.engine-menu .engine-option .label')]
      const widest = [...document.querySelectorAll('.engine-trigger-sizer > span')]
        .reduce((max, el) => Math.max(max, Math.ceil(el.getBoundingClientRect().width)), 0)
      return {
        trigger: Math.round(trigger.getBoundingClientRect().width),
        menu: Math.round(menu.getBoundingClientRect().width),
        labelClipped: label.scrollWidth > label.clientWidth + 1,
        clipped: options
          .filter((el) => el.scrollWidth > el.clientWidth + 1)
          .map((el) => el.textContent.trim()),
        widest
      }
    })()`)
    assert.deepEqual(widths.clipped, [],
      `下拉里的引擎名不该被截断（可用宽度不够：${JSON.stringify(widths)}）`)
    assert.equal(widths.labelClipped, false, '按钮里的引擎名不该被截断')
    assert.ok(widths.widest > 20, `量不到最宽引擎名的宽度（${widths.widest}）——分区隐藏时量出来是 0`)
    assert.ok(widths.trigger >= widths.widest,
      `按钮要容得下最长的引擎名（按钮 ${widths.trigger} < 最长 ${widths.widest}）`)
    assert.ok(widths.menu >= widths.trigger - 1,
      `菜单不该比触发按钮窄（按钮 ${widths.trigger}、菜单 ${widths.menu}）`)
    // 只该多出勾选列那一档（14 + 8）：再多就是两块东西不像一套。
    assert.ok(widths.menu <= widths.trigger + 20,
      `菜单比按钮宽太多（按钮 ${widths.trigger}、菜单 ${widths.menu}）`)
    // 贴着内容：按钮不该比"最长引擎名 + 内距 + 箭头"宽出一大截（2026-11-26 反馈"太空旷"）。
    assert.ok(widths.trigger <= widths.widest + 60,
      `按钮不该留大片空白（按钮 ${widths.trigger}、最长引擎名 ${widths.widest}）`)

    // 切到最长的「Google」：按钮自己也不能把它截断。
    await inPage(`[...document.querySelectorAll('.engine-menu .engine-option')]
      .find((el) => el.querySelector('.label').textContent.trim() === 'Google').click()`)
    const google = await waitFor(async () => {
      const value = await inPage(`(() => {
        const label = document.querySelector('.engine-trigger .engine-trigger-label')
        if (!label || label.textContent.trim() !== 'Google') return null
        return {
          clipped: label.scrollWidth > label.clientWidth + 1,
          width: Math.round(label.getBoundingClientRect().width)
        }
      })()`)
      return value ?? null
    }, { message: '触发按钮没有切到 Google' })
    assert.equal(google.clipped, false, `按钮里的 Google 被截断了（只有 ${google.width}px）`)
    await inPage(`document.querySelector('.engine-trigger').click()`)

    // 选百度：写库、收起、触发按钮跟着变；再打开时百度排第一。
    await inPage(`[...document.querySelectorAll('.engine-menu .engine-option')]
      .find((el) => el.querySelector('.label').textContent.trim() === '百度').click()`)
    await waitFor(async () => {
      const state = await shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' }).then((result) => result.state))
      return state.settings.searchEngine === 'baidu' ? state : null
    }, { message: '选百度没有写进设置' })
    assert.equal(await inPage(`document.querySelector('.engine-menu') === null`), true, '选完应收起下拉')
    const after = await waitFor(async () => {
      const value = await inPage(`document.querySelector('.engine-trigger .engine-trigger-label')?.textContent.trim() ?? null`)
      return value === '百度' ? value : null
    }, { message: '触发按钮没有跟着变' })
    assert.equal(after, '百度')

    await inPage(`document.querySelector('.engine-trigger').click()`)
    const reordered = await waitFor(async () => {
      const value = await inPage(`[...document.querySelectorAll('.engine-menu .engine-option .label')]
        .map((el) => el.textContent.trim())`)
      return value?.length ? value : null
    }, { message: '下拉没有再次展开' })
    assert.deepEqual(reordered, ['百度', '必应', 'Google'], '选中的排第一')

    // Esc 收起并把焦点还给触发按钮。
    await inPage(`document.querySelector('.engine-menu .engine-option.active')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      || document.querySelector('.engine-menu')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await waitFor(async () => {
      const closed = await inPage(`document.querySelector('.engine-menu') === null`)
      return closed ? true : null
    }, { message: 'Esc 没有收下拉' })
  } finally {
    await close()
  }
})
