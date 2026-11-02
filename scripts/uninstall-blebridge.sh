#!/bin/bash
# Stops the CamBridge Bluetooth bridge and removes its launchd agent and binary.

set -euo pipefail
LABEL="studio.cambridge.blebridge"
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
rm -f "${HOME}/Library/LaunchAgents/${LABEL}.plist" "${HOME}/Library/Application Support/CamBridge/bin/blebridge"
echo "blebridge removed. Its Bluetooth permission stays listed in System Settings until you remove it there."
