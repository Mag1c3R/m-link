#!/bin/sh
# Рендерит картинки для Chrome Web Store из store/art.html в store/images/.
# Нужен Google Chrome. Сервер для страниц поднимается сам и останавливается в конце.
set -e
cd "$(dirname "$0")/.."
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PORT=8769
OUT=store/images
mkdir -p "$OUT"
python3 tests/serve.py $PORT >/dev/null 2>&1 &
SRV=$!
PROFILE=$(mktemp -d)
trap 'kill $SRV 2>/dev/null; rm -rf "$PROFILE"' EXIT
sleep 1

shot() { # kind width height file
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --user-data-dir="$PROFILE" --window-size="$2,$3" --virtual-time-budget=5000 \
    --screenshot="$OUT/$4.raw.png" "http://localhost:$PORT/store/art.html?kind=$1" >/dev/null 2>&1
  # Магазин просит PNG без альфа-канала: переводим в 24-битный RGB.
  python3 -c "import sys;from PIL import Image;Image.open(sys.argv[1]).convert('RGB').save(sys.argv[2])" "$OUT/$4.raw.png" "$OUT/$4.png"
  rm -f "$OUT/$4.raw.png"
  echo "$OUT/$4.png"
}

shot s1 1280 800 screenshot-1
shot s2 1280 800 screenshot-2
shot s3 1280 800 screenshot-3
shot s4 1280 800 screenshot-4
shot s5 1280 800 screenshot-5
shot small 440 280 promo-small-440x280
shot marquee 1400 560 promo-marquee-1400x560
