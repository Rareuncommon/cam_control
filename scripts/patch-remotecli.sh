#!/usr/bin/env bash
# Apply the minimum edits needed to build and connect Sony's RemoteCli sample
# on our hardware. Idempotent — safe to re-run.
#
# Why any patching is needed at all:
#
#   1. RemoteCli.cpp has an unreachable `return;` in main(), inside an
#      #if defined(__APPLE__) block, immediately after std::exit(EXIT_FAILURE).
#      Harmless dead code until AppleClang 21 made -Wreturn-mismatch a hard
#      error, which breaks the build on current Xcode. Only macOS builds hit it.
#
#   2. CameraDevice.cpp hardcodes the access-authentication username to "admin".
#      The sample prompts for a password but never a username. Sony's cameras
#      generate a random username (ours is not "admin"), so connection fails
#      until this is corrected.
#
#   3. Optionally, RemoteCli.cpp hardcodes the Ethernet model hint to the FX6.
#      Only pass --model if an unpatched connect attempt failed — whether that
#      hint is enforced or advisory is useful information for camd's Phase 1
#      device identification.
#
# Usage:
#   ./scripts/patch-remotecli.sh --user <camera-username> [--model FX3|FX30] [path]
#
# The username comes from the camera: MENU -> Network -> Network Option ->
# [Access Authen. Info]. It is not a secret in the way the password is, but it
# is per-body, so it is passed on the command line rather than stored in this
# repo.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC=""
USERNAME=""
MODEL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user)  USERNAME="${2:-}"; shift 2 ;;
    --model) MODEL="${2:-}";    shift 2 ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *)       SRC="$1";          shift ;;
  esac
done

SRC="${SRC:-${REPO_ROOT}/vendor/RemoteCli}"

if [[ -z "${USERNAME}" ]]; then
  echo "ERROR: --user is required. Read it off the camera's [Access Authen. Info] screen." >&2
  echo "Usage: ./scripts/patch-remotecli.sh --user <camera-username> [--model FX3|FX30] [path]" >&2
  exit 1
fi

REMOTECLI="${SRC}/app/RemoteCli.cpp"
CAMERADEV="${SRC}/app/CameraDevice.cpp"
for f in "${REMOTECLI}" "${CAMERADEV}"; do
  [[ -f "${f}" ]] || { echo "ERROR: not found: ${f}" >&2; exit 1; }
done

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
skip() { printf '  \033[34m-\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }

# Portable in-place edit: BSD sed (macOS) and GNU sed disagree about -i, so
# write to a temp file and move it back.
apply() {
  local file="$1" expr="$2" desc="$3" probe="$4"
  if ! grep -qF -- "${probe}" "${file}"; then
    skip "${desc} — already applied (or pattern absent)"
    return 0
  fi
  [[ -f "${file}.cambridge-orig" ]] || cp "${file}" "${file}.cambridge-orig"
  local tmp
  tmp="$(mktemp)"
  sed -e "${expr}" "${file}" > "${tmp}"
  if cmp -s "${file}" "${tmp}"; then
    rm -f "${tmp}"
    bad "${desc} — pattern matched but substitution changed nothing"
    return 1
  fi
  mv "${tmp}" "${file}"
  ok "${desc}"
}

echo "Patching Sony RemoteCli at: ${SRC}"
echo

# 1. The unreachable return; that AppleClang 21 rejects.
apply "${REMOTECLI}" \
  's/^\([[:space:]]*\)return;$/\1return EXIT_FAILURE;/' \
  "RemoteCli.cpp: bare 'return;' in main() -> 'return EXIT_FAILURE;'" \
  '            return;'

# 2. The hardcoded access-authentication username.
apply "${CAMERADEV}" \
  "s/const char\* inputId = \"admin\";/const char* inputId = \"${USERNAME}\";/" \
  "CameraDevice.cpp: access-auth username -> '${USERNAME}'" \
  'const char* inputId = "admin";'

# 3. Optional: the Ethernet model hint.
if [[ -n "${MODEL}" ]]; then
  case "${MODEL}" in
    FX3)  enum="CrCameraDeviceModel_ILME_FX3"  ;;
    FX30) enum="CrCameraDeviceModel_ILME_FX30" ;;
    *) echo "ERROR: --model must be FX3 or FX30 (got '${MODEL}')" >&2; exit 1 ;;
  esac
  apply "${REMOTECLI}" \
    "s/CrCameraDeviceModel_ILME_FX6;/${enum};/" \
    "RemoteCli.cpp: Ethernet model hint -> ${MODEL}" \
    'CrCameraDeviceModel_ILME_FX6;'
else
  skip "Ethernet model hint left as FX6 (pass --model FX30 if connect fails)"
fi

echo
echo "Originals saved as *.cambridge-orig alongside each patched file."
echo "Verify:"
grep -n 'inputId = ' "${CAMERADEV}" | head -1
grep -n 'ethernetModel = ' "${REMOTECLI}" | head -1
echo
echo "Now rebuild:"
echo "  ./scripts/build-remotecli.sh '${SRC}'"
