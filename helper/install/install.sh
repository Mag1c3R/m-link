#!/bin/sh
# Установка помощника M-Client для macOS и Linux.
# Запуск: sh install.sh [ID_расширения]
set -e
HOST_NAME="com.mclient.helper"
EXT_ID="${1:-aghdgobidfiogibjlpfhdegieiaiakgm}"
SRC="$(cd "$(dirname "$0")" && pwd)"

case "$(uname -s)" in
  Darwin)
    DEST="$HOME/Library/Application Support/MClient"
    BASE="$HOME/Library/Application Support"
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
    DEST="$HOME/.local/share/mclient"
    BASE="$HOME/.config"
    TARGETS="google-chrome
google-chrome-beta
chromium
BraveSoftware/Brave-Browser
microsoft-edge
yandex-browser
vivaldi"
    ;;
esac

mkdir -p "$DEST"
cp "$SRC/m-client-helper" "$DEST/m-client-helper"
chmod 755 "$DEST/m-client-helper"
if [ -f "$SRC/sing-box" ]; then
  cp "$SRC/sing-box" "$DEST/sing-box"
  chmod 755 "$DEST/sing-box"
fi
# Сборки sing-box для Linux идут с библиотекой libcronet.so, она должна лежать рядом.
[ -f "$SRC/libcronet.so" ] && cp "$SRC/libcronet.so" "$DEST/libcronet.so"
# Файлы, скачанные из интернета, macOS помечает карантином; снимаем метку только с наших бинарников.
if [ "$(uname -s)" = "Darwin" ]; then
  xattr -d com.apple.quarantine "$DEST/m-client-helper" 2>/dev/null || true
  [ -f "$DEST/sing-box" ] && xattr -d com.apple.quarantine "$DEST/sing-box" 2>/dev/null || true
fi

MANIFEST=$(cat <<JSON
{
  "name": "$HOST_NAME",
  "description": "M-Client helper",
  "path": "$DEST/m-client-helper",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
JSON
)

installed=""
OLDIFS="$IFS"
IFS="
"
for t in $TARGETS; do
  if [ -d "$BASE/$t" ]; then
    mkdir -p "$BASE/$t/NativeMessagingHosts"
    printf '%s\n' "$MANIFEST" > "$BASE/$t/NativeMessagingHosts/$HOST_NAME.json"
    installed="$installed\n  - $t"
  fi
done
IFS="$OLDIFS"

echo "Помощник установлен в: $DEST"
if [ -n "$installed" ]; then
  printf "Зарегистрирован для браузеров:%b\n" "$installed"
else
  echo "Не нашёл ни одного браузера на Chromium. Установи Chrome и запусти скрипт ещё раз."
fi
if ! [ -f "$DEST/sing-box" ] && ! command -v sing-box >/dev/null 2>&1; then
  echo
  echo "Внимание: sing-box не найден. Положи бинарник sing-box в $DEST"
  echo "или установи его: brew install sing-box"
fi
echo "Готово. Перезапусти браузер, если расширение уже было открыто."
