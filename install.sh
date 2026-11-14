#!/bin/sh
# Установка помощника M-Link одной командой (macOS и Linux):
#
#   curl -fsSL https://raw.githubusercontent.com/Mag1c3R/m-link/main/install.sh | sh
#
# Скачивает архив помощника для твоей системы из последнего релиза на GitHub,
# распаковывает во временную папку и запускает установщик из архива.
set -eu
BASE_URL="${MLINK_BASE_URL:-https://github.com/Mag1c3R/m-link/releases/latest/download}"

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "Эта команда работает на macOS и Linux. Для Windows скачай архив: https://github.com/Mag1c3R/m-link/releases/latest" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=amd64 ;;
  *) echo "Неподдерживаемый процессор: $(uname -m)" >&2; exit 1 ;;
esac
# Терминал под Rosetta на Mac с Apple Silicon сообщает x86_64: проверяем сам процессор.
if [ "$os" = darwin ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then arch=arm64; fi

name="m-link-helper-$os-$arch"
TMP=$(mktemp -d)
trap 'rm -rf "${TMP:?}"' EXIT
echo "Скачиваю ${name}…"
curl -fL --progress-bar -o "$TMP/helper.tar.gz" "$BASE_URL/$name.tar.gz"
tar -xzf "$TMP/helper.tar.gz" -C "$TMP"
sh "$TMP/$name/install.sh"
