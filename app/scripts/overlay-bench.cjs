/* 叠加层打开耗时基线：真实窗口、鼠标点击，快开（预热未完成）/ 温开 两组分开统计。
   属于度量脚本，不是测试：用于决定「悬停预热」是否值得。 */
const { launchApp } = require('../tests/smoke/helpers.cjs')

const CYCLES = Number(process.env.BAO_BENCH_CYCLES ?? 8)

const read = (shell) => shell.evaluate(() => window.baoOverlay.readMetrics())
const clickGear = (shell) => shell.getByRole('button', { name: '快捷设置', exact: true }).click()
const wait = (ms) => new Promise((done) => setTimeout(done, ms))

function line(label, payload) {
  console.log(`${label} summary=${JSON.stringify(payload.summary)}`)
  console.log(`${label} samples=${JSON.stringify(payload.samples.map((s) => [s.state, s.visible, s.content ?? -1]))}`)
}

;(async () => {
  const { shell, close } = await launchApp()
  try {
    // ① 快开：窗口刚出现就点，视图多半还在创建（warming）或刚好就绪（warm）
    await clickGear(shell)
    await wait(700)
    await clickGear(shell)
    await wait(400)
    line('early', await read(shell))

    // ② 温开：预热完成后连续开关
    await wait(2500)
    await shell.evaluate(() => window.baoOverlay.resetMetrics())
    for (let index = 0; index < CYCLES; index += 1) {
      await clickGear(shell)
      await wait(600)
      await clickGear(shell)
      await wait(400)
    }
    line('warm', await read(shell))
  } finally {
    await close()
  }
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
