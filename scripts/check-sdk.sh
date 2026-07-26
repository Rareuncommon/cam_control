#!/usr/bin/env bash
# Verify the Sony Camera Remote SDK is unpacked where the build expects it.
# Touches no cameras. Safe to run any time.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_ROOT="${REPO_ROOT}/vendor/CrSDK"
EXPECTED_ARCH="${EXPECTED_ARCH:-arm64}"

fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; fail=1; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }

echo "Checking SDK at ${SDK_ROOT}"
echo

if [[ ! -d "${SDK_ROOT}" ]]; then
  bad "vendor/CrSDK/ does not exist. See docs/sdk-install.md."
  exit 1
fi

# --- headers ----------------------------------------------------------------
header=""
for candidate in \
  "${SDK_ROOT}/include/CRSDK/CameraRemote_SDK.h" \
  "${SDK_ROOT}/include/CameraRemote_SDK.h" \
  "${SDK_ROOT}/app/CRSDK/CameraRemote_SDK.h"
do
  [[ -f "${candidate}" ]] && { header="${candidate}"; break; }
done

if [[ -n "${header}" ]]; then
  ok "CameraRemote_SDK.h  -> ${header#"${REPO_ROOT}/"}"
  [[ "${header}" == "${SDK_ROOT}/include/CRSDK/"* ]] || \
    warn "not at the canonical vendor/CrSDK/include/CRSDK/ path; CMake will still find it, but docs/sdk-install.md describes the preferred layout"
else
  bad "CameraRemote_SDK.h not found under vendor/CrSDK/"
  found="$(find "${SDK_ROOT}" -name 'CameraRemote_SDK.h' -maxdepth 6 2>/dev/null | head -3)"
  [[ -n "${found}" ]] && warn "but something similar exists:"$'\n'"${found}"
fi

# --- core library -----------------------------------------------------------
core=""
for candidate in \
  "${SDK_ROOT}/lib/libCr_Core.dylib" \
  "${SDK_ROOT}/libCr_Core.dylib"
do
  [[ -f "${candidate}" ]] && { core="${candidate}"; break; }
done

if [[ -n "${core}" ]]; then
  ok "libCr_Core.dylib    -> ${core#"${REPO_ROOT}/"}"
  if command -v lipo >/dev/null 2>&1; then
    archs="$(lipo -archs "${core}" 2>/dev/null || echo unknown)"
    if [[ " ${archs} " == *" ${EXPECTED_ARCH} "* ]]; then
      ok "architecture        -> ${archs}"
    else
      bad "architecture is '${archs}', expected to include '${EXPECTED_ARCH}'"
      warn "an x86_64-only SDK means running camd under Rosetta — stop and decide deliberately"
    fi
  else
    warn "lipo not available (not macOS?) — skipping architecture check"
  fi
else
  bad "libCr_Core.dylib not found under vendor/CrSDK/"
fi

# --- transport adapters -----------------------------------------------------
# libCr_Core loads these by relative path at runtime. Flatten or rename this
# folder and the SDK initialises cleanly, then finds zero cameras.
adapter=""
for candidate in \
  "${SDK_ROOT}/lib/CrAdapter" \
  "${SDK_ROOT}/CrAdapter"
do
  [[ -d "${candidate}" ]] && { adapter="${candidate}"; break; }
done

if [[ -n "${adapter}" ]]; then
  count="$(find "${adapter}" -name '*.dylib' | wc -l | tr -d ' ')"
  if [[ "${count}" -gt 0 ]]; then
    ok "CrAdapter/          -> ${adapter#"${REPO_ROOT}/"} (${count} dylibs)"
    find "${adapter}" -name 'libCr_PTP_IP*.dylib' | grep -q . \
      && ok "libCr_PTP_IP        -> present (this is the one Ethernet control needs)" \
      || bad "libCr_PTP_IP*.dylib missing — Ethernet transport will not work"
  else
    bad "CrAdapter/ exists but contains no dylibs"
  fi
else
  bad "CrAdapter/ not found — it must sit beside libCr_Core.dylib, not be flattened"
fi

# --- Gatekeeper quarantine --------------------------------------------------
if command -v xattr >/dev/null 2>&1; then
  quarantined="$(xattr -r -l "${SDK_ROOT}" 2>/dev/null | grep -c 'com.apple.quarantine' || true)"
  if [[ "${quarantined}" -gt 0 ]]; then
    bad "${quarantined} file(s) still carry com.apple.quarantine — macOS will refuse to load the dylibs"
    warn "fix: xattr -dr com.apple.quarantine vendor/CrSDK"
  else
    ok "quarantine          -> clear"
  fi
else
  warn "xattr not available (not macOS?) — skipping quarantine check"
fi

echo
if [[ "${fail}" -eq 0 ]]; then
  printf '\033[32mSDK layout OK\033[0m — next: cmake -S camd -B camd/build && cmake --build camd/build --target camd-linkcheck\n'
else
  printf '\033[31mSDK layout incomplete\033[0m — see docs/sdk-install.md\n'
fi
exit "${fail}"
