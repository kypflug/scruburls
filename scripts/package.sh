#!/bin/sh
# Builds dist/scruburls.zip, ready to be loaded unpacked or uploaded to the Chrome Web Store.
set -eu
cd "$(dirname "$0")/.."
mkdir -p dist
rm -f dist/scruburls.zip
zip -qr dist/scruburls.zip \
    manifest.json background.js core content html js css img data _locales LICENSE \
    -x '*.DS_Store'
echo "wrote dist/scruburls.zip"
