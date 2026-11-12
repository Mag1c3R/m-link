#!/bin/sh
# Удаление помощника M-Link (macOS и Linux): программа, регистрация в браузерах, журнал и конфиг.
set -eu
: "${HOME:?не задана переменная HOME}"
case "$(uname -s)" in
  Darwin)
    BASE="$HOME/Library/Application Support"
    DIRS="$HOME/Library/Application Support/MLink
$HOME/Library/Application Support/MClient"
    ;;
  *)
    BASE="$HOME/.config"
    DIRS="$HOME/.local/share/mlink
$HOME/.config/MLink
$HOME/.local/share/mclient
$HOME/.config/MClient"
    ;;
esac
# Регистрации в браузерах: только наши два файла (новое и прежнее имя).
find "${BASE:?}" -maxdepth 4 \( -path "*NativeMessagingHosts/com.mlink.helper.json" -o -path "*NativeMessagingHosts/com.mclient.helper.json" \) -type f -delete 2>/dev/null || true
OLDIFS="$IFS"
IFS="
"
for d in $DIRS; do
  # Удаляем только папки помощника, и только если путь действительно оканчивается на их имя.
  case "$d" in
    */MLink|*/mlink|*/MClient|*/mclient) if [ -d "$d" ]; then rm -rf "${d:?}"; fi ;;
  esac
done
IFS="$OLDIFS"
echo "Помощник M-Link удалён."
