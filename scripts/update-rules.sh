#!/bin/sh
# Refreshes the bundled copy of the ClearURLs rules (data/data.minify.json + data/rules.minify.hash).
set -eu
cd "$(dirname "$0")/.."
RULE_URL="${RULE_URL:-https://rules2.clearurls.xyz/data.minify.json}"
HASH_URL="${HASH_URL:-https://rules2.clearurls.xyz/rules.minify.hash}"

curl -sSfL "$RULE_URL" -o data/data.minify.json.tmp
curl -sSfL "$HASH_URL" | tr -d '[:space:]' > data/rules.minify.hash.tmp
echo >> data/rules.minify.hash.tmp

LOCAL_HASH="$(printf '%s' "$(cat data/data.minify.json.tmp)" | sha256sum | cut -d' ' -f1)"
REMOTE_HASH="$(tr -d '[:space:]' < data/rules.minify.hash.tmp)"

if [ "$LOCAL_HASH" != "$REMOTE_HASH" ]; then
    echo "hash mismatch: downloaded rules hash to $LOCAL_HASH, expected $REMOTE_HASH" >&2
    rm -f data/data.minify.json.tmp data/rules.minify.hash.tmp
    exit 1
fi

mv data/data.minify.json.tmp data/data.minify.json
mv data/rules.minify.hash.tmp data/rules.minify.hash
node -e "const d=require('./data/data.minify.json');console.log('bundled rules updated:', Object.keys(d.providers).length, 'providers, hash', '$REMOTE_HASH')"
