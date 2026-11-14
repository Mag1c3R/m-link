#!/bin/sh
# Установка помощника M-Link для macOS и Linux.
# Запуск: sh install.sh [ID_расширения ...]
set -eu
HOST_NAME="com.mlink.helper"
OLD_HOST_NAME="com.mclient.helper" # имя до переименования в M-Link
EXT_IDS="${*:-aghdgobidfiogibjlpfhdegieiaiakgm}"
SRC="$(cd "$(dirname "$0")" && pwd)"
: "${HOME:?не задана переменная HOME}"

case "$(uname -s)" in
  Darwin)
    DEST="$HOME/Library/Application Support/MLink"
    BASE="$HOME/Library/Application Support"
    OLD_DIRS="$HOME/Library/Application Support/MClient"
    TARGETS="Google/Chrome
Google/Chrome Beta
Google/Chrome Canary
Chromium
BraveSoftware/Brave-Browser
Microsoft Edge
Yandex/YandexBrowser
Vivaldi
Arc/User Data"
    ;;
  *)
    DEST="$HOME/.local/share/mlink"
    BASE="$HOME/.config"
    OLD_DIRS="$HOME/.local/share/mclient
$HOME/.config/MClient"
    TARGETS="google-chrome
google-chrome-beta
chromium
BraveSoftware/Brave-Browser
microsoft-edge
yandex-browser
vivaldi"
    ;;
esac

if [ ! -f "$SRC/m-link-helper" ]; then
  echo "Не найден файл m-link-helper рядом с установщиком. Запусти install.sh из распакованной папки." >&2
  exit 1
fi

mkdir -p "$DEST"
# Сначала удаляем старые файлы: перезапись работающей программы на месте ломает её подпись в macOS.
rm -f "${DEST:?}/m-link-helper" "${DEST:?}/sing-box" "${DEST:?}/xray" "${DEST:?}/libcronet.so"
cp "$SRC/m-link-helper" "$DEST/m-link-helper"
chmod 755 "$DEST/m-link-helper"
if [ -f "$SRC/sing-box" ]; then
  cp "$SRC/sing-box" "$DEST/sing-box"
  chmod 755 "$DEST/sing-box"
fi
# xray нужен для серверов на транспорте XHTTP, которого нет в sing-box.
if [ -f "$SRC/xray" ]; then
  cp "$SRC/xray" "$DEST/xray"
  chmod 755 "$DEST/xray"
fi
# Сборки sing-box для Linux идут с библиотекой libcronet.so, она должна лежать рядом.
if [ -f "$SRC/libcronet.so" ]; then cp "$SRC/libcronet.so" "$DEST/libcronet.so"; fi
# Файлы, скачанные браузером, macOS помечает карантином; снимаем метку только с наших файлов.
if [ "$(uname -s)" = "Darwin" ]; then
  xattr -d com.apple.quarantine "$DEST/m-link-helper" 2>/dev/null || true
  for f in sing-box xray; do
    if [ -f "$DEST/$f" ]; then xattr -d com.apple.quarantine "$DEST/$f" 2>/dev/null || true; fi
  done
fi

ORIGINS=""
for id in $EXT_IDS; do
  if [ -n "$ORIGINS" ]; then ORIGINS="$ORIGINS, "; fi
  ORIGINS="$ORIGINS\"chrome-extension://$id/\""
done

MANIFEST=$(cat <<JSON
{
  "name": "$HOST_NAME",
  "description": "M-Link helper",
  "path": "$DEST/m-link-helper",
  "type": "stdio",
  "allowed_origins": [$ORIGINS]
}
JSON
)

installed=""
OLDIFS="$IFS"
IFS="
"
for t in $TARGETS; do
  if [ -d "$BASE/$t" ]; then
    hosts="${BASE:?}/${t:?}/NativeMessagingHosts"
    mkdir -p "$hosts"
    printf '%s\n' "$MANIFEST" > "$hosts/$HOST_NAME.json"
    # Регистрация прежней версии (M-Client) больше не нужна.
    rm -f "${hosts:?}/${OLD_HOST_NAME:?}.json"
    installed="$installed\n  - $t"
  fi
done
# Убираем папки прежней версии (M-Client).
for d in $OLD_DIRS; do
  case "$d" in
    */MClient|*/mclient) if [ -d "$d" ]; then rm -rf "${d:?}"; fi ;;
  esac
done
IFS="$OLDIFS"

echo "Помощник M-Link установлен в: $DEST"
if [ -n "$installed" ]; then
  printf "Зарегистрирован для браузеров:%b\n" "$installed"
else
  echo "Не нашёл ни одного браузера на Chromium. Установи Chrome и запусти установку ещё раз."
fi
if ! [ -f "$DEST/sing-box" ] && ! command -v sing-box >/dev/null 2>&1; then
  echo
  echo "Внимание: sing-box не найден. Положи файл sing-box в $DEST"
  echo "или установи его сам (например, brew install sing-box)."
fi
echo "Готово. Открой расширение M-Link и нажми «Проверить»."
