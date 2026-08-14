# Automation M0 probes

These probes answer architecture questions before the automation workbench is
connected to production BrowserViews. They intentionally use the repository's
pinned Electron runtime and BrowserView rather than a system browser.

## Input probe

```bash
npx electron tests/electron/automation-m0-input-smoke.cjs
```

It verifies a focused `sendInputEvent` baseline, minimized capture, transient
CDP mouse and keyboard input, trusted event delivery, debugger cleanup, and
navigation after detach. Evidence is written to `release/automation-probe/`.

Passing this HTML fixture is necessary but not sufficient. PPAPI and Ruffle
fixtures must pass separately before the product promises minimized automation
for those engines.

## Visual loop and Blockly probes

```bash
npm run probe:automation-visual
npm run probe:automation-blockly
npm run probe:automation-flash
```

The visual probe builds a template from one rendering, moves the target, keeps
the window minimized, locates the target with OpenCV, converts device pixels to
CSS pixels, and clicks it with transient CDP input. The Blockly probe creates a
custom automation block and verifies a JSON save/load round trip on Chromium 87.
The Flash probe runs the same upstream interactive SWF in bundled Ruffle and
native PPAPI, minimizes each host, dispatches transient CDP input and records
pixel evidence. Ruffle input evidence is required. If Chromium registers the
bundled PPAPI DLL but renders its "cannot load plugin" placeholder, the probe
records `rendered: false` as an explicit host-environment blocker instead of
mistaking the placeholder screenshot for an input failure.

## M1 workbench

```bash
npm run demo:automation
npm run probe:automation-workbench
```

The standalone workbench scans a user-selected folder in the renderer, keeps
subdirectory asset ids, provides image/action/branch/repeat blocks, and exports
both Blockly workspace state and executable workflow JSON. The package loader,
asset watcher and deterministic runtime live under `src/main/modules/automation`.

## M2 visual driver

```bash
npm run probe:automation-m2
```

This builds a dedicated OpenCV visual worker plus an Electron smoke bundle, then
runs the workflow interpreter against a minimized BrowserView. It verifies ROI
matching, device-to-CSS coordinate conversion, a trusted click, and debugger
cleanup through the production-shaped driver boundary.
