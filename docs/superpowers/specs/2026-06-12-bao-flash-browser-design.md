# BaoFlashBrowser Design Spec

## Overview

A cross-platform (Windows/Linux) desktop browser built on Electron, specifically designed for running Flash (PPAPI) content. Targets Flash gaming with native PPAPI plugin support.

## Core Architecture

```
Electron v11.5.0 (Chromium 87)
├── Main Process (main.js)
│   ├── Flash plugin injection (commandLine.appendSwitch)
│   ├── BrowserWindow creation
│   └── IPC handlers (settings, favorites, mute)
├── Preload Script (preload.js)
│   └── Bridge APIs (navigation, mute toggle, favorites CRUD)
└── Renderer Process (index.html)
    ├── Toolbar (nav buttons + address bar + mute/fav/settings)
    └── Content area (native BrowserView/webview for Flash)
```

## Flash Plugin Strategy

| Platform | Plugin File | Flash Version | Source |
|----------|------------|---------------|--------|
| Linux x64 | `libpepflashplayer64.so` | 32.0.0.371 | 百田游戏管家 extract |
| Windows x64 | `pepflashplayer64_32_0_0_156.dll` | 32.0.0.156 | mingde816/pepflashplayer.dll |
| Windows x86 | `pepflashplayer32_32_0_0_156.dll` | 32.0.0.156 | mingde816/pepflashplayer.dll |

Loading mechanism:
```js
app.commandLine.appendSwitch('ppapi-flash-path', pluginPath);
app.commandLine.appendSwitch('ppapi-flash-version', '32.0.0.0');
```

Runtime detection: `process.platform` + `process.arch` selects the correct plugin.

## UI Design

Single-row top toolbar, no tabs, minimal interface:

```
┌──────────────────────────────────────────────────────┐
│  ← → ⟳  [https://game.example.com         ]  🔇 ⭐ ⚙│
├──────────────────────────────────────────────────────┤
│              Flash Game Content Area                  │
└──────────────────────────────────────────────────────┘
```

- **Back/Forward**: History navigation
- **Refresh**: Reload current page
- **Address Bar**: URL input + current page display
- **Mute**: Toggle page audio
- **Favorites**: Bookmark management
- **Settings**: Flash permissions, plugin path override, home page

Color scheme: dark theme to minimize visual interference during gaming.

## Security

- Unrestricted Flash execution (all sites allowed)
- No remote process execution
- Flash runs in Chromium sandbox

## Build & Distribution

- **Tool**: electron-builder
- **Windows**: NSIS installer (.exe)
- **Linux**: AppImage (portable, no installation needed)

## Constraints

- Electron v11 → Node.js 12.x (no `?.`, no `??`, no ES2020+)
- Electron v11 → Chromium 87 (no modern CSS Grid Level 2, no `aspect-ratio`)
- No tabs (single window mode)
- SO dependencies verified on Ubuntu via WSL: all resolved (standard glibc)
