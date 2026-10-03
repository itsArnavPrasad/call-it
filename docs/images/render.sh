#!/bin/sh
# Render each src/<name>.html to <name>.png at 2x. Size comes from the page's <body> width/height.
cd "$(dirname "$0")"
CHROME=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
for f in src/*.html; do
  n=$(basename "$f" .html)
  size=$(grep -o 'body { width: [0-9]*px; height: [0-9]*px' "$f" | grep -o '[0-9]*' | paste -sd, -)
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --window-size="$size" --screenshot="$PWD/$n.png" "file://$PWD/$f" 2>/dev/null
  echo "$n.png ($size)"
done
