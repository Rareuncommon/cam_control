#!/bin/bash
# Builds the CamBridge Bluetooth bridge and runs it as a launchd user agent.
#
#   scripts/install-blebridge.sh
#   SIGN_IDENTITY="Apple Development: …" scripts/install-blebridge.sh
#
# The binary is copied to ~/Library/Application Support/CamBridge/bin, so the
# Bluetooth permission stays attached to one stable path. The first start
# shows macOS's Bluetooth permission prompt: allow it. See docs/mobile-app.md.

set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SUPPORT="${HOME}/Library/Application Support/CamBridge"
BIN_DIR="${SUPPORT}/bin"
LOG_DIR="${HOME}/Library/Logs/CamBridge"
SOCKET="${CAMBRIDGE_BLE_SOCKET:-${SUPPORT}/blebridge.sock}"
LABEL="studio.cambridge.blebridge"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
DOMAIN="gui/$(id -u)"

"${REPO}/blebridge/build.sh"

mkdir -p "${BIN_DIR}" "${LOG_DIR}" "$(dirname "${PLIST}")"
install -m 0755 "${REPO}/blebridge/build/blebridge" "${BIN_DIR}/blebridge"

esc() { printf '%s' "$1" | sed -e 's/[&|]/\\&/g'; }
sed -e "s|@BINARY@|$(esc "${BIN_DIR}/blebridge")|" \
    -e "s|@SOCKET@|$(esc "${SOCKET}")|" \
    -e "s|@LOG@|$(esc "${LOG_DIR}/blebridge.log")|g" \
    "${REPO}/blebridge/${LABEL}.plist" > "${PLIST}"
plutil -lint "${PLIST}" >/dev/null

launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
launchctl bootstrap "${DOMAIN}" "${PLIST}"
launchctl kickstart -k "${DOMAIN}/${LABEL}"

echo
echo "blebridge is running as ${LABEL}."
echo "  Log:    ${LOG_DIR}/blebridge.log"
echo "  Socket: ${SOCKET}"
echo "The first time, macOS asks to allow Bluetooth for \"blebridge\": allow it."
