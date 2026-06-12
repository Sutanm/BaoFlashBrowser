# BaoFlashBrowser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a cross-platform (Windows/Linux) desktop Flash browser using Electron v11 with native PPAPI Flash plugin support and a minimal single-row toolbar UI.

**Architecture:** Electron v11.5.0 main process injects PPAPI Flash via command-line switches. Renderer loads `index.html` containing a toolbar and a `<webview>` for Flash content. Preload script bridges IPC for window controls. Settings and favorites use localStorage.

**Tech Stack:** Electron 11.5.0, Chromium 87, Node.js 12.x, vanilla HTML/CSS/JS, electron-builder

**Constraints:** Node 12 (no `?.`, no `??`, no ES2020+), Chromium 87 web APIs only.

---

## File Structure

```
BaoFlashBrowser/
├── plugins/
│   ├── linux64/
│   │   └── libpepflashplayer64.so      (move from root)
│   ├── win64/
│   │   └── pepflashplayer64_32_0_0_156.dll  (move from root)
│   └── win32/
│       └── pepflashplayer32_32_0_0_156.dll  (move from root)
├── src/
│   ├── main.js           Main process: Flash injection, window creation, IPC
│   └── preload.js        Preload: contextBridge API for renderer
├── renderer/
│   ├── index.html        UI: toolbar + webview
│   ├── style.css         Dark theme styles
│   └── app.js            Toolbar logic, navigation, favorites, settings
├── package.json
└── .gitignore
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `.gitignore`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "bao-flash-browser",
  "version": "1.0.0",
  "description": "Cross-platform Flash browser based on Electron",
  "main": "src/main.js",
  "scripts": {
    "start": "electron .",
    "build:win": "electron-builder --win",
    "build:linux": "electron-builder --linux",
    "build": "electron-builder --win --linux"
  },
  "dependencies": {
    "electron": "11.5.0"
  },
  "devDependencies": {
    "electron-builder": "^22.14.13"
  },
  "build": {
    "appId": "com.bao.flashbrowser",
    "productName": "BaoFlashBrowser",
    "directories": {
      "output": "dist"
    },
    "extraResources": [
      {
        "from": "plugins",
        "to": "plugins"
      }
    ],
    "win": {
      "target": [
        {
          "target": "nsis",
          "arch": ["x64", "ia32"]
        }
      ],
      "icon": null
    },
    "linux": {
      "target": [
        {
          "target": "AppImage",
          "arch": ["x64"]
        }
      ]
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true
    }
  }
}
```

- [ ] **Step 2: Create .gitignore**

```
node_modules/
dist/
*.log
```

- [ ] **Step 3: Install dependencies**

Run: `npm install`
Expected: electron@11.5.0 and electron-builder installed successfully.

- [ ] **Step 4: Commit**

```bash
git add package.json .gitignore
git commit -m "chore: initialize project with Electron 11 and electron-builder"
```

---

### Task 2: Organize Flash Plugin Files

**Files:**
- Create: `plugins/linux64/`, `plugins/win64/`, `plugins/win32/` directories
- Move from root: `libpepflashplayer64.so`, `pepflashplayer64_32_0_0_156.dll`, `pepflashplayer32_32_0_0_156.dll`

- [ ] **Step 1: Create directories and move plugin files**

```powershell
New-Item -ItemType Directory -Path "plugins\linux64" -Force
New-Item -ItemType Directory -Path "plugins\win64" -Force
New-Item -ItemType Directory -Path "plugins\win32" -Force
Move-Item -LiteralPath "libpepflashplayer64.so" -Destination "plugins\linux64\"
Move-Item -LiteralPath "pepflashplayer64_32_0_0_156.dll" -Destination "plugins\win64\"
Move-Item -LiteralPath "pepflashplayer32_32_0_0_156.dll" -Destination "plugins\win32\"
```

- [ ] **Step 2: Verify file placement**

Run: `Get-ChildItem -Recurse -File plugins\`
Expected: 3 files in their respective subdirectories.

- [ ] **Step 3: Commit**

```bash
git add plugins/
git rm libpepflashplayer64.so pepflashplayer64_32_0_0_156.dll pepflashplayer32_32_0_0_156.dll
git commit -m "chore: organize Flash plugin files into platform directories"
```

---

### Task 3: Main Process

**Files:**
- Create: `src/main.js`

- [ ] **Step 1: Create main.js with Flash injection, window creation, and IPC**

```javascript
var path = require('path');
var fs = require('fs');
var electron = require('electron');
var app = electron.app;
var BrowserWindow = electron.BrowserWindow;
var ipcMain = electron.ipcMain;
var shell = electron.shell;

function getFlashPluginPath() {
  var platform = process.platform;
  var arch = process.arch;
  var isPackaged = app.isPackaged;
  var basePath = isPackaged ? process.resourcesPath : path.join(__dirname, '..');

  if (platform === 'linux' && arch === 'x64') {
    return path.join(basePath, 'plugins', 'linux64', 'libpepflashplayer64.so');
  }
  if (platform === 'win32' && arch === 'x64') {
    return path.join(basePath, 'plugins', 'win64', 'pepflashplayer64_32_0_0_156.dll');
  }
  if (platform === 'win32' && arch === 'ia32') {
    return path.join(basePath, 'plugins', 'win32', 'pepflashplayer32_32_0_0_156.dll');
  }
  return null;
}

var pluginPath = getFlashPluginPath();
if (pluginPath && fs.existsSync(pluginPath)) {
  app.commandLine.appendSwitch('ppapi-flash-path', pluginPath);
  app.commandLine.appendSwitch('ppapi-flash-version', '32.0.0.0');
  console.log('[Flash] Plugin loaded: ' + pluginPath);
} else {
  console.warn('[Flash] Plugin NOT found at: ' + pluginPath);
}

var mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'BaoFlashBrowser',
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      plugins: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('page-title-updated', function (e) {
    e.preventDefault();
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', function () {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

ipcMain.handle('open-external', function (event, url) {
  shell.openExternal(url);
});

ipcMain.handle('set-window-title', function (event, title) {
  if (mainWindow) {
    mainWindow.setTitle(title || 'BaoFlashBrowser');
  }
});
```

- [ ] **Step 2: Verify the file was created**

Run: `node -e "require('./src/main').toString()"` 
(Just syntax check, will fail on electron import but confirms no syntax errors.)

Actually just check: `wsl node -c src/main.js`
Expected: No syntax errors.

- [ ] **Step 3: Commit**

```bash
git add src/main.js
git commit -m "feat: add main process with Flash plugin injection and window creation"
```

---

### Task 4: Preload Script

**Files:**
- Create: `src/preload.js`

- [ ] **Step 1: Create preload.js with contextBridge**

```javascript
var contextBridge = require('electron').contextBridge;
var ipcRenderer = require('electron').ipcRenderer;

contextBridge.exposeInMainWorld('electronAPI', {
  openExternal: function (url) {
    ipcRenderer.invoke('open-external', url);
  },
  setTitle: function (title) {
    ipcRenderer.invoke('set-window-title', title);
  }
});
```

- [ ] **Step 2: Commit**

```bash
git add src/preload.js
git commit -m "feat: add preload script with IPC bridge"
```

---

### Task 5: Renderer HTML + CSS

**Files:**
- Create: `renderer/index.html`
- Create: `renderer/style.css`

- [ ] **Step 1: Create renderer/index.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BaoFlashBrowser</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div id="toolbar">
    <button id="btn-back" title="Back" disabled>&larr;</button>
    <button id="btn-forward" title="Forward" disabled>&rarr;</button>
    <button id="btn-refresh" title="Refresh">&curvearrowright;</button>
    <input type="text" id="address-bar" placeholder="Enter URL..." autocomplete="off" spellcheck="false">
    <button id="btn-mute" title="Mute">&#x1f50a;</button>
    <button id="btn-fav" title="Favorites">&#9733;</button>
    <button id="btn-settings" title="Settings">&#x2699;</button>
  </div>
  <div id="favorites-panel" class="panel hidden">
    <div class="panel-header">
      <span>Favorites</span>
      <button id="btn-fav-close">&times;</button>
    </div>
    <div id="favorites-list"></div>
  </div>
  <div id="settings-panel" class="panel hidden">
    <div class="panel-header">
      <span>Settings</span>
      <button id="btn-settings-close">&times;</button>
    </div>
    <div class="settings-body">
      <label>Homepage URL</label>
      <input type="text" id="setting-homepage" placeholder="about:blank">
      <button id="btn-save-settings">Save</button>
    </div>
  </div>
  <webview id="gameview" src="about:blank" plugins></webview>
  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create renderer/style.css**

```css
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  background: #1a1a2e;
  color: #e0e0e0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 14px;
}

#toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  background: #16213e;
  border-bottom: 1px solid #0f3460;
  flex-shrink: 0;
  height: 42px;
  -webkit-app-region: drag;
}

#toolbar button {
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #e0e0e0;
  font-size: 18px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  -webkit-app-region: no-drag;
}

#toolbar button:hover {
  background: #0f3460;
}

#toolbar button:disabled {
  color: #555;
  cursor: default;
}

#toolbar button:disabled:hover {
  background: transparent;
}

#address-bar {
  flex: 1;
  height: 30px;
  padding: 0 12px;
  border: 1px solid #0f3460;
  border-radius: 15px;
  background: #0a0a1a;
  color: #e0e0e0;
  font-size: 13px;
  outline: none;
  -webkit-app-region: no-drag;
}

#address-bar:focus {
  border-color: #533483;
}

#gameview {
  flex: 1;
  border: none;
}

.panel {
  position: absolute;
  top: 42px;
  right: 8px;
  width: 280px;
  background: #16213e;
  border: 1px solid #0f3460;
  border-radius: 6px;
  z-index: 100;
  box-shadow: 0 4px 12px rgba(0,0,0,0.5);
}

.panel.hidden {
  display: none;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid #0f3460;
  font-weight: bold;
}

.panel-header button {
  border: none;
  background: transparent;
  color: #e0e0e0;
  font-size: 18px;
  cursor: pointer;
}

#favorites-list {
  max-height: 300px;
  overflow-y: auto;
}

.fav-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid #0f3460;
  cursor: pointer;
}

.fav-item:hover {
  background: #0f3460;
}

.fav-item-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fav-item-url {
  font-size: 11px;
  color: #888;
  margin-left: 8px;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fav-item-remove {
  border: none;
  background: transparent;
  color: #e74c3c;
  font-size: 16px;
  cursor: pointer;
  margin-left: 8px;
}

.fav-empty {
  padding: 16px;
  text-align: center;
  color: #666;
}

.settings-body {
  padding: 12px;
}

.settings-body label {
  display: block;
  margin-bottom: 6px;
  font-size: 13px;
  color: #aaa;
}

.settings-body input {
  width: 100%;
  height: 30px;
  padding: 0 10px;
  margin-bottom: 10px;
  border: 1px solid #0f3460;
  border-radius: 4px;
  background: #0a0a1a;
  color: #e0e0e0;
  font-size: 13px;
  outline: none;
}

.settings-body button {
  height: 30px;
  padding: 0 16px;
  border: none;
  border-radius: 4px;
  background: #533483;
  color: #fff;
  cursor: pointer;
}
```

- [ ] **Step 3: Commit**

```bash
git add renderer/index.html renderer/style.css
git commit -m "feat: add renderer HTML and dark theme CSS"
```

---

### Task 6: Renderer JavaScript

**Files:**
- Create: `renderer/app.js`

- [ ] **Step 1: Create renderer/app.js with full toolbar logic**

```javascript
(function () {
  var webview = document.getElementById('gameview');
  var addressBar = document.getElementById('address-bar');
  var btnBack = document.getElementById('btn-back');
  var btnForward = document.getElementById('btn-forward');
  var btnRefresh = document.getElementById('btn-refresh');
  var btnMute = document.getElementById('btn-mute');
  var btnFav = document.getElementById('btn-fav');
  var btnSettings = document.getElementById('btn-settings');
  var favPanel = document.getElementById('favorites-panel');
  var favList = document.getElementById('favorites-list');
  var btnFavClose = document.getElementById('btn-fav-close');
  var settingsPanel = document.getElementById('settings-panel');
  var btnSettingsClose = document.getElementById('btn-settings-close');
  var settingHomepage = document.getElementById('setting-homepage');
  var btnSaveSettings = document.getElementById('btn-save-settings');

  var isMuted = false;

  // --- Helpers ---

  function getFavorites() {
    try {
      return JSON.parse(localStorage.getItem('baoflash_favorites') || '[]');
    } catch (e) {
      return [];
    }
  }

  function saveFavorites(favs) {
    localStorage.setItem('baoflash_favorites', JSON.stringify(favs));
  }

  function getHomepage() {
    return localStorage.getItem('baoflash_homepage') || 'about:blank';
  }

  function saveHomepage(url) {
    localStorage.setItem('baoflash_homepage', url);
  }

  function normalizeUrl(input) {
    if (!input || input === 'about:blank') return 'about:blank';
    if (input.indexOf('://') !== -1) return input;
    return 'https://' + input;
  }

  function updateNavButtons() {
    try {
      btnBack.disabled = !webview.canGoBack();
      btnForward.disabled = !webview.canGoForward();
    } catch (e) {}
  }

  // --- Webview events ---

  webview.addEventListener('did-navigate', function (e) {
    addressBar.value = e.url;
    updateNavButtons();
    if (window.electronAPI) {
      window.electronAPI.setTitle(document.title);
    }
  });

  webview.addEventListener('did-navigate-in-page', function (e) {
    if (e.isMainFrame) {
      addressBar.value = e.url;
      updateNavButtons();
    }
  });

  webview.addEventListener('page-title-updated', function (e) {
    document.title = e.title;
    if (window.electronAPI) {
      window.electronAPI.setTitle(e.title);
    }
  });

  webview.addEventListener('new-window', function (e) {
    e.preventDefault();
    if (window.electronAPI) {
      window.electronAPI.openExternal(e.url);
    }
  });

  webview.addEventListener('did-start-loading', function () {
    btnRefresh.textContent = '\u00D7';
  });

  webview.addEventListener('did-stop-loading', function () {
    btnRefresh.textContent = '\u21BB';
    updateNavButtons();
  });

  // --- Navigation ---

  btnBack.addEventListener('click', function () {
    try { webview.goBack(); } catch (e) {}
  });

  btnForward.addEventListener('click', function () {
    try { webview.goForward(); } catch (e) {}
  });

  btnRefresh.addEventListener('click', function () {
    if (webview.isLoading()) {
      webview.stop();
    } else {
      webview.reload();
    }
  });

  addressBar.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      var url = normalizeUrl(addressBar.value.trim());
      webview.loadURL(url);
    }
  });

  // --- Mute ---

  btnMute.addEventListener('click', function () {
    isMuted = !isMuted;
    webview.setAudioMuted(isMuted);
    btnMute.innerHTML = isMuted ? '&#x1f507;' : '&#x1f50a;';
    btnMute.title = isMuted ? 'Unmute' : 'Mute';
  });

  // --- Favorites ---

  function renderFavorites() {
    var favs = getFavorites();
    favList.innerHTML = '';
    if (favs.length === 0) {
      favList.innerHTML = '<div class="fav-empty">No favorites yet</div>';
      return;
    }
    for (var i = 0; i < favs.length; i++) {
      var item = document.createElement('div');
      item.className = 'fav-item';
      item.innerHTML =
        '<span class="fav-item-title">' + escapeHtml(favs[i].title || favs[i].url) + '</span>' +
        '<span class="fav-item-url">' + escapeHtml(favs[i].url) + '</span>' +
        '<button class="fav-item-remove" data-url="' + escapeHtml(favs[i].url) + '">&times;</button>';
      item.addEventListener('click', function (e) {
        if (e.target.className === 'fav-item-remove') return;
        webview.loadURL(this.querySelector('.fav-item-remove').getAttribute('data-url'));
        favPanel.classList.add('hidden');
      });
      favList.appendChild(item);
    }

    var removeBtns = favList.querySelectorAll('.fav-item-remove');
    for (var j = 0; j < removeBtns.length; j++) {
      removeBtns[j].addEventListener('click', function (e) {
        e.stopPropagation();
        var url = this.getAttribute('data-url');
        var favs = getFavorites();
        favs = favs.filter(function (f) { return f.url !== url; });
        saveFavorites(favs);
        renderFavorites();
      });
    }
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  btnFav.addEventListener('click', function () {
    if (favPanel.classList.contains('hidden')) {
      renderFavorites();
      favPanel.classList.remove('hidden');
      settingsPanel.classList.add('hidden');
    } else {
      favPanel.classList.add('hidden');
    }
  });

  btnFavClose.addEventListener('click', function () {
    favPanel.classList.add('hidden');
  });

  webview.addEventListener('did-navigate', function () {
    var url = webview.getURL();
    var title = document.title || url;
    var favs = getFavorites();
    var exists = favs.some(function (f) { return f.url === url; });
    if (exists) {
      btnFav.innerHTML = '&#9733;';
      btnFav.style.color = '#ffd700';
    } else {
      btnFav.innerHTML = '&#9734;';
      btnFav.style.color = '';
    }
  });

  btnFav.addEventListener('dblclick', function () {
    var url = webview.getURL();
    if (!url || url === 'about:blank') return;
    var title = document.title || url;
    var favs = getFavorites();
    var idx = -1;
    for (var i = 0; i < favs.length; i++) {
      if (favs[i].url === url) { idx = i; break; }
    }
    if (idx >= 0) {
      favs.splice(idx, 1);
      saveFavorites(favs);
      btnFav.innerHTML = '&#9734;';
      btnFav.style.color = '';
    } else {
      favs.unshift({ url: url, title: title });
      saveFavorites(favs);
      btnFav.innerHTML = '&#9733;';
      btnFav.style.color = '#ffd700';
    }
  });

  // --- Settings ---

  btnSettings.addEventListener('click', function () {
    if (settingsPanel.classList.contains('hidden')) {
      settingHomepage.value = getHomepage();
      settingsPanel.classList.remove('hidden');
      favPanel.classList.add('hidden');
    } else {
      settingsPanel.classList.add('hidden');
    }
  });

  btnSettingsClose.addEventListener('click', function () {
    settingsPanel.classList.add('hidden');
  });

  btnSaveSettings.addEventListener('click', function () {
    saveHomepage(settingHomepage.value.trim());
    settingsPanel.classList.add('hidden');
  });

  // --- Click-outside to close panels ---

  document.addEventListener('click', function (e) {
    if (!favPanel.classList.contains('hidden') &&
        !favPanel.contains(e.target) &&
        e.target !== btnFav &&
        !btnFav.contains(e.target)) {
      favPanel.classList.add('hidden');
    }
    if (!settingsPanel.classList.contains('hidden') &&
        !settingsPanel.contains(e.target) &&
        e.target !== btnSettings &&
        !btnSettings.contains(e.target)) {
      settingsPanel.classList.add('hidden');
    }
  });

  // --- Init ---

  var homepage = getHomepage();
  if (homepage !== 'about:blank') {
    webview.loadURL(normalizeUrl(homepage));
  }

  updateNavButtons();
})();
```

- [ ] **Step 2: Commit**

```bash
git add renderer/app.js
git commit -m "feat: add renderer logic with navigation, favorites, and settings"
```

---

### Task 7: Verify Build Configuration

**Files:**
- (build config already in package.json from Task 1)

- [ ] **Step 1: Verify electron-builder config is correct**

Check package.json build section has `extraResources` configured correctly for both platforms.

- [ ] **Step 2: Test that app can start in development mode**

Run: `npx electron .`
Expected: App window opens with toolbar, webview loads about:blank.

- [ ] **Step 3: Commit any final adjustments**

---

### Task 8: Linux Verification via WSL

- [ ] **Step 1: Verify SO dependencies on Linux**

Run: `wsl ldd plugins/linux64/libpepflashplayer64.so`
Expected: All dependencies resolved.

- [ ] **Step 2: Verify Flash version string**

Run: `wsl strings plugins/linux64/libpepflashplayer64.so | Select-String "LNX"`
Expected: Contains "LNX 32,0,0,371"

- [ ] **Step 3: Verify Electron starts on Linux**

Run: `wsl npx electron . --no-sandbox`
(Note: running GUI from WSL requires WSLg or X server. This step is informational.)
Expected: If WSLg exists, app window appears. Otherwise, note any missing dependencies.
