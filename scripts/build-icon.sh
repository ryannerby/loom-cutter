#!/bin/bash
# Build the macOS .icns from the master logo and wire it into the .app bundle.
#
# Usage:
#   ./scripts/build-icon.sh [path/to/source.png]
#
# Defaults to design/loom-cutter-logo.png if no argument given. Source can be
# any square PNG ≥ 512×512; 1024×1024+ recommended.

set -e
cd "$(dirname "$0")/.."

SRC="${1:-design/loom-cutter-logo.png}"
if [ ! -f "$SRC" ]; then
  echo "error: source image '$SRC' not found"
  exit 1
fi

ICONSET=".tmp.iconset"
ICNS="LoomCutter.app/Contents/Resources/LoomCutter.icns"
MASTER=".tmp-icon-1024.png"

# Standardize to a 1024×1024 master before slicing.
echo "[icon] preparing 1024x1024 master from $SRC"
sips -z 1024 1024 "$SRC" --out "$MASTER" > /dev/null

# Generate the size variants Apple expects in an .iconset folder.
echo "[icon] slicing iconset"
rm -rf "$ICONSET"
mkdir "$ICONSET"
for spec in "16:icon_16x16" "32:icon_16x16@2x" \
            "32:icon_32x32" "64:icon_32x32@2x" \
            "128:icon_128x128" "256:icon_128x128@2x" \
            "256:icon_256x256" "512:icon_256x256@2x" \
            "512:icon_512x512" "1024:icon_512x512@2x"; do
  size="${spec%:*}"; name="${spec#*:}"
  sips -z "$size" "$size" "$MASTER" --out "$ICONSET/$name.png" > /dev/null
done

# Pack to .icns
mkdir -p "$(dirname "$ICNS")"
iconutil -c icns "$ICONSET" -o "$ICNS"
rm -rf "$ICONSET" "$MASTER"

# Also drop a 512px PNG into ui/public for the browser favicon.
echo "[icon] generating favicon"
mkdir -p ui/public
sips -z 512 512 "$SRC" --out ui/public/favicon.png > /dev/null

echo "[icon] done"
echo "  → $ICNS"
echo "  → ui/public/favicon.png"
echo
echo "Add to LoomCutter.app/Contents/Info.plist (if not already):"
echo '  <key>CFBundleIconFile</key>'
echo '  <string>LoomCutter</string>'
echo
echo "Refresh Finder to see the new icon:"
echo "  killall Finder"
