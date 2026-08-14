# BaoFlashBrowser

> A Flash game browser based on Electron 11.5.0 (Chromium 87), designed to keep PPAPI Flash content usable on current Windows and Linux systems.

[中文](README.md) **|** [English](README_EN.md)

[![CI](https://github.com/Sutanm/BaoFlashBrowser/actions/workflows/ci.yml/badge.svg)](https://github.com/Sutanm/BaoFlashBrowser/actions/workflows/ci.yml)
[![Electron](https://img.shields.io/badge/Electron-11.5.0-47848f)](https://www.electronjs.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux-blue)](#platform-support)
[![License](https://img.shields.io/badge/Source-MIT-green)](LICENSE)

Adobe Flash Player is no longer maintained, and modern browsers have removed PPAPI. BaoFlashBrowser remains fixed on Chromium 87, the last Chromium release with PPAPI support, and combines isolated BrowserView tabs, a Ruffle fallback, and compatibility handling for legacy game sites.

## Downloads

- [GitHub Releases](https://github.com/Sutanm/BaoFlashBrowser/releases)
- [Gitee Releases](https://gitee.com/sutanm/BaoFlashBrowser/releases)
- [v1.1.0 Release Notes](RELEASE_NOTES.md)

The Windows installers are currently **unsigned**. Microsoft Defender SmartScreen may display an “Unknown publisher” warning during installation or first launch. Download only from the project release pages and verify the published SHA-256 checksum.

## Platform Support

| Platform | Status | Notes |
| --- | --- | --- |
| Windows x64 | Primary | Recommended; includes PPAPI, aria2, and the mouse-wheel zoom hook |
| Windows ia32 | Not fully tested | Includes matching 32-bit PPAPI and aria2 binaries |
| Linux x64 | Limited | Running from source is recommended; AppImage behavior may vary with the distribution, FUSE, shared libraries, and X11/Wayland |
| Linux x86 / macOS | Unsupported | No complete PPAPI and native-resource support chain |

## Key Features

- Each tab uses an independent BrowserView, preventing one crashed Flash page from blanking every tab.
- PPAPI and Ruffle can be selected per tab; Ruffle supports bundled resources and a CDN `latest` fallback.
- Compatibility handling for Flash version checks, SWFObject, and login redirects on legacy game sites such as Taomee, 4399, and 7k7k.
- Tab management, navigation, zoom, mute, fullscreen, find-in-page, history, and bookmarks.
- Chromium and aria2 download engines with pause, resume, progress reporting, and path-safety checks.
- Optional password capture, locked-vault autofill, excluded sites, and master-password protection. Autofill never submits a form.
- Built-in userscript platform: Tampermonkey-style management page, two-phase install, sidebar script panel with menu commands, GM APIs, and page-shell enhancement scripts (including iframe sub-frame support).
- Visual automation platform: build `.baoauto` workflows with Blockly or JSON in `about:automation`, then locate and operate web or Flash UI from image assets.
- In-page floating automation assistant for start/stop controls, progress, live UI matching, and direct region capture from the current game frame without opening the sidebar.
- A scene-based asset test bench highlights the best match. Capture, matching, and trusted input can continue while the application is minimized.
- Session recovery is offered only after an abnormal exit; normal shutdown does not leave a recoverable session.
- Chinese and English UI, light and dark themes, Toast notifications, and optional inactive-tab suspension.

## Run from Source

Node.js 20 and npm are required. Electron is fixed at `11.5.0` and must not be upgraded.

```bash
git clone https://github.com/Sutanm/BaoFlashBrowser.git
cd BaoFlashBrowser
npm ci
npm start
```

### Linux Dependencies

On Ubuntu/Debian, install the graphical, audio, and system libraries required by Electron 11:

```bash
sudo apt install -y libnss3 libgtk-3-0 libx11-xcb1 libxtst6 libxss1 \
  libasound2 libdrm2 libgbm1 libxkbcommon0 libpango-1.0-0 libcairo2 \
  libatk1.0-0 libatk-bridge2.0-0 libcups2 libxcomposite1 libxdamage1 \
  libxfixes3 libxrandr2 libxrender1 libxi6 libnotify4 libsecret-1-0 \
  libpulse0 libdbus-1-3 libaria2-0
```

The `aria2c` executable shipped in the Linux build is dynamically linked and requires `libaria2.so.0`. Ubuntu/Debian provides it through `libaria2-0`; installing the `aria2` package also provides the dependency. If the library is unavailable, the application tries a system `aria2c` and then falls back to Chromium downloads.

Package names may differ on other distributions. The mouse-wheel zoom hook may not work under native Wayland; X11, XWayland, and WSLg are more reliable.

## Build Packages

```bash
npm run check       # Type checks, lint, unit tests, and build
npm run build:win64 # Windows x64 NSIS
npm run build:win32 # Windows ia32 NSIS (not fully tested)
npm run build:linux # Linux x64 AppImage; run on Linux/WSL
```

Release scripts validate Ruffle, fonts, PPAPI, aria2, mouse hooks, and target architectures. Manifests are written to `release/manifests/`.

## Common Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+T` / `Ctrl+W` | New / close tab |
| `Ctrl+L` | Focus the address bar |
| `Ctrl+Tab` | Switch tabs |
| `Ctrl++` / `Ctrl+-` / `Ctrl+0` | Page zoom |
| `Ctrl+F` | Find in page |
| `F11` / `F12` | Fullscreen / developer tools |

## Automation Quick Start

1. Open Automation from the sidebar, or navigate directly to `about:automation`.
2. Create a script and import image assets, or use the floating assistant's Capture tab to select UI directly from the game frame.
3. Build the workflow from Entry, Image, Input, Page, Flow, and Debug blocks, then save it.
4. Select the script in the floating assistant on the target page. Start immediately or after a countdown when its readiness condition is satisfied.
5. For animated targets, capture only a stable region and verify the highlighted match in the test bench before running the script.

The `.baoauto` package contains a validated JSON workflow and its image assets. See the [Automation User Guide](docs/automation-user-guide.md) (Chinese) for the complete workflow.

## Security and Limitations

Electron 11, Chromium 87, and Adobe Flash Player no longer receive security updates. Use this application only for trusted legacy game sites and local content. Do not use it for email, payments, cloud storage, business systems, or other sensitive activity. Prefer Ruffle whenever it can run the content correctly.

Windows uses Flash 29.0.0.171, while Linux uses 32.0.0.371. The version reported to websites may differ for legacy-site compatibility. Flash Player is proprietary software; users are responsible for understanding applicable licensing and distribution requirements in their jurisdiction.

## Developer Documentation

- [Architecture and Module Manual](docs/architecture-manual.md)
- [Userscript Developer Guide](docs/userscript-developer-guide.md) (platform extension and script authoring)
- [Userscript User Guide](docs/userscript-user-guide.md) (install, manage, FAQ)
- [Automation User Guide](docs/automation-user-guide.md) (workbench, capture, matching, execution, and package format; Chinese)
- [Packaging and Release Verification](docs/PACKAGE.md)
- [Test and Regression Checklist](docs/FINAL_REGRESSION.md)
- [Troubleshooting and Lessons Learned](docs/lessons-learned.md)
- [Third-Party Notices](THIRD_PARTY_NOTICES.md)

## License

BaoFlashBrowser source code is licensed under the [MIT License](LICENSE). Flash Player, Ruffle, aria2, fonts, and other bundled third-party components retain their respective licenses and rights; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
