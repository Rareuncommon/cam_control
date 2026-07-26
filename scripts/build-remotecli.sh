#!/usr/bin/env bash
# Phase 0: build Sony's own RemoteCli sample from the unpacked SDK archive.
#
# This is deliberately Sony's code, not ours. If RemoteCli connects to a camera
# and rolls record over Ethernet, the toolchain, the SDK, the network, and the
# camera menu config are all proven — and any failure after that point is our
# bug, not an environment mystery.
#
# Sony's own CMakeLists sits at the root of RemoteCli.zip and handles staging
# its libraries (including moving CrAdapter/ to Contents/Frameworks/CrAdapter,
# which is where libCr_Core.dylib actually looks for it). We do not second-guess
# any of that here.
#
# Prerequisites on macOS:  xcode-select --install
#                          brew install cmake autoconf automake libtool
#
# Usage:
#   ./scripts/build-remotecli.sh [path/to/unpacked/RemoteCli]
# Defaults to vendor/RemoteCli/ if no path is given.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${1:-${REPO_ROOT}/vendor/RemoteCli}"

if [[ ! -f "${SRC}/CMakeLists.txt" ]]; then
  cat >&2 <<EOF
No CMakeLists.txt at:
  ${SRC}

Unpack Sony's RemoteCli.zip and either place the tree at vendor/RemoteCli/ or
pass its path as the first argument. The correct directory is the one directly
containing CMakeLists.txt, app/ and external/.

See docs/sdk-install.md.
EOF
  exit 1
fi

for required in app/CRSDK/CameraRemote_SDK.h external/crsdk/libCr_Core.dylib; do
  [[ -e "${SRC}/${required}" ]] || {
    echo "ERROR: ${SRC} does not look like the SDK archive — missing ${required}" >&2
    exit 1
  }
done

# Sony's archive is downloaded, so Gatekeeper will have quarantined the dylibs.
if command -v xattr >/dev/null 2>&1; then
  if xattr -r -l "${SRC}" 2>/dev/null | grep -q 'com.apple.quarantine'; then
    echo "Clearing com.apple.quarantine on ${SRC} ..."
    xattr -dr com.apple.quarantine "${SRC}"
  fi
fi

BUILD_DIR="${REPO_ROOT}/build/remotecli"
echo "Building Sony RemoteCli from: ${SRC}"

cmake -S "${SRC}" -B "${BUILD_DIR}" -DCMAKE_BUILD_TYPE=Release
cmake --build "${BUILD_DIR}" -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

bin="$(find "${BUILD_DIR}" -maxdepth 2 -type f -perm -111 -name 'RemoteCli*' ! -name '*.dylib' | head -1)"
if [[ -z "${bin}" ]]; then
  echo "Build finished but no RemoteCli binary found under ${BUILD_DIR}" >&2
  echo "If the default generator gave trouble, Sony's documented path on macOS is:" >&2
  echo "  cmake -GXcode -S '${SRC}' -B '${BUILD_DIR}'   # then build from Xcode" >&2
  exit 1
fi

bindir="$(dirname "${bin}")"

# Sanity-check Sony's own staging before you go hunting for camera problems.
if [[ -d "${bindir}/Contents/Frameworks/CrAdapter" ]]; then
  echo "✓ CrAdapter staged at Contents/Frameworks/CrAdapter"
else
  echo "! WARNING: Contents/Frameworks/CrAdapter is missing next to the binary." >&2
  echo "  libCr_Core.dylib loads its transport adapters from that exact relative" >&2
  echo "  path. Without it RemoteCli will start, report success, and then find" >&2
  echo "  zero cameras. Check the build log for the PRE_BUILD copy step." >&2
fi
[[ -f "${bindir}/libCr_Core.dylib" ]] \
  && echo "✓ libCr_Core.dylib staged beside the binary" \
  || echo "! WARNING: libCr_Core.dylib not staged beside the binary." >&2

cat <<EOF

Built: ${bin}

Run it:
  cd "${bindir}" && ./$(basename "${bin}")

Then follow docs/phase-0-acceptance.md. In short: choose the Ethernet/network
connection option, enter the camera's IP and the access-authentication username
and password from the camera's [Access Authen. Info] screen, connect, and toggle
record — confirming on the camera body, not just in the CLI output.
EOF
