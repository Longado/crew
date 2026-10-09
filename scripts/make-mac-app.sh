#!/usr/bin/env bash
# 生成 macOS 桌面应用：dist/Crew.app。双击：后台启动本地服务，用独立窗口打开。
# 它是这个仓库的启动器，里面记着仓库位置和 node 位置；仓库挪了地方要重新生成。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "找不到 node，先装 Node 22.18 或更新版本" >&2; exit 1; }
VERSION="$(node -p "require('$ROOT/package.json').version")"
APP="$ROOT/dist/Crew.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# 启动器。从访达启动的程序拿不到 Homebrew 的路径，把 node 所在目录补进去
cat > "$APP/Contents/MacOS/Crew" <<LAUNCH
#!/bin/bash
export PATH="$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:\$PATH"
exec "$ROOT/bin/crew" app "\$@"
LAUNCH
chmod +x "$APP/Contents/MacOS/Crew"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Crew</string>
  <key>CFBundleDisplayName</key><string>Crew</string>
  <key>CFBundleIdentifier</key><string>io.github.longado.working-corpus</string>
  <key>CFBundleExecutable</key><string>Crew</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
</dict></plist>
PLIST

# 图标：把像素 logo 渲染成 1024 像素的方图，再做成 icns。没有 Chrome 就不带图标
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ -x "$CHROME" ] && command -v iconutil >/dev/null; then
  TMP="$(mktemp -d)"
  printf '<!doctype html><style>html,body{margin:0;background:transparent}img{display:block;width:824px;height:824px;margin:100px;image-rendering:pixelated}</style><img src="file://%s/web/logo.svg">' "$ROOT" > "$TMP/icon.html"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 --window-size=1024,1024 --allow-file-access-from-files --screenshot="$TMP/icon.png" "file://$TMP/icon.html" >/dev/null 2>&1 || true
  if [ -f "$TMP/icon.png" ]; then
    mkdir -p "$TMP/icon.iconset"
    for s in 16 32 128 256 512; do
      sips -z $s $s "$TMP/icon.png" --out "$TMP/icon.iconset/icon_${s}x${s}.png" >/dev/null
      sips -z $((s*2)) $((s*2)) "$TMP/icon.png" --out "$TMP/icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
    done
    iconutil -c icns "$TMP/icon.iconset" -o "$APP/Contents/Resources/icon.icns"
  fi
  rm -rf "$TMP"
else
  echo "没有 Chrome 或 iconutil，应用不带图标" >&2
fi
echo "已生成：$APP"
