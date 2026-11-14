#!/usr/bin/env bash
# Builds Gruppetto HUD.app next to this script: overlay/build.sh
set -euo pipefail
cd "$(dirname "$0")"
app="Gruppetto HUD.app"
rm -rf "$app" && mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
swiftc -O -parse-as-library -o "$app/Contents/MacOS/GruppettoHUD" GruppettoHUD.swift \
  -framework AppKit -framework SwiftUI -framework Network 2>&1 | grep -v "^$" || true
test -x "$app/Contents/MacOS/GruppettoHUD"
iconset="$(mktemp -d)/AppIcon.iconset"
swift icon.swift "$iconset"
iconutil -c icns "$iconset" -o "$app/Contents/Resources/AppIcon.icns"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Gruppetto HUD</string>
  <key>CFBundleDisplayName</key><string>Gruppetto HUD</string>
  <key>CFBundleIdentifier</key><string>com.automation-remarks.gruppetto-hud</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleExecutable</key><string>GruppettoHUD</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.1</string>
  <key>CFBundleVersion</key><string>2</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
codesign --force -s - "$app" >/dev/null 2>&1 || true # ad hoc: runs on this Mac
# the zip that Profile's «Download for Mac» points at: attach it to a GitHub release as Gruppetto-HUD.zip
rm -f Gruppetto-HUD.zip && ditto -c -k --keepParent "$app" Gruppetto-HUD.zip
echo "Built: $(pwd)/$app and $(pwd)/Gruppetto-HUD.zip"
