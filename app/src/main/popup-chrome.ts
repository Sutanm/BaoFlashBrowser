import { BrowserWindow, ipcMain, WebContentsView } from 'electron'
import { join } from 'node:path'

/**
 * 弹窗窗口的自绘 chrome（架构 A5「界面归一化」：用户可见的界面只有一种视觉语言）。
 *
 * 为什么不能"美化原生帧"：Windows 没有给原生窗口换肤的 API。要么 `titleBarStyle: hidden`
 * + `titleBarOverlay`（系统按钮在，但站点页面没有拖动区 → 窗口拖不动），要么完全自绘。
 *
 * 这里选自绘，并且把侵入压到最小：**只在右上角浮一个小控制簇**（拖动抓手 + 最小化 + 关闭），
 * 不铺满整条 32px，站点内容不会被大面积遮挡，页面视口也保持站点请求的尺寸。
 */
const CHROME_WIDTH = 96
const CHROME_HEIGHT = 28
const CHROME_MARGIN = 4

const CHROME_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>弹窗控制</title>
<style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; height: 100%; background: transparent; }
  body {
    display: flex; align-items: center; gap: 2px; padding: 0 4px;
    font: 12px/1 "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif;
    color: #fff; justify-content: flex-end;
  }
  .grip {
    width: 20px; height: 20px; margin-inline-end: auto; border-radius: 6px;
    -webkit-app-region: drag; background: rgba(0, 0, 0, .28);
    display: flex; align-items: center; justify-content: center;
  }
  .grip:hover { background: rgba(0, 0, 0, .42); }
  button {
    width: 22px; height: 22px; border: 0; padding: 0; border-radius: 6px;
    background: rgba(0, 0, 0, .28); color: inherit; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    -webkit-app-region: no-drag;
  }
  button:hover { background: rgba(0, 0, 0, .42); }
  #close:hover { background: #c0392f; }
  svg { width: 10px; height: 10px; }
</style></head>
<body>
  <div class="grip" aria-hidden="true"><svg viewBox="0 0 10 10" fill="currentColor"><circle cx="3" cy="3" r="1"/><circle cx="7" cy="3" r="1"/><circle cx="3" cy="7" r="1"/><circle cx="7" cy="7" r="1"/></svg></div>
  <button id="min" aria-label="最小化弹窗" title="最小化"><svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 5h6"/></svg></button>
  <button id="close" aria-label="关闭弹窗" title="关闭"><svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4"><path d="m2.5 2.5 5 5m0-5-5 5"/></svg></button>
  <script>
    document.getElementById('min').addEventListener('click', () => window.baoPopupChrome.minimize())
    document.getElementById('close').addEventListener('click', () => window.baoPopupChrome.close())
  </script>
</body></html>`

/** chrome 视图的 webContents id → 它所属的弹窗窗口。 */
const chromeOwners = new Map<number, BrowserWindow>()

function placeChrome(window: BrowserWindow, view: WebContentsView): void {
  const [width] = window.getContentSize()
  view.setBounds({
    x: Math.max(width - CHROME_WIDTH - CHROME_MARGIN, 0),
    y: CHROME_MARGIN,
    width: CHROME_WIDTH,
    height: CHROME_HEIGHT
  })
}

/**
 * 给弹窗窗口装上自绘 chrome。窗口必须是 `frame: false`（见 `guardContents` 的
 * overrideBrowserWindowOptions），否则我们会得到两套 chrome。
 */
export function attachPopupChrome(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  const view = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/popup-chrome.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      transparent: true
    }
  })
  view.setBackgroundColor('#00000000')
  window.contentView.addChildView(view)
  chromeOwners.set(view.webContents.id, window)
  placeChrome(window, view)

  const relayout = () => {
    if (window.isDestroyed() || view.webContents.isDestroyed()) return
    placeChrome(window, view)
  }
  window.on('resize', relayout)
  view.webContents.on('destroyed', () => {
    chromeOwners.delete(view.webContents.id)
    window.off('resize', relayout)
  })
  window.once('closed', () => chromeOwners.delete(view.webContents.id))

  void view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(CHROME_HTML)}`)
}

/** 注册 chrome 的 IPC。发送者必须是已登记的 chrome 视图。 */
export function registerPopupChromeIpc(): void {
  ipcMain.handle('bao:popup-chrome', (event, action: unknown) => {
    const window = chromeOwners.get(event.sender.id)
    if (!window || window.isDestroyed()) return false
    if (action === 'minimize') {
      window.minimize()
      return true
    }
    if (action === 'close') {
      window.close()
      return true
    }
    return false
  })
}
