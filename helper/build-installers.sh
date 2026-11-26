#!/bin/sh
# Собирает установщики из уже собранных папок dist/ (сначала запусти build.sh с SINGBOX_DIR и XRAY_DIR):
#   dist/M-Link-Helper-macOS-arm64.pkg, dist/M-Link-Helper-macOS-intel.pkg — macOS (нужен pkgbuild)
#   dist/M-Link-Helper-Setup.exe — Windows (нужен makensis: brew install makensis)
# Подпись не делается: macOS и Windows покажут предупреждение о неизвестном разработчике.
set -eu
cd "$(dirname "$0")"
VERSION=$(sed -n 's/^var version = "\(.*\)"/\1/p' main.go)
I=installer

if command -v pkgbuild >/dev/null 2>&1; then
  for pair in "arm64:arm64" "amd64:x86_64"; do
    arch=${pair%%:*}; host=${pair#*:}
    src="dist/m-link-helper-darwin-$arch"
    [ -f "$src/sing-box" ] || { echo "в $src нет sing-box: собери build.sh с SINGBOX_DIR" >&2; exit 1; }
    work=$(mktemp -d)
    mkdir -p "$work/scripts/payload"
    cp "$I/macos/postinstall" "$work/scripts/"
    cp -R "$src/." "$work/scripts/payload/"
    pkgbuild --nopayload --scripts "$work/scripts" --identifier com.mlink.helper --version "$VERSION" "$work/helper.pkg" >/dev/null
    sed "s/__ARCH__/$host/; s/__VERSION__/$VERSION/" "$I/macos/distribution.xml" > "$work/distribution.xml"
    name=$([ "$arch" = arm64 ] && echo arm64 || echo intel)
    productbuild --distribution "$work/distribution.xml" --resources "$I/macos/resources" --package-path "$work" "dist/M-Link-Helper-macOS-$name.pkg" >/dev/null
    rm -rf "$work"
    echo "built dist/M-Link-Helper-macOS-$name.pkg"
  done
fi

if command -v makensis >/dev/null 2>&1; then
  src="$(pwd)/dist/m-link-helper-windows-amd64"
  [ -f "$src/sing-box.exe" ] || { echo "в $src нет sing-box.exe: собери build.sh с SINGBOX_DIR" >&2; exit 1; }
  LC_ALL=en_US.UTF-8 makensis -V2 -DVERSION="$VERSION" -DSRC="$src" -DOUT="$(pwd)/dist/M-Link-Helper-Setup.exe" "$I/windows/installer.nsi" >/dev/null
  echo "built dist/M-Link-Helper-Setup.exe"
fi
