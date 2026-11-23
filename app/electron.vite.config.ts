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
          'popup-chrome': resolve(__dirname, 'src/preload/popup-chrome.ts'),
          // 内部设置页（bao://settings）只拿得到设置桥，拿不到外壳桥。
          internal: resolve(__dirname, 'src/preload/internal.ts')
        }
      }
    }
  },
  renderer: {
    plugins: [vue()],
    build: {
      rollupOptions: {
        input: {
          // 两个文档：外壳（含叠加层）与内部设置页。
          index: resolve(__dirname, 'src/renderer/index.html'),
          settings: resolve(__dirname, 'src/renderer/settings.html')
        }
      }
    }
  }
})
