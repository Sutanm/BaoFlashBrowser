#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[prepare-macos-flash] This step must run on macOS." >&2
  exit 1
fi

project_root="$(cd "$(dirname "$0")/.." && pwd)"
source_dmg="$project_root/vendor/flash/macos/install_flash_player_osx_ppapi.dmg"
output_root="$project_root/plugins/experimental/mac"
output_plugin="$output_root/PepperFlashPlayer.plugin"
output_manifest="$output_root/manifest.json"
expected_dmg_sha256="2298f867c2938dee306b6e80f212093df1def2cf06d7f5b5542f0879a9eff686"
expected_version="34.0.0.380"

if [[ ! -f "$source_dmg" ]]; then
  echo "[prepare-macos-flash] Missing source image: $source_dmg" >&2
  exit 1
fi

actual_dmg_sha256="$(shasum -a 256 "$source_dmg" | awk '{print tolower($1)}')"
if [[ "$actual_dmg_sha256" != "$expected_dmg_sha256" ]]; then
  echo "[prepare-macos-flash] Source image checksum mismatch." >&2
  echo "  expected: $expected_dmg_sha256" >&2
  echo "  actual:   $actual_dmg_sha256" >&2
  exit 1
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/bao-macos-flash.XXXXXX")"
mount_dir="$work_dir/mount"
expanded_dir="$work_dir/expanded"
mkdir -p "$mount_dir"
mounted=0

cleanup() {
  if [[ "$mounted" == "1" ]]; then
    hdiutil detach "$mount_dir" -force >/dev/null 2>&1 || true
  fi
  rm -rf "$work_dir"
}
trap cleanup EXIT

echo "[prepare-macos-flash] Mounting verified experimental Flash image..."
hdiutil attach "$source_dmg" -readonly -nobrowse -mountpoint "$mount_dir" >/dev/null
mounted=1

package_path="$(find "$mount_dir" -type f -name 'Adobe Flash Player.pkg' -print -quit)"
if [[ -z "$package_path" ]]; then
  echo "[prepare-macos-flash] Adobe Flash Player.pkg was not found in the image." >&2
  exit 1
fi

pkgutil --expand-full "$package_path" "$expanded_dir"

plugin_lzma="$(find "$expanded_dir" -type f -path '*/Library/Internet Plug-Ins/PepperFlashPlayer/PepperFlashPlayer.plugin.lzma' -print -quit)"
finalizer="$(find "$expanded_dir" -type f -name finalize -print -quit)"
if [[ -z "$plugin_lzma" || -z "$finalizer" ]]; then
  echo "[prepare-macos-flash] Expanded package is missing the plugin payload or finalizer." >&2
  exit 1
fi

staging_root="${plugin_lzma%/Library/Internet Plug-Ins/PepperFlashPlayer/PepperFlashPlayer.plugin.lzma}"
staged_plugin="$staging_root/Library/Internet Plug-Ins/PepperFlashPlayer/PepperFlashPlayer.plugin"
staged_manifest="$staging_root/Library/Internet Plug-Ins/PepperFlashPlayer/manifest.json"

chmod +x "$finalizer"
echo "[prepare-macos-flash] Decoding the complete PepperFlashPlayer.plugin bundle..."
"$finalizer" "$staging_root" -disableAnalytics

plugin_binary="$staged_plugin/Contents/MacOS/PepperFlashPlayer"
if [[ ! -f "$plugin_binary" || ! -f "$staged_manifest" ]]; then
  echo "[prepare-macos-flash] Finalizer did not produce a complete plugin bundle." >&2
  exit 1
fi

manifest_version="$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["version"])' "$staged_manifest")"
if [[ "$manifest_version" != "$expected_version" ]]; then
  echo "[prepare-macos-flash] Plugin version is $manifest_version, expected $expected_version." >&2
  exit 1
fi

if ! lipo -archs "$plugin_binary" | tr ' ' '\n' | grep -qx 'x86_64'; then
  echo "[prepare-macos-flash] Plugin binary does not contain the required x86_64 architecture." >&2
  lipo -info "$plugin_binary" >&2 || true
  exit 1
fi

rm -rf "$output_plugin"
rm -f "$output_manifest"
ditto "$staged_plugin" "$output_plugin"
cp "$staged_manifest" "$output_manifest"

if find "$output_plugin" -type f -name '*.lzma' -print -quit | grep -q .; then
  echo "[prepare-macos-flash] Refusing to package an undecoded .lzma payload." >&2
  exit 1
fi

echo "[prepare-macos-flash] Prepared Flash $manifest_version: $output_plugin"
echo "[prepare-macos-flash] Architectures: $(lipo -archs "$output_plugin/Contents/MacOS/PepperFlashPlayer")"
