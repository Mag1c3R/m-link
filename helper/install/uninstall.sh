#!/bin/sh
# Удаление помощника M-Link (macOS и Linux).
HOST_NAME="com.mclient.helper"
case "$(uname -s)" in
  Darwin) DEST="$HOME/Library/Application Support/MClient"; BASE="$HOME/Library/Application Support" ;;
  *) DEST="$HOME/.local/share/mclient"; BASE="$HOME/.config" ;;
esac
find "$BASE" -maxdepth 4 -path "*NativeMessagingHosts/$HOST_NAME.json" -exec rm -f {} \; 2>/dev/null
rm -rf "$DEST"
echo "Помощник удалён."
