#!/bin/sh
# Собирает архив расширения для Chrome Web Store: dist/m-link-<версия>-store.zip
# Отличие от папки extension/: из manifest.json убрано поле "key" (магазин его не принимает
# и выдаёт расширению свой ID), лишние файлы вроде .DS_Store не попадают.
set -e
cd "$(dirname "$0")"
VERSION=$(python3 -c "import json;print(json.load(open('extension/manifest.json'))['version'])")
OUT="dist/m-link-$VERSION-store.zip"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cp -R extension/ "$TMP/ext"
find "$TMP/ext" -name '.DS_Store' -delete
python3 - "$TMP/ext/manifest.json" <<'PY'
import json, sys
p = sys.argv[1]
m = json.load(open(p, encoding='utf-8'))
m.pop('key', None)
json.dump(m, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
open(p, 'a').write('\n')
PY
mkdir -p dist
rm -f "$OUT"
(cd "$TMP/ext" && zip -qrX "$OLDPWD/$OUT" .)
echo "$OUT"
