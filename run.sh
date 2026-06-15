#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER_NAME="cn-apps"

case "${1:-start}" in
  shell)
    echo "[BaoFlashBrowser] Entering distrobox container..."
    distrobox enter "$CONTAINER_NAME"
    ;;
  install)
    echo "[BaoFlashBrowser] Installing npm dependencies..."
    distrobox enter "$CONTAINER_NAME" -- bash -c "cd '$SCRIPT_DIR' && npm install --ignore-scripts && printf electron > node_modules/electron/path.txt"
    ;;
  start)
    echo "[BaoFlashBrowser] Launching..."
    distrobox enter "$CONTAINER_NAME" -- /bin/bash -c '
      unset ELECTRON_RUN_AS_NODE ELECTRON_NO_ATTACH_CONSOLE VSCODE_ESM_ENTRYPOINT
      cd "'"$SCRIPT_DIR"'"
      export DISPLAY=":0"
      npm start
    '
    ;;
  *)
    echo "Usage: $0 {shell|install|start}"
    echo ""
    echo "  shell    - Enter the distrobox container"
    echo "  install  - Install npm dependencies"
    echo "  start    - Launch BaoFlashBrowser (default)"
    exit 1
    ;;
esac
