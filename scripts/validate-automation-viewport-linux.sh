#!/usr/bin/env bash
set -eu

project_root="${1:-$PWD}"
case "$project_root" in
  /*) ;;
  *) echo "project root must be absolute" >&2; exit 2 ;;
esac

cd "$project_root"
probe_dir=$(mktemp -d /tmp/bao-viewport-probe.XXXXXX)
trap 'rm -rf -- "$probe_dir"' EXIT
echo "PROBE_DIR=$probe_dir"
cp -a release/linux-unpacked/. "$probe_dir/"
node node_modules/@electron/asar/bin/asar.js pack tests/electron "$probe_dir/resources/app.asar"
BAO_PROBE_ROOT="$project_root" "$probe_dir/bao-flash-browser" --no-sandbox
echo "Linux viewport probe passed."
