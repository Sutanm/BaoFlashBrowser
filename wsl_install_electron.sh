#!/bin/bash
export PATH=/tmp/node-v18.20.4-linux-x64/bin:/usr/bin:/bin
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
cd /mnt/d/BaoFlashBrowser
node node_modules/electron/install.js 2>&1
echo "INSTALL_EXIT=$?"
