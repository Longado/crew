#!/usr/bin/env bash
# 把 docs/logo-*.svg 和 crew-icon.svg 渲染成 PNG（透明底，2 倍）。无头 Chrome 截完不会自己退出，所以最后要杀掉。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
python3 "$ROOT/scripts/make-logo.py"
render() { # 名字 宽 高
  local tmp; tmp="$(mktemp -d)"
  rm -f "$ROOT/docs/$1.png"  # 不删旧图，下面会把旧图当成刚渲染好的
  printf '<html><body style="margin:0;background:transparent"><img src="file://%s/docs/%s.svg" width="%s" height="%s"></body></html>' "$ROOT" "$1" "$2" "$3" > "$tmp/p.html"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 \
    --force-device-scale-factor=2 --window-size="$2,$3" --screenshot="$ROOT/docs/$1.png" "file://$tmp/p.html" >/dev/null 2>&1 &
  local pid=$!
  for _ in $(seq 1 40); do [ -s "$ROOT/docs/$1.png" ] && break; sleep 0.5; done
  sleep 1; kill "$pid" 2>/dev/null || true; pkill -f "$tmp" 2>/dev/null || true; rm -rf "$tmp"
}
render logo-light 960 228
render logo-dark 960 228
render crew-icon 360 192
