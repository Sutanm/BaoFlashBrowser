# Win32 Tesseract OCR

Win32 uses a native x86 BAO1 sidecar. Win64 and Linux x64 continue to use Paddle.
The sidecar reads BGRA frames from stdin and returns recognized text lines, confidence
in `[0,1]`, and four-point pixel bounds. It uses Tesseract PSM 6, `chi_sim+eng`, and
one OpenMP thread, matching the evaluated text-block configuration.

`npm run prepare:ocr:tesseract` verifies and extracts the pinned vendor archive to
`native/ocr/win32`, then uses installed MSVC x86 tools to compile the sidecar with
the static C++ runtime (`/MT`). Installed users need neither MSVC nor .NET.
`npm run build:win32` embeds this runtime. Use `build:win32:standard` explicitly
for a build without OCR.

`vendor/tesseract-win32.zip` contains the native DLL dependency closure and Chinese /
English fast models, not the evaluation C# worker. `vendor/manifest.json` pins all
files by SHA-256. The archive includes the original Tesseract license, authors and
README, plus upstream provenance and model sources in `THIRD-PARTY-NOTICE.txt`.

Provenance:

- UB Mannheim `tesseract-ocr-w32-setup-5.3.0.20221222.exe`, retrieved from the
  Chocolatey `tesseract-ocr/5.3.0.20221222` archive.
- Installer SHA-256:
  `33d7824a440e1660b74dc55f10355b346a22fdbe430143f7f6885cfa3cfdf7e7`.
- DLLs were copied with their transitive native dependencies; only debug sections
  were stripped. The Windows import/export tables remain intact.
- Models: `tesseract-ocr/tessdata_fast`, commit
  `87416418657359cb625c412a48b6e1d6d41c29bd`.
- Chinese Git blob SHA-1: `388bac276d033d06e5ed5ba7a7ad14ae58f97dab`.
- English Git blob SHA-1: `bbef4675053b5b468cdb477053e28b1c698ba08e`.

Validation: the native runtime integration test verifies Chinese text, confidence,
coordinates, numeric reading, and a blank frame. Packaging checks all DLLs are
ia32 and all pinned runtime/model resources match their SHA-256 values.

The effect evaluation and its limitations are recorded in
`docs/automation-v2/2026-11-02-tesseract-x86-comparison.md`. Small outlined game
sprites remain a weak case; adding Win32 support does not imply parity with Paddle.
