#!/bin/sh
# Удаление помощника M-Link (macOS и Linux).
HOST_NAME="com.mclient.helper"
case "$(uname -s)" in
  Darwin) DEST="$HOME/Library/Application Support/MClient"; BASE="$HOME/Library/Application Support" ;;
  *) DEST="$HOME/.local/share/mclient"; BASE="$HOME/.config" ;;
esac
find "$BASE" -maxdepth 4 -path "*NativeMessagingHosts/$HOST_NAME.json" -exec rm -f {} \; 2>/dev/null
rm -rf "$DEST"
# На Linux журнал и config.json помощник хранит в ~/.config/MClient (на macOS это та же папка, что и DEST).
rm -rf "$HOME/.config/MClient"
echo "Помощник удалён."
