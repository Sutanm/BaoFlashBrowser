var path = require('path');
var fs = require('fs');
var electron = require('electron');
var app = electron.app;
var BrowserWindow = electron.BrowserWindow;
var Menu = electron.Menu;
var ipcMain = electron.ipcMain;
var shell = electron.shell;

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
}

app.commandLine.appendSwitch('ignore-gpu-blacklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');

var configPath = path.join(app.getPath('userData'), 'baoflash-config.json');
var defaultConfig = { flashVersion: '34.0.0.330' };

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      var raw = fs.readFileSync(configPath, 'utf8');
      var cfg = JSON.parse(raw);
      return { flashVersion: cfg.flashVersion || defaultConfig.flashVersion };
    }
  } catch (e) {}
  return defaultConfig;
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

function getFlashPluginPath() {
  var platform = process.platform;
  var arch = process.arch;
  var isPackaged = app.isPackaged;
  var basePath = isPackaged ? process.resourcesPath : path.join(__dirname, '..');

  if (platform === 'linux' && arch === 'x64') {
    return path.join(basePath, 'plugins', 'linux64', 'libpepflashplayer64.so');
  }
  if (platform === 'win32' && arch === 'x64') {
    return path.join(basePath, 'plugins', 'win64', 'pepflashplayer.dll');
  }
  if (platform === 'win32' && arch === 'ia32') {
    return path.join(basePath, 'plugins', 'win32', 'pepflashplayer32_32_0_0_156.dll');
  }
  return null;
}

var config = loadConfig();
var pluginPath = getFlashPluginPath();
if (pluginPath && fs.existsSync(pluginPath)) {
  app.commandLine.appendSwitch('ppapi-flash-path', pluginPath);
  app.commandLine.appendSwitch('ppapi-flash-version', config.flashVersion);
  console.log('[Flash] Plugin loaded: ' + pluginPath);
  console.log('[Flash] Version reported: ' + config.flashVersion);
} else {
  console.warn('[Flash] Plugin NOT found at: ' + pluginPath);
}

var mainWindow;

function setupDevTools(wc) {
  wc.on('before-input-event', function (e, input) {
    if (input.key !== 'F12' || input.type !== 'keyDown') return;
    e.preventDefault();
    try {
      if (wc.isDevToolsOpened()) {
        wc.closeDevTools();
      } else {
        wc.openDevTools({ mode: 'right' });
      }
    } catch (err) {}
  });

  wc.on('devtools-opened', function () {
    var devWc = wc.devToolsWebContents;
    if (devWc) {
      devWc.on('before-input-event', function (e2, input2) {
        if (input2.key === 'F12' && input2.type === 'keyDown') {
          e2.preventDefault();
          try { wc.closeDevTools(); } catch (err) {}
        }
      });
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'BaoFlashBrowser',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      plugins: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  setupDevTools(mainWindow.webContents);

  mainWindow.webContents.on('did-attach-webview', function (event, guestWc) {
    setupDevTools(guestWc);
  });

  mainWindow.setMenu(null);

  mainWindow.on('page-title-updated', function (e) {
    e.preventDefault();
  });

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('web-contents-created', function (event, wc) {
  wc.on('new-window', function (e, url) {
    e.preventDefault();
    if (wc.hostWebContents) {
      wc.hostWebContents.send('navigate-url', url);
    }
  });
});

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

ipcMain.handle('get-config', function () {
  return loadConfig();
});

ipcMain.handle('save-config', function (event, cfg) {
  return saveConfig(cfg);
});

ipcMain.handle('restart-app', function () {
  app.relaunch();
  app.quit();
});
