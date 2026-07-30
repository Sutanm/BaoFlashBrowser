# BaoFlashBrowser 打包手册

> **用途**：本手册供新 AI 会话独立完成从源码到安装包的完整打包流程。

---

## 1. 打包前代码修改（3 个文件，4 处改动）

### 1.1 启用 webpack production 模式

**文件**：`webpack.main.config.js`

```diff
- mode: 'development',
- devtool: 'source-map',
+ mode: 'production',
```

**文件**：`webpack.renderer.config.js`

```diff
- mode: 'development',
- devtool: 'source-map',
+ mode: 'production',
```

> 效果：JS 压缩混淆、移除 source map、tree-shaking，bundle 体积减少 60%+，运行时更快。

---

### 1.2 补充 native 目录到打包资源

**文件**：`package.json` → `build.extraResources`

```diff
  "extraResources": [
    { "from": "plugins", "to": "plugins" },
+   { "from": "native", "to": "native" }
  ],
```

> 原因：Ctrl+滚轮缩放依赖 `native/mouse-hook.exe`（Windows）和 `native/mouse-hook-linux`（Linux）。不打包会导致该功能在生产环境静默失效。

---

### 1.3 移动构建时依赖到 devDependencies

**文件**：`package.json`

从 `dependencies` 中**删除**下面两行：
```diff
- "@ruffle-rs/ruffle": "^0.4.1",
- "copy-webpack-plugin": "^14.0.0",
```

添加到 `devDependencies` 中（任意位置，建议紧跟其他 webpack 相关依赖）：
```diff
  "devDependencies": {
+   "@ruffle-rs/ruffle": "^0.4.1",
+   "copy-webpack-plugin": "^14.0.0",
    ...已有内容不改...
  }
```

> 原因：这两个包只在 webpack 构建时使用。放 `dependencies` 会导致 electron-builder 把它们一起打包进安装包。Ruffle 的运行文件已被 CopyPlugin 拷贝到 `dist/lib/ruffle/`，无需运行时依赖。

---

## 2. 清理旧产物 & 构建

```bash
rm -rf dist release
npm run build
```

构建后 `dist/` 目录应包含：

| 文件 | 说明 |
|------|------|
| `dist/main.js` | 主进程入口 |
| `dist/preload.js` | 壳窗口 preload |
| `dist/webview-preload.js` | 页面 preload |
| `dist/renderer/bundle.js` | 渲染进程 JS |
| `dist/renderer/bundle.css` | 渲染进程 CSS |
| `dist/renderer/index.html` | 壳 HTML |
| `dist/lib/ruffle/ruffle.js` | Ruffle 入口 JS |
| `dist/lib/ruffle/core.ruffle.*.js` | Ruffle 分块文件 |
| `dist/lib/ruffle/*.wasm` | Ruffle WASM 核心（2 个） |

---

## 3. 打包命令行

```bash
# Windows x64（最常用）
npm run build:win64

# Windows x86（32位）
npm run build:win32

# Linux AppImage
npm run build:linux
```

产物在 `release/` 目录。

---

## 4. 验证清单（安装后依次检查）

| # | 检查项 | 操作 |
|---|--------|------|
| 1 | 应用启动 | 双击安装，不报错即为通过 |
| 2 | 窗口图标 | 任务栏和标题栏显示自定义图标，非 Electron 默认 |
| 3 | 标签功能 | 新建/关闭/切换标签正常，拖拽排序正常 |
| 4 | PPAPI Flash | 打开 4399 游戏，Flash 正常加载 |
| 5 | Ruffle 切换 | 点击导航栏 Flash/Ruffle 按钮，右键菜单显示引擎状态变化 |
| 6 | Ruffle 游戏 | Ruffle 模式下 4399 游戏可玩 |
| 7 | 收藏夹 | 点击星标收藏，重启应用后仍在 |
| 8 | 历史记录 | 浏览后侧边栏历史面板有记录 |
| 9 | 设置面板 | 保存设置，重启后生效 |
| 10 | Ctrl+滚轮缩放 | 在任意页面按住 Ctrl 滚动滚轮，缩放生效 |
| 11 | 快捷键 | Ctrl+T/W/Tab/L/D/F/R/F11/F12 等全部正常 |
| 12 | 无崩溃 | 使用 5 分钟以上无不正常退出 |

---

## 5. 打包后恢复开发环境

打包完成后，**必须**将第 1 节修改的 3 个文件恢复原状（4 处改动）：

| 文件 | 恢复操作 |
|------|----------|
| `webpack.main.config.js` | `mode: 'development'`，`devtool: 'source-map'` |
| `webpack.renderer.config.js` | `mode: 'development'`，`devtool: 'source-map'` |
| `package.json` → `build.extraResources` | 删除 `native` 行（开发环境的 native 在项目根目录） |
| `package.json` → `dependencies` / `devDependencies` | 把两个包移回 `dependencies` |

---

## 6. 版本号

修改 `package.json` 的 `version` 字段。遵循 `主版本.次版本.修订号` 格式。

---

## 7. 命令速查

| 命令 | 用途 |
|------|------|
| `npm run build` | 构建 `dist/` |
| `npm run start` | 开发启动（先构建再运行） |
| `npm run build:win64` | 构建 + 打包 Windows x64 |
| `npm run build:win32` | 构建 + 打包 Windows x86 |
| `npm run build:linux` | 构建 + 打包 Linux |
| `npm run icon` | 重新生成多尺寸 ICO/PNG 图标 |
| `npm run lint` | ESLint 检查 |
| `npm run start` | 开发启动（先构建再运行） |

---

## 8. 项目路径约定

打包后 Electron 入口 `main` 指向 `dist/main.js`（`package.json:5`）。以下运行时路径已确保在开发和生产环境均正确：

| 功能 | 路径来源 | 开发环境 | 生产环境 |
|------|----------|----------|----------|
| Flash PPAPI 插件 | `extraResources` → `plugins/` | `project/plugins/` | `resources/plugins/` |
| 鼠标钩子缩放 | `extraResources` → `native/` | `project/native/` | `resources/native/` |
| Ruffle WASM/JS | webpack CopyPlugin → `dist/lib/ruffle/` | `dist/lib/ruffle/` | `app.asar/dist/lib/ruffle/` |
| 壳 HTML | `build:renderer` 脚本复制 | `dist/renderer/index.html` | `app.asar/dist/renderer/index.html` |
| 窗口图标 | `build/icon.ico` | `build/icon.ico` | `app.asar/build/icon.ico` |

> 所有 `dist/` 下文件的运行时路径均通过 webpack `node: { __dirname: false }` 保持为真实文件路径，Electron 自动处理 asar 透明读取。

---

## 9. 注意事项

1. **不要**在打包时修改 `target: 'electron-main'` 或 `node: { __dirname: false }`，否则生产环境文件路径解析会出错。
2. Ruffle 标签使用 `contextIsolation: false` 是**有意设计**，确保 preload 脚本可在页面上下文执行 `eval()` 注入 Ruffle JS。PPAPI 标签保持 `contextIsolation: true`。
3. `electron-store` 锁定版本 `^6.0.1`，不可升级到 v7+，因为 v7 需要 ESM 支持（Electron 11 不支持）。
