# `.baoauto` v3 contract quick reference

Use this reference only when the BaoFlashBrowser repository or its current Automation documentation is
not available. The target application's schema remains authoritative.

## Package shape

```text
manifest.json
workflow.json          # optional Blockly WorkflowDocumentV3
scripts/*.js|ts        # optional sandboxed frontends
assets/**              # optional images and image-group folders
profiles/*.json        # optional entry/variable/Surface presets
```

The manifest uses `format: "baoauto"` and `formatVersion: 3`. It declares optional workflow and script
frontends, the main entry, features, script permissions, optional capture-reference metadata, and a
SHA-256 integrity map for package content. Grants are stored outside the package and cannot be awarded by
editing the manifest.

The package needs at least one runnable frontend. Paths are relative POSIX paths. Absolute paths, drive
letters, backslashes, empty segments, `.` and `..` are invalid. Current default budgets are 64 MiB
compressed, 2,000 entries, 16 MiB per entry, and 128 MiB total extracted content.

## Sandboxed JS/TS capabilities

Request only what is used:

- `input`
- `vision`
- `ocr`
- `page.read`
- `page.navigate`
- `log`
- `notify`

The frozen `bao.*` API provides input click/move/drag/key/type/scroll; image and existence lookup;
region-change and color waits; OCR find/read; page URL/navigation/reload; monotonic task time/sleep;
logging; and notification. Exact signatures must be checked in the target build's “接口文档”.

## Coordinates and assets

Persisted relative coordinates use `0..10000` in a selected page, game Surface, or Region context.
Game-surface coordinates are recommended only for content that is actually stable relative to that
Surface. They are not mandatory.

Captured assets may record whether they came from a viewport, Region, or Surface plus capture dimensions
and viewport transform. Externally imported assets may lack this metadata; the matcher can search scales,
but real-scene validation remains necessary.

Image groups represent visual alternatives for one semantic target. Thresholds are acceptance gates, not
proof of identity. Validate the match rectangle against positive and negative scenes.
