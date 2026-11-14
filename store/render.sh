#!/bin/sh
# Рендерит картинки для Chrome Web Store из store/art.html: русские в store/images/, английские в store/images/en/.
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

shot() { # lang kind width height file
  dir="$OUT"
  if [ "$1" = en ]; then dir="$OUT/en"; fi
  mkdir -p "$dir"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --force-dark-mode \
    --user-data-dir="$PROFILE" --window-size="$3,$4" --virtual-time-budget=5000 \
    --screenshot="$dir/$5.raw.png" "http://localhost:$PORT/store/art.html?kind=$2&lang=$1" >/dev/null 2>&1
  # Магазин просит PNG без альфа-канала: переводим в 24-битный RGB.
  python3 -c "import sys;from PIL import Image;Image.open(sys.argv[1]).convert('RGB').save(sys.argv[2])" "$dir/$5.raw.png" "$dir/$5.png"
  rm -f "$dir/$5.raw.png"
  echo "$dir/$5.png"
}

# Русские картинки — в store/images/, английские — в store/images/en/.
for lang in ru en; do
  shot $lang s1 1280 800 screenshot-1
  shot $lang s2 1280 800 screenshot-2
  shot $lang s3 1280 800 screenshot-3
  shot $lang s4 1280 800 screenshot-4
  shot $lang s5 1280 800 screenshot-5
  shot $lang small 440 280 promo-small-440x280
  shot $lang marquee 1400 560 promo-marquee-1400x560
done
