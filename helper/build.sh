#!/bin/sh
# Собирает помощник под все платформы и упаковывает архивы для релиза.
#
#   sh build.sh                      — только помощник, в dist/<платформа>/
#   SINGBOX_DIR=/путь sh build.sh    — плюс официальный sing-box из распакованных релизов
#                                      (папки вида sing-box-<версия>-<платформа>/) и zip-архивы
#
# Релизы sing-box: https://github.com/SagerNet/sing-box/releases
set -e
cd "$(dirname "$0")"
VERSION=$(sed -n 's/^const version = "\(.*\)"/\1/p' main.go)
rm -rf dist
for target in darwin/arm64 darwin/amd64 linux/amd64 linux/arm64 windows/amd64; do
  os=${target%/*}; arch=${target#*/}
  plat="$os-$arch"
  out="dist/$plat"
  mkdir -p "$out"
  if [ "$os" = windows ]; then
    GOOS=$os GOARCH=$arch CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -H windowsgui" -o "$out/m-client-helper.exe" .
    for f in install.bat uninstall.bat; do perl -pe 's/\n/\r\n/' "install/$f" > "$out/$f"; done
  else
    GOOS=$os GOARCH=$arch CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "$out/m-client-helper" .
    cp install/install.sh install/uninstall.sh "$out/"
    [ "$os" = darwin ] && cp install/install.command "$out/"
  fi
  if [ -n "$SINGBOX_DIR" ]; then
    sb=$(ls -d "$SINGBOX_DIR"/sing-box-*-"$plat" 2>/dev/null | head -1)
    if [ -z "$sb" ]; then echo "нет sing-box для $plat в $SINGBOX_DIR" >&2; exit 1; fi
    for f in sing-box sing-box.exe libcronet.so libcronet.dll; do [ -f "$sb/$f" ] && cp "$sb/$f" "$out/"; done
    cp "$sb/LICENSE" "$out/LICENSE-sing-box.txt"
    sbver=$(basename "$sb" | sed "s/^sing-box-//; s/-$plat\$//")
    printf 'В архив входит неизменённый sing-box %s из официального релиза:\nhttps://github.com/SagerNet/sing-box/releases/tag/v%s\nЛицензия: GPL-3.0-or-later (LICENSE-sing-box.txt). Исходный код:\nhttps://github.com/SagerNet/sing-box/tree/v%s\n' "$sbver" "$sbver" "$sbver" > "$out/THIRD_PARTY.txt"
    (cd dist && zip -qry "m-client-helper-$VERSION-$plat.zip" "$plat")
  fi
  echo "built $out"
done
