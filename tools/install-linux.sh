#!/usr/bin/env bash
#
# install-linux.sh — install a Lite Editor Linux build (.deb or AppImage)
#
# Usage:
#   ./tools/install-linux.sh                 # latest release, .deb preferred
#   ./tools/install-linux.sh 32              # build-32, .deb preferred
#   ./tools/install-linux.sh --appimage      # latest, AppImage preferred
#   ./tools/install-linux.sh 32 --appimage   # build-32, AppImage preferred
#
# The script downloads assets from the GitHub release `build-<N>` (or the
# latest release if no number is given) and installs them. No root is needed
# for the AppImage; the .deb path uses dpkg/apt and may ask for sudo.
#
set -euo pipefail

REPO="jmkoller21-blip/lite-editor"
API="https://api.github.com/repos/${REPO}"

BUILD=""
PREFER="deb"   # deb | appimage

# ---------------- argument parsing ----------------
while [ "$#" -gt 0 ]; do
  case "$1" in
    --appimage) PREFER="appimage"; shift ;;
    --deb)      PREFER="deb"; shift ;;
    --help|-h)
      echo "Usage: $0 [BUILD] [--deb|--appimage]"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *)  BUILD="$1"; shift ;;
  esac
done

# ---------------- resolve release ----------------
if [ -n "$BUILD" ]; then
  TAG="build-${BUILD}"
else
  TAG="latest"
fi

echo "==> Resolving release ${TAG}..."
RELEASE_JSON="$(curl -sS "${API}/releases/tags/${TAG}" || true)"
if [ -z "$RELEASE_JSON" ] || echo "$RELEASE_JSON" | grep -q '"message": "Not Found"'; then
  echo "==> Release ${TAG} not found, falling back to latest release..." >&2
  RELEASE_JSON="$(curl -sS "${API}/releases/latest" || true)"
  TAG="latest"
fi

RELEASE_NAME="$(echo "$RELEASE_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('name','(unnamed)')" 2>/dev/null || echo "(unknown)")"
echo "==> Release: ${RELEASE_NAME}"

# ---------------- pick asset ----------------
EXTENSION="deb"
[ "$PREFER" = "appimage" ] && EXTENSION="AppImage"

ASSET_URL="$(echo "$RELEASE_JSON" | python3 - "$EXTENSION" <<'PY'
import json, sys
ext = sys.argv[1]
d = json.load(sys.stdin)
best = None
for a in d.get("assets", []):
    name = a["name"].lower()
    if name.endswith("." + ext.lower()):
        best = a["browser_download_url"]
        break
print(best or "")
PY
)"

if [ -z "$ASSET_URL" ]; then
  echo "ERROR: no ${EXTENSION} asset found in release ${TAG}" >&2
  echo "       Available assets:" >&2
  echo "$RELEASE_JSON" | python3 -c "import sys,json; [print('  -', a['name']) for a in json.load(sys.stdin).get('assets',[])]" >&2 || true
  exit 1
fi

echo "==> Downloading: ${ASSET_URL}"
DOWNLOAD_DIR="$(mktemp -d)"
trap 'rm -rf "$DOWNLOAD_DIR"' EXIT

case "$EXTENSION" in
  deb)
    FILE="${DOWNLOAD_DIR}/lite-editor.deb"
    curl -L --fail -o "$FILE" "$ASSET_URL"
    echo "==> Saved ${FILE} ($(du -h "$FILE" | cut -f1))"

    echo "==> Installing .deb (may ask for sudo)..."
    if command -v apt-get >/dev/null 2>&1; then
      sudo apt-get update
      sudo apt-get install -y "./${FILE}"
    else
      sudo dpkg -i "$FILE" || sudo apt-get install -y -f
    fi
    echo "==> Done. Launch with: lite-editor"
    ;;

  AppImage)
    FILE="${DOWNLOAD_DIR}/Lite.Editor.AppImage"
    curl -L --fail -o "$FILE" "$ASSET_URL"
    chmod +x "$FILE"
    echo "==> Saved ${FILE} ($(du -h "$FILE" | cut -f1))"
    echo "==> Done. Run it directly: ${FILE}"
    echo
    echo "Tip: to add it to your app menu, copy it to ~/.local/bin/lite-editor.AppImage"
    echo "     and create ~/.local/share/applications/lite-editor.desktop:"
    cat <<DESKTOP
[Desktop Entry]
Name=Lite Editor
Exec=${HOME}/.local/bin/lite-editor.AppImage
Icon=text-editor
Type=Application
Categories=AudioVideo;Video;
DESKTOP
    ;;
esac
