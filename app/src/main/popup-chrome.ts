import { BrowserWindow, ipcMain, nativeTheme, WebContentsView } from 'electron'
import { join } from 'node:path'
import { shellThemes, windowPalette, type ShellTheme } from '../shared/shell-theme'

/**
 * 弹窗窗口的自绘 chrome（架构 A5「界面归一化」：用户可见的界面只有一种视觉语言）。
 *
 * 为什么不能"美化原生帧"：Windows 没有给原生窗口换肤的 API。要么 `titleBarStyle: hidden`
 * + `titleBarOverlay`（系统按钮在，但站点页面没有拖动区 → 窗口拖不动），要么完全自绘。
 *
 * 控制条在右上角提供拖动、最小化和关闭，页面视口保持站点请求的尺寸。
 */
const CHROME_WIDTH = 96
const CHROME_HEIGHT = 32
const CHROME_MARGIN = 4

function popupTheme(): ShellTheme {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

function themeCss(theme: ShellTheme): string {
  const tokens = shellThemes[theme]
  const palette = windowPalette[theme]
  return `
  :root[data-theme="${theme}"] {
    color-scheme: ${theme};
    --surface: ${palette.color};
    --foreground: ${palette.symbolColor};
    --secondary: ${tokens.colorNeutralForeground3};
    --border: ${tokens.colorNeutralStroke1};
    --divider: ${tokens.colorNeutralStroke2};
    --hover: ${tokens.colorNeutralBackground1Hover};
    --pressed: ${tokens.colorNeutralBackground1Pressed};
    --focus: ${tokens.colorStrokeFocus2};
  }`
}

function chromeHtml(): string {
  return `<!doctype html><html lang="zh-CN" data-theme="${popupTheme()}"><head><meta charset="utf-8">
<title>弹窗控制</title>
<style>
  ${themeCss('light')}
  ${themeCss('dark')}
  html { height: 100%; background: transparent; }
  body {
    box-sizing: border-box; height: 100%; margin: 0;
    display: grid; grid-template-columns: 24px repeat(2, minmax(0, 1fr));
    overflow: hidden; border: 1px solid var(--border); border-radius: 8px;
    background: var(--surface); color: var(--foreground);
  }
  .grip {
    display: grid; place-items: center;
    border-inline-end: 1px solid var(--divider); color: var(--secondary);
    -webkit-app-region: drag;
  }
  button {
    display: grid; place-items: center; border: 0; padding: 0;
    background: transparent; color: inherit; cursor: pointer;
    -webkit-app-region: no-drag;
  }
  button:hover { background: var(--hover); }
  button:active { background: var(--pressed); }
  button:focus-visible { outline: 2px solid var(--focus); outline-offset: -3px; }
  #close:hover { background: #c42b1c; color: #fff; }
  #close:active { background: #a4261a; color: #fff; }
  svg { width: 14px; height: 14px; pointer-events: none; }
</style></head>
<body>
  <div class="grip" aria-hidden="true"><svg viewBox="0 0 14 14" fill="currentColor"><circle cx="5" cy="3" r="1"/><circle cx="9" cy="3" r="1"/><circle cx="5" cy="7" r="1"/><circle cx="9" cy="7" r="1"/><circle cx="5" cy="11" r="1"/><circle cx="9" cy="11" r="1"/></svg></div>
  <button id="min" aria-label="最小化弹窗" title="最小化"><svg aria-hidden="true" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2.5 7h9"/></svg></button>
  <button id="close" aria-label="关闭弹窗" title="关闭"><svg aria-hidden="true" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="m3 3 8 8m0-8-8 8"/></svg></button>
  <script>
    document.getElementById('min').addEventListener('click', () => window.baoPopupChrome.minimize())
    document.getElementById('close').addEventListener('click', () => window.baoPopupChrome.close())
  </script>
</body></html>`
}

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
  const contents = view.webContents
  chromeOwners.set(contents.id, window)
  placeChrome(window, view)

  const relayout = () => {
    if (window.isDestroyed() || contents.isDestroyed()) return
    placeChrome(window, view)
  }
  const syncTheme = () => {
    if (contents.isDestroyed() || !contents.getURL()) return
    void contents.executeJavaScript(`document.documentElement.dataset.theme = '${popupTheme()}'`).catch(() => {})
  }
  const id = contents.id
  window.on('resize', relayout)
  nativeTheme.on('updated', syncTheme)
  contents.once('dom-ready', syncTheme)
  contents.once('destroyed', () => {
    chromeOwners.delete(id)
    nativeTheme.off('updated', syncTheme)
    window.off('resize', relayout)
  })
  window.once('closed', () => {
    if (!contents.isDestroyed()) contents.close()
  })

  void contents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(chromeHtml())}`)
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
