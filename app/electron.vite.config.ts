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
      /**
       * 渲染层产物压缩（2026-11-26）。
       *
       * electron-vite 给 renderer 的 `minify` 默认是 `false`，产物是 `theme-*.js` 266 KB +
       * `index-*.js` 58 KB 这种带缩进换行的未压缩代码，成品包里也是这副样子。
       *
       * **它没有让启动变快**（别拿它当启动优化）：同一探针插进产物、两种构建交替各跑 3 轮，
       * 「首个脚本执行 → DCL」压缩前 17–19 ms、压缩后 17–18 ms，差在噪声里。保留的理由是
       * 分发体积：外壳首屏三个文件 341 KB → 145 KB（−58%），行为零变化。
       *
       * 只动 renderer：主进程/preload 的体积对启动没有影响，压了反而让主进程的栈与
       * `BAO_*_TRACE` 诊断更难读。CSS 一并压缩，类名不动（esbuild 只改空白与值）。
       */
      minify: 'esbuild',
      rollupOptions: {
        input: {
          // 四个文档：外壳（含叠加层）、内部设置页、新标签页与收藏夹管理页。
          index: resolve(__dirname, 'src/renderer/index.html'),
          settings: resolve(__dirname, 'src/renderer/settings.html'),
          newtab: resolve(__dirname, 'src/renderer/newtab.html'),
          favorites: resolve(__dirname, 'src/renderer/favorites.html')
        }
      }
    }
  }
})

