import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

/**
 * 让 `dev` / `start`（electron-vite）也跑**自编译内核**。
 *
 * `electron-vite` 的 `getElectronPath()` 只认 `ELECTRON_EXEC_PATH`（它自己那套
 * `ELECTRON_OVERRIDE_DIST_PATH` 不生效），否则会启动 `node_modules/electron/dist` 里的
 * 官方二进制：没有 PPAPI 补丁，也找不到 `pepflashplayer64.dll`，所以 `npm start` 里
 * Flash 永远不可用（日志会报 `...\node_modules\electron\dist\flash\pepflashplayer64.dll`）。
 */
const runtimeExecutable = resolve(__dirname, '.runtime/win-x64/electron.exe')
if (!process.env.ELECTRON_EXEC_PATH && existsSync(runtimeExecutable)) {
  process.env.ELECTRON_EXEC_PATH = runtimeExecutable
}

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
