#!/bin/sh
# Builds dist/clearurls-mv3.zip, ready to be loaded unpacked or uploaded to the Chrome Web Store.
set -eu
cd "$(dirname "$0")/.."
mkdir -p dist
rm -f dist/clearurls-mv3.zip
zip -qr dist/clearurls-mv3.zip \
    manifest.json background.js core content html js css img data _locales LICENSE \
    -x '*.DS_Store'
echo "wrote dist/clearurls-mv3.zip"
