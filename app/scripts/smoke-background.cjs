const { spawnSync } = require('node:child_process')

/**
 * 后台跑完整冒烟：`npm run smoke:bg`。
 *
 * 做法对齐老项目（BaoFlashBrowser）的测试形态：**默认 `show: false` 的隐藏窗口** +
 * `webContents.executeJavaScript` 断言，屏幕上根本不出现窗口；控制台窗口也被
 * `windowsHide` 压掉。产品侧还有「后台窗口永不抢前台」的焦点闸门（见
 * `browser-window.ts` 的 `focusContents()`），所以即使某条用例需要显示窗口，
 * 也不会把前台焦点抢走。
 *
 * 唯一覆盖差异：Ruffle 的输入用例需要真实合成帧（隐藏窗口里播放器报 unavailable），
 * 在后台模式下显式跳过并说明原因；前台 `npm run smoke` 仍全量跑。
 */
const result = spawnSync('npm', ['run', 'smoke'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  // 关键：没有这个标志时，`shell: true` 会为 cmd.exe 分配一个**可见的控制台窗口**，
  // 在隐藏宿主里跑测试时就是那句"命令行跳出来抢前台"。
  windowsHide: true,
  env: { ...process.env, BAO_SMOKE_HIDDEN: '1' }
})

if (result.error) {
  console.error('后台冒烟启动失败。', result.error)
  process.exit(1)
}
process.exit(result.status ?? 1)
