#!/usr/bin/env bash
# Phase 0: build Sony's own RemoteCli sample from the unpacked SDK archive.
#
# This is deliberately Sony's code, not ours. If RemoteCli connects to a camera
# and rolls record over Ethernet, the toolchain, the SDK, the network, and the
# camera menu config are all proven — and any failure after that point is our
# bug, not an environment mystery.
#
# Usage:
#   ./scripts/build-remotecli.sh [path/to/unpacked/CrSDK_v2.02.00_Mac]
# Defaults to vendor/RemoteCli/ if no path is given.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${1:-${REPO_ROOT}/vendor/RemoteCli}"

if [[ ! -d "${SRC}" ]]; then
  cat >&2 <<EOF
Sony's unpacked SDK archive not found at:
  ${SRC}

Unpack the macOS SDK zip and either place it at vendor/RemoteCli/ or pass its
path as the first argument. See docs/sdk-install.md.
EOF
  exit 1
fi

# Sony has moved the sample around between releases; find the CMakeLists that
# actually builds RemoteCli rather than assuming a fixed subdirectory.
app_dir=""
while IFS= read -r cml; do
  if grep -qi 'RemoteCli' "${cml}" 2>/dev/null; then
    app_dir="$(dirname "${cml}")"
    break
  fi
done < <(find "${SRC}" -maxdepth 4 -name CMakeLists.txt 2>/dev/null)

if [[ -z "${app_dir}" ]]; then
  echo "Could not locate the RemoteCli CMakeLists.txt under ${SRC}" >&2
  echo "Directories present:" >&2
  find "${SRC}" -maxdepth 2 -type d >&2
  exit 1
fi

echo "Building Sony RemoteCli from: ${app_dir}"
BUILD_DIR="${REPO_ROOT}/build/remotecli"

cmake -S "${app_dir}" -B "${BUILD_DIR}" -DCMAKE_BUILD_TYPE=Release
cmake --build "${BUILD_DIR}" -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

bin="$(find "${BUILD_DIR}" -maxdepth 2 -type f -perm -111 -name 'RemoteCli*' | head -1)"
if [[ -z "${bin}" ]]; then
  echo "Build finished but no RemoteCli binary found under ${BUILD_DIR}" >&2
  exit 1
fi

# The SDK loads its transport adapters by relative path from the executable's
# directory. Without this copy, RemoteCli starts and then enumerates zero
# cameras with no useful error.
adapter_src="$(find "${SRC}" -type d -name CrAdapter | head -1)"
if [[ -n "${adapter_src}" ]]; then
  cp -R "${adapter_src}" "$(dirname "${bin}")/"
  echo "Copied CrAdapter/ next to the binary."
else
  echo "WARNING: no CrAdapter/ found in ${SRC} — RemoteCli will likely find zero cameras." >&2
fi

cat <<EOF

Built: ${bin}

Run it:
  cd "$(dirname "${bin}")" && ./$(basename "${bin}")

Then follow docs/phase-0-acceptance.md. In short: choose the Ethernet/network
connection option, enter the camera's IP and the access-authentication
username/password from the camera's [Access Authen. Info] screen, connect, and
toggle record.
EOF
