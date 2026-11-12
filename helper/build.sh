#!/bin/sh
# Собирает помощник под все платформы и упаковывает архивы для релиза.
#
#   sh build.sh                      — только помощник, в dist/m-link-helper-<платформа>/
#   SINGBOX_DIR=/путь sh build.sh    — плюс официальный sing-box из распакованных релизов
#                                      (папки вида sing-box-<версия>-<платформа>/) и архивы:
#                                      .tar.gz для macOS/Linux, .zip для Windows
#
# Список ID расширений берётся из install/extension-ids.txt.
# Релизы sing-box: https://github.com/SagerNet/sing-box/releases
set -eu
cd "$(dirname "$0")"
DEV_ID=aghdgobidfiogibjlpfhdegieiaiakgm
IDS=$(grep -v '^#' install/extension-ids.txt | grep -E '^[a-p]{32}$' | tr '\n' ' ' | sed 's/ $//')
if [ -z "$IDS" ]; then echo "install/extension-ids.txt пуст" >&2; exit 1; fi
ORIGINS=$(for id in $IDS; do printf '"chrome-extension://%s/", ' "$id"; done | sed 's/, $//')
SINGBOX_DIR="${SINGBOX_DIR:-}"
mkdir -p dist
find dist -mindepth 1 -delete
for target in darwin/arm64 darwin/amd64 linux/amd64 linux/arm64 windows/amd64; do
  os=${target%/*}; arch=${target#*/}
  plat="$os-$arch"
  name="m-link-helper-$plat"
  out="dist/$name"
  mkdir -p "$out"
  if [ "$os" = windows ]; then
    GOOS=$os GOARCH=$arch CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -H windowsgui" -o "$out/m-link-helper.exe" .
    for f in install.bat uninstall.bat; do perl -pe 's/\n/\r\n/' "install/$f" > "$out/$f"; done
    # На Windows путь в манифесте может быть относительным, поэтому манифест готовим заранее.
    printf '{\n  "name": "com.mlink.helper",\n  "description": "M-Link helper",\n  "path": "m-link-helper.exe",\n  "type": "stdio",\n  "allowed_origins": [%s]\n}\n' "$ORIGINS" > "$out/com.mlink.helper.json"
  else
    GOOS=$os GOARCH=$arch CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "$out/m-link-helper" .
    sed "s/$DEV_ID/$IDS/" install/install.sh > "$out/install.sh"
    cp install/uninstall.sh "$out/"
    chmod 755 "$out/install.sh" "$out/uninstall.sh"
    if [ "$os" = darwin ]; then cp install/install.command "$out/"; chmod 755 "$out/install.command"; fi
  fi
  if [ -n "$SINGBOX_DIR" ]; then
    sb=$(ls -d "$SINGBOX_DIR"/sing-box-*-"$plat" 2>/dev/null | head -1)
    if [ -z "$sb" ]; then echo "нет sing-box для $plat в $SINGBOX_DIR" >&2; exit 1; fi
    for f in sing-box sing-box.exe libcronet.so libcronet.dll; do
      if [ -f "$sb/$f" ]; then cp "$sb/$f" "$out/"; fi
    done
    cp "$sb/LICENSE" "$out/LICENSE-sing-box.txt"
    sbver=$(basename "$sb" | sed "s/^sing-box-//; s/-$plat\$//")
    printf 'В архив входит неизменённый sing-box %s из официального релиза:\nhttps://github.com/SagerNet/sing-box/releases/tag/v%s\nЛицензия: GPL-3.0-or-later (LICENSE-sing-box.txt). Исходный код:\nhttps://github.com/SagerNet/sing-box/tree/v%s\n' "$sbver" "$sbver" "$sbver" > "$out/THIRD_PARTY.txt"
    if [ "$os" = windows ]; then
      (cd dist && zip -qry "$name.zip" "$name")
    else
      (cd dist && COPYFILE_DISABLE=1 tar -czf "$name.tar.gz" "$name")
    fi
  fi
  echo "built $out"
done
