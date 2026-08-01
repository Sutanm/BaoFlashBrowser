# BaoFlashBrowser

> A cross-platform Flash browser built on Electron 11 — keeping PPAPI Flash alive on modern systems.

[中文](README.md) **|** [English](README_EN.md)

[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-blue)](https://github.com/Sutanm/BaoFlashBrowser)
[![electron](https://img.shields.io/badge/electron-11.5.0-brightgreen)](https://www.electronjs.org/)
[![react](https://img.shields.io/badge/react-18.3-blue)](https://react.dev/)
[![flash](https://img.shields.io/badge/flash-PPAPI%2029%2F32-red)](#flash-plugin-versions)
[![ruffle](https://img.shields.io/badge/ruffle-0.4.1-blueviolet)](https://ruffle.rs/)

## Table of Contents

- [Why This Exists](#why-this-exists)
- [Key Features](#key-features)
- [Tech Stack](#tech-stack)
- [Quick Start](#quick-start)
- [Feature Details](#feature-details)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Project Structure](#project-structure)
- [Developer Guide](#developer-guide)
- [Flash Plugin Versions](#flash-plugin-versions)
- [License](#license)

## Why This Exists

On December 31, 2020, Adobe ended Flash Player support. Every major browser subsequently removed PPAPI (Pepper Plugin API) support, rendering countless Flash-based web games and content inaccessible. While open-source alternatives like Ruffle continue to improve, ActionScript 3 support remains incomplete.

**Chromium 87 is the last browser engine with native PPAPI Flash support**. This project builds on Electron 11 (which embeds Chromium 87) to provide an out-of-the-box Flash browsing experience, while solving the stability issues of traditional approaches through a BrowserView architecture.

### BrowserView vs `<webview>`

Electron's `<webview>` tag has a fatal flaw with Flash — multiple webviews share a single render pipeline. When one tab loads Flash content and another tab opens a new page, the entire renderer process crashes, blanking all tabs simultaneously.

BrowserView creates an independent renderer process per tab, isolating Flash's render pipeline at the OS level. A single tab crash never affects others.

## Key Features

- **PPAPI + Ruffle Dual Engine**: Native Flash plugin and WASM emulator, switchable per tab
- **Tab Management**: Multi-tab, drag-to-reorder, Chrome-style collapsing, full navigation controls
- **Password Manager**: CDP-based credential capture, AES-256-GCM encryption, master password protection
- **Download Manager**: aria2 multi-threaded engine, three-tier fallback, path traversal protection
- **Sidebar Panels**: Bookmarks, History, Downloads, Passwords, Settings
- **Taomee 61.com Compatibility**: SWFObject network-layer bypass, Flash version spoofing
- **Cross-platform**: Windows / Linux (WSL compatible)

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Shell | Electron 11.5.0 | Locked — Chromium 87, last with PPAPI support |
| UI Framework | React 18 + TypeScript 5 | createRoot concurrent mode |
| State | Zustand 5 + Dexie 4 | Persist middleware + liveQuery reactivity |
| Main Process Build | esbuild 0.28 | ~14ms build, CJS output |
| Renderer Build | Vite 6 | ~1.8s build, HMR dev server |
| Styling | Tailwind CSS 3.4 | Version locked — Chromium 87 doesn't support v4 |
| Encryption | AES-256-GCM + PBKDF2 | 250,000-iteration key derivation |
| Testing | Vitest + Playwright | Unit + E2E |
| Code Quality | ESLint 9 + Prettier | Flat config |

Architecture overview:

```
┌──────────────────────────────────────────────────────────┐
│                   Electron 11 (Chromium 87)                │
│                                                            │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ main process  │  │  BrowserViews │  │  renderer process │  │
│  │               │  │  (tab 1..N)   │  │                   │  │
│  │  tab manager  │  │  ┌──────────┐ │  │  React 18 App     │  │
│  │  download mgr │  │  │ PPAPI or │ │  │  ┌─────────────┐ │  │
│  │  password     │  │  │ Ruffle   │ │  │  │ TopBar       │ │  │
│  │  session      │  │  │ engine   │ │  │  │ + Drawer     │ │  │
│  │  flash loader │  │  └──────────┘ │  │  │ + Panels     │ │  │
│  │  ipc handlers │  │               │  │  └─────────────┘ │  │
│  └──────┬────────┘  └──────┬────────┘  └────────┬─────────┘  │
│         │                  │                     │            │
│         └────── IPC ───────┴────── IPC ──────────┘            │
│                            │                                  │
│                    ┌───────┴───────┐                          │
│                    │ electron-store │  (config + encrypted pwd)│
│                    │ Dexie/IndexedDB│  (bookmarks/history/dl)  │
│                    └───────────────┘                          │
└──────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# Install dependencies
npm install

# Development mode (HMR)
npm run dev

# Build + launch
npm start

# Package
npm run build:win      # Windows NSIS installer
npm run build:linux    # Linux AppImage
```

### Linux Dependencies

```bash
sudo apt install -y libnss3 libgtk-3-0 libx11-xcb1 libxtst6 libxss1 \
  libasound2 libdrm2 libgbm1 libxkbcommon0 libpango-1.0-0 libcairo2 \
  libatk1.0-0 libatk-bridge2.0-0 libcups2 libxcomposite1 libxdamage1 \
  libxfixes3 libxrandr2 libxrender1 libxi6 libnotify4 libsecret-1-0 \
  libpulse0 libdbus-1-3
```

## Feature Details

### Dual Flash Engine

Each tab independently selects its Flash engine:

- **PPAPI Native** (default): Adobe's official plugin, best compatibility
- **Ruffle WASM**: Open-source emulator, no native plugin required

Ruffle supports two sources:
- **Bundled**: Packaged with the app, works offline
- **CDN**: Always uses the latest Ruffle build, requires network on first load

Ruffle options: quality (`best`), forced scaling (`forceScale`), Chinese font fallback (SimHei).

### Tab Management

- Full navigation controls: back, forward, refresh, stop
- Real-time title and favicon sync
- Mute toggle and media playback indicators
- Per-tab zoom level
- Crash isolation — one tab crash never affects others
- Drag links to the tab bar to open in a new tab

### Password Manager

Uses CDP (Chrome DevTools Protocol) to capture login credentials with 8 capture strategies:

| Strategy | Use Case |
|----------|----------|
| `form.submit` | Traditional HTML form submission |
| `beforeunload` | Capture on page navigation |
| Polling (200ms) | AJAX login without page refresh |
| `fetch` / `xhr` interception | Extract credentials from request bodies |
| `sendBeacon` interception | Async login reporting |
| Script.src / Image.src interception | JSONP login (e.g., 7k7k) |
| MutationObserver | DOM mutation detection |

Encryption scheme:
- Master password → PBKDF2-SHA256 (250k iterations) → KEK
- DEK (Data Encryption Key) stored encrypted with KEK
- Each password encrypted with DEK via AES-256-GCM
- Master password requirements: 8+ characters, uppercase + lowercase + digits

### Download Manager

Dual-engine architecture with automatic fallback:

| Feature | aria2 | Chromium Built-in |
|---------|-------|-------------------|
| Multi-threaded | 16-segment split | Single thread |
| Resume | Supported | Limited |
| Speed | Faster | Standard |
| Priority | Bundled > System PATH | Fallback |

aria2 three-tier startup: bundled binary → system installation → downgrade to Chromium engine.

Security measures: directory traversal prevention, dangerous extension blacklist (`.exe/.bat/.cmd/.ps1/.vbs/.js/.wsf/.scr/.com`).

### Notifications

Uses an address bar flip animation as Toast notifications — since BrowserView always renders on top, traditional floating Toasts would be hidden behind it. Two modes:

- **Text-only messages**: Auto-dismiss (e.g., "Copied to clipboard")
- **Interactive overlays**: Require user action (e.g., "Save password?" with Save/Ignore buttons)

### Theme System

Supports Light / Dark / System three modes via CSS variables. All panels and UI elements adapt automatically.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+T` | New tab |
| `Ctrl+W` | Close current tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / Previous tab |
| `Ctrl+1` ~ `8` | Switch to tab N |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom in / out / reset |
| `Ctrl+Scroll` | Zoom (works over Flash content) |
| `Ctrl+L` / `Alt+D` | Focus address bar |
| `Ctrl+R` / `F5` | Reload |
| `Ctrl+D` | Bookmark current page |
| `Ctrl+H` | Open History panel |
| `Ctrl+F` | Find in page |
| `Ctrl+S` | Save page |
| `Ctrl+N` | New window |
| `Alt+←` / `Alt+→` | Back / Forward |
| `F11` | Toggle fullscreen |
| `F12` / `Ctrl+Shift+I` | Open DevTools |

## Project Structure

```
BaoFlashBrowser/
├── src/
│   ├── main/                          # Main process
│   │   ├── index.ts                   # Entry: window creation, module init
│   │   ├── modules/
│   │   │   ├── window.ts              # BrowserWindow (ready-to-show optimization)
│   │   │   ├── tabs.ts                # TabManager: BrowserView lifecycle
│   │   │   ├── flash.ts               # PPAPI plugin loader + mms.cfg
│   │   │   ├── session-manager.ts     # UA, crossdomain.xml, SWFObject patch, CORS
│   │   │   ├── download.ts            # aria2 download manager
│   │   │   ├── password-capture.ts    # CDP credential capture
│   │   │   ├── password-store.ts      # AES-256-GCM encrypted storage
│   │   │   ├── crypto-helper.ts       # Cryptographic utilities
│   │   │   ├── config.ts              # electron-store configuration
│   │   │   └── ruffle-bundle.ts       # Ruffle JS lazy loader
│   │   ├── ipc/                       # IPC handlers
│   │   │   ├── tabs.ipc.ts            # Tab operations (15 channels)
│   │   │   ├── window.ipc.ts          # Window controls (7 channels)
│   │   │   ├── shortcut.ipc.ts        # Global shortcuts + mouse hook
│   │   │   ├── download.ipc.ts        # Download management (10 channels)
│   │   │   ├── password.ipc.ts        # Password management (12 channels)
│   │   │   └── config.ipc.ts          # Config sync (2 channels)
│   │   └── utils/
│   │       └── ipc-wrapper.ts         # IPC handler wrapper (error handling + logging)
│   ├── renderer/                      # Renderer process (React)
│   │   ├── App.tsx                    # Root component
│   │   ├── index.tsx                  # Entry point (createRoot)
│   │   ├── styles.css                 # Global styles + custom components + animations
│   │   ├── components/
│   │   │   ├── layout/                # TopBar + DrawerSidebar
│   │   │   ├── navigation/            # RuffleToggle
│   │   │   ├── panels/                # Favorites / History / Downloads / Passwords / Settings
│   │   │   ├── tabs/                  # TabItem (React.memo)
│   │   │   ├── shell/                 # WindowControls
│   │   │   ├── overlays/              # FindBar / LoadingProgress
│   │   │   ├── newtab/                # NewTabPage
│   │   │   └── ErrorBoundary.tsx      # Error boundary
│   │   ├── hooks/                     # useTabManager / useTheme / useShortcut etc.
│   │   ├── store/                     # Zustand stores (useDataStore / useTabsStore)
│   │   ├── services/                  # db.ts (Dexie) / keyboard / url / id
│   │   └── types/                     # Type declarations (electron.d.ts)
│   ├── preload/index.ts               # Main window preload (contextBridge + IPC allowlist)
│   ├── webview-preload/index.ts       # Page preload (Ruffle + login detection + autofill)
│   └── shared/types/                  # Shared types (tab / settings / downloads / passwords / history / bookmarks / ipc)
├── plugins/                           # Flash plugins (bundled with app)
│   ├── linux64/libpepflashplayer64.so
│   ├── win32/pepflashplayer.dll
│   └── win64/pepflashplayer64.dll
├── native/                            # Native tools
│   ├── aria2/                         # Bundled aria2 binaries
│   ├── mouse-hook.exe                 # Windows mouse hook (WH_MOUSE_LL)
│   └── mouse-hook-linux               # Linux mouse hook (XRecord)
├── assets/
│   ├── images/                        # New tab background images
│   └── simhei.ttf                     # Chinese font (Ruffle fallback)
├── docs/
│   ├── PACKAGE.md                     # Packaging guide
│   └── lessons-learned.md             # v2 development lessons learned
├── test/                              # Standalone test scripts
├── build/                             # Icon resources
├── esbuild.main.config.mjs            # esbuild main process config
├── vite.renderer.config.ts            # Vite renderer config
└── package.json
```

## Developer Guide

### Compatibility Constraints

This project is locked to Electron 11 / Chromium 87. **Never upgrade any kernel-related components**:

- **Electron**: 11.5.0 is the last version with PPAPI Flash support
- **Tailwind CSS**: Locked to 3.4 — v4 uses `oklch()` color space and CSS `@property`, unsupported by Chromium 87
- **Node.js**: Electron 11 embeds Node 12; all dependencies must be compatible

### Critical Pitfalls

1. **CDP `debugger.attach` blocks `<script>` `onload` callbacks**: Always detach after password capture on non-`beforeunload` sources, or JSONP logins (e.g., 7k7k) will freeze
2. **Cross-origin iframes cannot use `executeJavaScript`**: Must use CDP `Runtime.evaluate` + `contextId`
3. **Login methods vary by site**: 4399 uses `<form>` submit, 7k7k uses `<script>` JSONP injection — probe before coding
4. **Linux requires `--no-sandbox`**; WSLg needs three GPU flags: `--ignore-gpu-blacklist`, `--enable-gpu-rasterization`, `--enable-zero-copy`
5. **Never call `wc.stop()` in `did-fail-load`**: It kills post-login redirects
6. **BrowserView always renders on top**: DOM elements cannot cover it; notifications require special handling

### Debugging Workflow

1. Map the full chain before touching code
2. Validate with standalone test scripts first (see `test/` directory)
3. Port to main project only after tests pass
4. For site-specific issues: probe actual network requests and DOM behavior with Python/Node.js + Playwright

## Flash Plugin Versions

| Version | Platform | Source | Notes |
|---------|----------|--------|-------|
| 29.0.0.171 | Windows | Official Adobe | No time bomb, no debug popups, stable |
| 32.0.0.371 | Linux | Official Adobe | Final pre-EOL release |
| ~~34.0.0.330~~ | ~~Windows~~ | ~~Zhongcheng~~ | Embedded debugger, AS3 error popups — not used |

Version 29 is not blocked by Taomee's `checkUpgrade` (which only blocks `major === 32`). Combined with version spoofing (34) and SWFObject bypass, this provides triple-layer compatibility.

## License

[MIT](LICENSE)
