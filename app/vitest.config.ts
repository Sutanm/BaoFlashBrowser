import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * 单元层：不启动 Electron、不建窗口，纯逻辑用毫秒级用例覆盖。
 *
 * 这里把 `electron` 别名到一个桩，唯一目的是让 `src/main/internal-pages.ts`
 * 这类「纯解析逻辑 + 顶部 import 了 electron」的模块能在 Node 里被导入；
 * 它用到的 `protocol` 只会在绑定 handler 时调用，单元用例不会碰。
 */
export default defineConfig({
  resolve: {
    alias: {
      electron: resolve(__dirname, 'tests/unit/stubs/electron.ts')
    }
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    pool: 'threads',
    reporters: ['default']
  }
})
