BaoFlashBrowser 1.1.1 macOS Flash support is EXPERIMENTAL and completely untested.

The macOS packaging task decodes Flash 34.0.0.380 from the verified vendor image
and bundles the complete plugin at:
  plugins/experimental/mac/PepperFlashPlayer.plugin

Development builds without the generated bundle can also check:
  ~/Library/Internet Plug-Ins/PepperFlashPlayer/PepperFlashPlayer.plugin
  /Library/Internet Plug-Ins/PepperFlashPlayer/PepperFlashPlayer.plugin

Only the Intel x64 application is prepared. Apple Silicon requires Rosetta 2.
Do not describe this build as tested or stable until it passes on real macOS hardware.
