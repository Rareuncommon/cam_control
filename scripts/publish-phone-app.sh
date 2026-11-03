#!/usr/bin/env bash
# Builds the phone app, signs it with your release key, and publishes it to
# CamBridge, which offers it to every paired phone as an update (docs/mobile-app.md).
#
# Usage:
#   ./scripts/publish-phone-app.sh                       publish to the running app's config folder
#   ./scripts/publish-phone-app.sh --config-dir <dir>    publish beside a different cambridge.json
#
# The key: $CAMBRIDGE_KEYSTORE, or ~/.cambridge-signing/cambridge-release.jks,
# with alias $CAMBRIDGE_KEY_ALIAS or "cambridge". apksigner asks for its
# password (or reads $CAMBRIDGE_KEYSTORE_PASSWORD if set); nothing is stored. Every update must be signed with the same key,
# or Android refuses it.
#
# The version code is the number of commits on the checked-out branch, so a
# build of a newer main is always a higher number than an older one.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEYSTORE="${CAMBRIDGE_KEYSTORE:-$HOME/.cambridge-signing/cambridge-release.jks}"
ALIAS="${CAMBRIDGE_KEY_ALIAS:-cambridge}"
CONFIG_DIR=""
PACKAGE="studio.cambridge.mobile"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config-dir) CONFIG_DIR="$2"; shift 2 ;;
    -h|--help) sed -n 2,15p "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

fail() { echo "publish-phone-app: $*" >&2; exit 1; }

# Where CamBridge reads its config: the app's folder when it is installed as
# CamBridge.app, otherwise this repository's config/ (scripts/start.sh).
if [[ -z "${CONFIG_DIR}" ]]; then
  if [[ -f "$HOME/Library/Application Support/CamBridge/cambridge.json" ]]; then
    CONFIG_DIR="$HOME/Library/Application Support/CamBridge"
  else
    CONFIG_DIR="${REPO_ROOT}/config"
  fi
fi
[[ -d "${CONFIG_DIR}" ]] || fail "no folder ${CONFIG_DIR}"
OUT="${CONFIG_DIR}/phone-app"

[[ -f "${KEYSTORE}" ]] || fail "no signing key at ${KEYSTORE} (docs/mobile-app.md: A signing key, once)"
command -v flutter >/dev/null || fail "flutter is not on PATH (docs/mobile-app.md: Set up the Mac)"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
BUILD_TOOLS="$(ls -d "${SDK}"/build-tools/* 2>/dev/null | sort -V | tail -1)"
[[ -x "${BUILD_TOOLS}/apksigner" && -x "${BUILD_TOOLS}/aapt2" ]] || fail "no Android build-tools under ${SDK}"

CODE="$(git -C "${REPO_ROOT}" rev-list --count HEAD)"
if [[ -f "${OUT}/latest.json" ]]; then
  PUBLISHED="$(sed -n 's/.*"versionCode": *\([0-9][0-9]*\).*/\1/p' "${OUT}/latest.json")"
  if [[ -n "${PUBLISHED}" && "${CODE}" -le "${PUBLISHED}" ]]; then
    fail "this checkout is build ${CODE}, and build ${PUBLISHED} is already published: pull main first"
  fi
fi

echo "Building build ${CODE} from $(git -C "${REPO_ROOT}" rev-parse --short HEAD)…"
(cd "${REPO_ROOT}/mobile/motion" && flutter build aar --no-profile --target-platform android-arm64 --build-number 1 >/dev/null)
# apksigner signs below; Gradle builds unsigned even if CAMBRIDGE_KEYSTORE is
# set (with only the key's location it would fail).
(cd "${REPO_ROOT}/mobile" && env -u CAMBRIDGE_KEYSTORE ./gradlew -q :app:assembleRelease -Pcambridge.versionCode="${CODE}")

BUILT="${REPO_ROOT}/mobile/app/build/outputs/apk/release"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
if [[ -f "${BUILT}/app-release.apk" ]]; then
  cp "${BUILT}/app-release.apk" "${WORK}/signed.apk"
else
  PASS=()
  [[ -n "${CAMBRIDGE_KEYSTORE_PASSWORD:-}" ]] && PASS=(--ks-pass env:CAMBRIDGE_KEYSTORE_PASSWORD)
  "${BUILD_TOOLS}/apksigner" sign --ks "${KEYSTORE}" --ks-key-alias "${ALIAS}" ${PASS[@]+"${PASS[@]}"} \
    --out "${WORK}/signed.apk" "${BUILT}/app-release-unsigned.apk"
fi
"${BUILD_TOOLS}/apksigner" verify "${WORK}/signed.apk" || fail "the APK did not verify"

BADGING="$("${BUILD_TOOLS}/aapt2" dump badging "${WORK}/signed.apk")"
BADGING="${BADGING%%$'\n'*}"
[[ "${BADGING}" == *"name='${PACKAGE}'"* ]] || fail "unexpected package: ${BADGING}"
[[ "${BADGING}" == *"versionCode='${CODE}'"* ]] || fail "the APK is not build ${CODE}: ${BADGING}"
NAME="$(sed -n "s/.*versionName='\([^']*\)'.*/\1/p" <<<"${BADGING}")"

mkdir -p "${OUT}"
FILE="CamBridge-${CODE}.apk"
cp "${WORK}/signed.apk" "${OUT}/${FILE}"
printf '{ "versionCode": %s, "versionName": "%s", "file": "%s" }\n' "${CODE}" "${NAME}" "${FILE}" > "${OUT}/latest.json.tmp"
mv "${OUT}/latest.json.tmp" "${OUT}/latest.json"
# Keep this build and the one before it; older ones are never offered.
ls -t "${OUT}"/CamBridge-*.apk 2>/dev/null | tail -n +3 | while read -r old; do rm -f "${old}"; done

echo
echo "Published ${NAME} to ${OUT}"
CERTS="$("${BUILD_TOOLS}/apksigner" verify --print-certs "${WORK}/signed.apk")"
grep -i -m1 "SHA-256" <<<"${CERTS}" || true
echo "Paired phones offer it the next time they connect over Wi-Fi."
