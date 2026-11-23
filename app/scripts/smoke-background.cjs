const { spawnSync } = require('node:child_process')

/**
 * 后台跑完整冒烟：`npm run smoke:bg`。
 *
 * 与 `npm run smoke` 跑同一套用例，区别是给应用设 `BAO_SMOKE_BACKGROUND=1`：
 * 窗口被移到屏幕外、`showInactive()` 且 `focusable: false`（被激活就立刻让出），
 * 所以**屏幕上不出现、也不抢前台焦点**，但仍然是"可见窗口"，渲染与 Ruffle 出帧不受节流。
 *
 * 覆盖差异只有一条：`permissions` 里 pointerLock/fullscreen 的用户激活拿不到，
 * 该用例会跳过并说明原因（前台 `npm run smoke` 仍然全量跑）。
 *
 * 另有一个更极端的档 `BAO_SMOKE_HIDDEN=1`：窗口完全不 show。它更安静，但实测 Ruffle
 * 出帧会被节流（`ruffle-input` 失败），不建议作为常规跑法。
 */
const result = spawnSync('npm', ['run', 'smoke'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, BAO_SMOKE_BACKGROUND: '1' }
})

if (result.error) {
  console.error('后台冒烟启动失败。', result.error)
  process.exit(1)
}
process.exit(result.status ?? 1)
