#!/bin/bash
# Builds blebridge with its Info.plist embedded, and signs it.
#
#   blebridge/build.sh            ad-hoc signature
#   SIGN_IDENTITY="Apple Development: …" blebridge/build.sh
#
# macOS remembers the Bluetooth permission against the binary's signature.
# An ad-hoc signature changes with every build, so each rebuild asks again;
# signing with a stable identity (any Apple Development certificate in your
# keychain: `security find-identity -v -p codesigning`) keeps the permission.

set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build

swiftc -swift-version 5 -O \
    -target "$(uname -m)-apple-macosx13.0" \
    -o build/blebridge \
    Sources/*.swift \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist

codesign --force --sign "${SIGN_IDENTITY:--}" --identifier studio.cambridge.blebridge build/blebridge
echo "built $(pwd)/build/blebridge ($(build/blebridge --version))"
