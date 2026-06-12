#!/bin/bash
export PATH=/tmp/node-v18.20.4-linux-x64/bin:/usr/bin:/bin
cd /mnt/d/BaoFlashBrowser
./node_modules/.bin/electron . --no-sandbox 2>&1 &
sleep 5
echo "LAUNCHED"
