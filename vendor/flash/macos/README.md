# Experimental macOS PPAPI source

`install_flash_player_osx_ppapi.dmg` is the build-time source for the integrated,
completely untested macOS Flash path.

- Manifest version: `34.0.0.380`
- Manifest architecture: `mac`
- DMG SHA-256: `2298f867c2938dee306b6e80f212093df1def2cf06d7f5b5542f0879a9eff686`
- Final package target: Intel x64 (`darwin-x64`)

The DMG itself is not copied into the application. `scripts/prepare-macos-flash.sh`
uses the package's own x64 finalizer in a temporary directory and copies only the
decoded `PepperFlashPlayer.plugin` bundle and its manifest into the packaged resources.
The finalizer is invoked with its built-in `-disableAnalytics` switch.
