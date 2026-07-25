#!/usr/bin/env bash
# Bump the release: APP_VERSION + APP_UPDATED in index.html and the SW cache
# name in sw.js, all in one step so they can never drift apart.
set -euo pipefail
cd "$(dirname "$0")"

cur=$(grep -oP "const APP_VERSION = 'v\K[0-9]+" index.html)
next=$((cur + 1))
today=$(date -u +%F)

sed -i "s/const APP_VERSION = 'v${cur}';/const APP_VERSION = 'v${next}';/" index.html
sed -i "s/const APP_UPDATED = '[0-9-]*';/const APP_UPDATED = '${today}';/" index.html
sed -i "s/const CACHE = 'mathquiz-v${cur}';/const CACHE = 'mathquiz-v${next}';/" sw.js

echo "Released v${next} (${today})"
grep -n "APP_VERSION\|APP_UPDATED" index.html | head -2
grep -n "const CACHE" sw.js
