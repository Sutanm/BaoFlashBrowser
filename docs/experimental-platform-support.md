# Experimental Flash and macOS support (1.1.1)

## Support boundary

The stable channel remains unchanged:

- Windows x64/x86 uses the existing project plugins.
- Linux x64 uses the existing project plugin.
- macOS has no stable Flash channel.

The experimental channel contains every currently unverified or known-unstable Flash path:

- Windows x64 China-modified Flash 34.0.0.380.
- Its external `Flash Helper Service` dependency and any component/update-service behavior.
- All macOS PPAPI behavior.

Selecting an experimental plugin requires an application restart. If a Windows experimental
plugin is absent, the resolver logs the reason and falls back to the stable plugin. macOS has
no stable fallback; when no experimental plugin is found, PPAPI remains unavailable instead
of reporting a false success.

## macOS status

The macOS build is **experimental and completely untested on macOS hardware**.

- Target: Intel x64 only.
- Apple Silicon: may run through Rosetta 2; this has not been tested.
- Code signing, notarization, rendering, audio, input, fullscreen, background execution,
  game heartbeat, plugin dialogs, and crash recovery have not been tested.
- The current repository does not bundle a decoded `PepperFlashPlayer.plugin`.

When the experimental channel is enabled, the resolver checks these locations in order:

1. `resources/plugins/experimental/mac/PepperFlashPlayer.plugin`
2. `~/Library/Internet Plug-Ins/PepperFlashPlayer/PepperFlashPlayer.plugin`
3. `/Library/Internet Plug-Ins/PepperFlashPlayer/PepperFlashPlayer.plugin`

To prepare a bundled test build, place the complete plugin bundle at:

```text
plugins/experimental/mac/PepperFlashPlayer.plugin
```

Do not place only the Mach-O executable there; the complete `.plugin` bundle and companion
resources are required.

## Build

Run on an Intel Mac or Apple Silicon Mac with Rosetta 2 and an x64-capable toolchain:

```bash
npm ci
npm run build:mac
```

Artifacts are named `BaoFlashBrowser-Experimental-1.1.1-x64.dmg` and `.zip`.
The build name, application title, diagnostics, and settings UI all identify the macOS build
as experimental. A successful package build is not evidence that Flash works.

## Minimum test gate before promotion

Do not promote macOS or China-modified Flash to the stable channel until real hardware passes:

1. Plugin enumeration and a minimal local SWF.
2. At least two real AS3 games for 30 minutes each.
3. Audio, keyboard, mouse, IME, fullscreen, screenshots, and automation input.
4. Background tabs and minimized-window heartbeat for at least 30 minutes.
5. Login redirects with password capture enabled and disabled.
6. Repeated cold starts without component-error pages or debugger dialogs.
7. Memory and CPU observation with multiple game tabs.
