#!/bin/bash
export PATH=/tmp/node-v18.20.4-linux-x64/bin:/usr/bin:/bin
cd /mnt/d/BaoFlashBrowser
rm -rf node_modules package-lock.json
npm install 2>&1
