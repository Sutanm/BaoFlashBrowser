import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {},
  preload: {
    build: {
      rollupOptions: {
        input: {
          // 外壳 preload（受信任 UI）、页面 preload（Ruffle 引擎）、弹窗 chrome preload 分开打包。
          index: resolve(__dirname, 'src/preload/index.ts'),
          page: resolve(__dirname, 'src/preload/page.ts'),
          'popup-chrome': resolve(__dirname, 'src/preload/popup-chrome.ts')
        }
      }
    }
  },
  renderer: {
    plugins: [vue()]
  }
})
