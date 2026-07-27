#!/usr/bin/env bash
# Builds a self-contained CamBridge.app and wraps it in a DMG.
#
# This is different from make-app.sh. That one builds a *thin* app that points
# back at this repo, which is right for development — edit a file, relaunch, done.
# A DMG has to survive being copied to a machine that has no repo, no SDK and
# possibly no Node, so everything it needs goes inside the bundle.
#
# Usage:
#   ./scripts/make-dmg.sh                  build ./dist/CamBridge-<version>.dmg
#   ./scripts/make-dmg.sh --no-node        do not bundle Node (needs it installed)
#   ./scripts/make-dmg.sh --stage-only     assemble the .app, skip the DMG
#   ./scripts/make-dmg.sh --out DIR        write somewhere other than ./dist
#
# --stage-only also skips the macOS-only steps, which is how the bundle layout
# gets tested on a non-Mac. It cannot produce a runnable app there: camd has to
# be compiled on macOS against Sony's SDK.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

VERSION="$(git describe --tags --always --dirty 2>/dev/null || echo 1.0)"
OUT_DIR="${REPO_ROOT}/dist"
BUNDLE_NODE=1
STAGE_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-node)    BUNDLE_NODE=0; shift ;;
    --stage-only) STAGE_ONLY=1; shift ;;
    --out)        OUT_DIR="$2"; shift 2 ;;
    --version)    VERSION="$2"; shift 2 ;;
    *) echo "make-dmg.sh: unknown option '$1'" >&2; exit 2 ;;
  esac
done

die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
step() { printf '\033[36m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '\033[33m  ! \033[0m%s\n' "$*"; }

APP="${OUT_DIR}/CamBridge.app"
STAGE="${OUT_DIR}/.dmg-stage"

# --- checks -----------------------------------------------------------------

if [[ "${STAGE_ONLY}" -eq 0 && "$(uname -s)" != "Darwin" ]]; then
  die "a real DMG can only be built on macOS (hdiutil), and camd must be compiled
       there against the Sony SDK. Use --stage-only to check the layout elsewhere."
fi

[[ -d vendor/CrSDK/lib ]] || die "vendor/CrSDK/lib is missing — see docs/sdk-install.md"

# --- build camd -------------------------------------------------------------

if [[ "${STAGE_ONLY}" -eq 0 ]]; then
  step "Building camd (Release)"
  cmake -S camd -B camd/build -DCMAKE_BUILD_TYPE=Release >/dev/null || die "cmake configure failed"
  cmake --build camd/build -j"$(sysctl -n hw.ncpu 2>/dev/null || echo 4)" >/dev/null \
    || die "cmake build failed"
  [[ -x camd/build/camd ]] || die "camd did not build"
else
  step "Stage-only: skipping the camd build"
fi

# --- assemble ---------------------------------------------------------------

step "Assembling ${APP}"
rm -rf "${APP}" "${STAGE}"
mkdir -p "${APP}/Contents/MacOS" "${APP}/Contents/Resources"

cat > "${APP}/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>CamBridge</string>
    <key>CFBundleDisplayName</key><string>CamBridge</string>
    <key>CFBundleIdentifier</key><string>studio.cambridge.app</string>
    <key>CFBundleVersion</key><string>${VERSION}</string>
    <key>CFBundleShortVersionString</key><string>${VERSION}</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleExecutable</key><string>CamBridge</string>
    <key>CFBundleIconFile</key><string>CamBridge</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>LSUIElement</key><false/>
    <key>LSMinimumSystemVersion</key><string>12.1</string>
</dict>
</plist>
PLIST

# --- the daemon and its SDK -------------------------------------------------
#
# Layout matters here and it is not the obvious one. libCr_Core.dylib resolves
# its transport adapters from the hardcoded relative path
# "Contents/Frameworks/CrAdapter". In the development build that resolves
# against the directory holding the camd binary, and that arrangement is proven
# working on real cameras.
#
# Rather than reason about how it would resolve from Contents/MacOS in a real
# bundle, the whole proven directory is reproduced verbatim inside Resources and
# the launcher cds into it. Both the cwd and executable-directory readings then
# point at the same place, so it cannot matter which one the SDK uses.

step "Staging the daemon and Sony SDK"
CAMD_DIR="${APP}/Contents/Resources/camd"
mkdir -p "${CAMD_DIR}/Contents/Frameworks"

if [[ "${STAGE_ONLY}" -eq 0 ]]; then
  cp camd/build/camd "${CAMD_DIR}/camd"
else
  printf '#!/bin/sh\necho "stage-only placeholder"\n' > "${CAMD_DIR}/camd"
  chmod +x "${CAMD_DIR}/camd"
fi

for lib in vendor/CrSDK/lib/*.dylib; do
  [[ -e "${lib}" ]] && cp "${lib}" "${CAMD_DIR}/"
done
if [[ -d vendor/CrSDK/lib/CrAdapter ]]; then
  cp -R vendor/CrSDK/lib/CrAdapter "${CAMD_DIR}/Contents/Frameworks/CrAdapter"
else
  die "vendor/CrSDK/lib/CrAdapter is missing — the SDK copy in docs/sdk-install.md was incomplete"
fi
note "$(find "${CAMD_DIR}" -name '*.dylib' | wc -l | tr -d ' ') dylibs staged"

# --- the Node app -----------------------------------------------------------

step "Staging cambridge"
mkdir -p "${APP}/Contents/Resources/cambridge"
cp -R cambridge/src cambridge/public "${APP}/Contents/Resources/cambridge/"
cp config/cambridge.example.json "${APP}/Contents/Resources/cambridge.example.json"

if [[ "${BUNDLE_NODE}" -eq 1 ]]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
  if [[ -z "${NODE_BIN}" ]]; then
    warn "node not found on PATH; the app will require Node to be installed"
    BUNDLE_NODE=0
  elif [[ "${STAGE_ONLY}" -eq 0 ]]; then
    # A Homebrew node links against Homebrew's own dylibs, which will not exist
    # on the target machine. Copying it would produce an app that launches on
    # this Mac and dies on every other one — the worst possible failure mode, so
    # check before trusting it.
    EXTERNAL="$(otool -L "${NODE_BIN}" 2>/dev/null \
      | tail -n +2 | awk '{print $1}' \
      | grep -vE '^(/usr/lib/|/System/)' || true)"
    if [[ -n "${EXTERNAL}" ]]; then
      warn "the node at ${NODE_BIN} links to libraries outside the OS:"
      while IFS= read -r l; do [[ -n "${l}" ]] && note "  ${l}"; done <<< "${EXTERNAL}"
      warn "not bundling it — install Node from nodejs.org for a self-contained app,"
      warn "or accept that the target Mac needs Node installed."
      BUNDLE_NODE=0
    else
      cp "${NODE_BIN}" "${APP}/Contents/Resources/node"
      chmod +x "${APP}/Contents/Resources/node"
      note "bundled node $("${NODE_BIN}" --version)"
    fi
  else
    cp "${NODE_BIN}" "${APP}/Contents/Resources/node" 2>/dev/null || BUNDLE_NODE=0
    chmod +x "${APP}/Contents/Resources/node" 2>/dev/null || true
    note "stage-only: copied node without the link check"
  fi
fi

# --- launcher ---------------------------------------------------------------
#
# Self-contained on purpose: it must not reference the repo, because the target
# machine will not have one.

step "Writing the launcher"
cat > "${APP}/Contents/MacOS/CamBridge" <<'LAUNCHER'
#!/bin/bash
# CamBridge. Generated by scripts/make-dmg.sh — edit that, not this.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RES="${HERE}/Resources"

# Runtime data lives outside the bundle, in the usual macOS places. The app can
# then be replaced wholesale without losing the camera list, and it works from
# /Applications where the bundle itself is not writable.
SUPPORT="${HOME}/Library/Application Support/CamBridge"
LOG_DIR="${HOME}/Library/Logs/CamBridge"
CONFIG="${SUPPORT}/cambridge.json"
mkdir -p "${SUPPORT}" "${LOG_DIR}"
LAUNCH_LOG="${LOG_DIR}/launch.log"

say() { echo "$(date '+%Y-%m-%dT%H:%M:%S') $*" >> "${LAUNCH_LOG}"; }

alert() {
    local title="$1" message="$2"
    say "ALERT: ${title} — ${message}"
    osascript >/dev/null 2>&1 <<OSA || true
    display dialog "${message}" with title "${title}" buttons {"Open Log", "OK"} default button "OK" with icon caution
    if button returned of result is "Open Log" then
        do shell script "open -a Console " & quoted form of "${LAUNCH_LOG}"
    end if
OSA
}

say "--- launch (bundle ${HERE}) ---"

# Node: bundled if present, otherwise whatever the machine has. A double-clicked
# app does not inherit a login shell's PATH, so the usual install locations are
# checked explicitly before giving up.
if [[ -x "${RES}/node" ]]; then
    NODE="${RES}/node"
else
    NODE="$(command -v node 2>/dev/null || true)"
    if [[ -z "${NODE}" ]]; then
        for c in /usr/local/bin /opt/homebrew/bin "${HOME}/.nvm/versions/node"/*/bin; do
            [[ -x "${c}/node" ]] && { NODE="${c}/node"; break; }
        done
    fi
fi
if [[ -z "${NODE}" || ! -x "${NODE}" ]]; then
    alert "CamBridge" "Node.js was not found.

Install the macOS LTS package from nodejs.org, then open CamBridge again."
    exit 1
fi
say "node: ${NODE}"

# First run: a config with no cameras, because they are added in the UI.
if [[ ! -f "${CONFIG}" ]]; then
    "${NODE}" -e '
      const fs = require("fs");
      const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      cfg.cameras = [];
      for (const k of Object.keys(cfg)) if (k.startsWith("$")) delete cfg[k];
      for (const section of Object.values(cfg)) {
        if (section && typeof section === "object") {
          for (const k of Object.keys(section)) if (k.startsWith("$")) delete section[k];
        }
      }
      cfg.logging = cfg.logging || {};
      cfg.logging.dir = process.argv[3];
      fs.writeFileSync(process.argv[2], JSON.stringify(cfg, null, 2) + "\n");
    ' "${RES}/cambridge.example.json" "${CONFIG}" "${LOG_DIR}" 2>>"${LAUNCH_LOG}" \
      || { alert "CamBridge" "Could not create a configuration file in ${SUPPORT}."; exit 1; }
    chmod 600 "${CONFIG}"
    say "created ${CONFIG}"
fi

read -r CAMD_PORT UI_PORT <<<"$(
  "${NODE}" -e '
    const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(`${c.camd?.restPort ?? 8787} ${c.cambridge?.port ?? 8088}`);
  ' "${CONFIG}" 2>>"${LAUNCH_LOG}" || echo "8787 8088"
)"

for pn in "${CAMD_PORT}:camera daemon" "${UI_PORT}:web interface"; do
    port="${pn%%:*}"; what="${pn##*:}"
    if lsof -ti:"${port}" >/dev/null 2>&1; then
        say "port ${port} (${what}) already in use; opening the existing panel"
        open "http://localhost:${UI_PORT}"
        exit 0
    fi
done

CAMD_PID=""; UI_PID=""
cleanup() {
    say "shutting down"
    [[ -n "${UI_PID}" ]] && kill "${UI_PID}" 2>/dev/null
    [[ -n "${CAMD_PID}" ]] && kill "${CAMD_PID}" 2>/dev/null
    wait 2>/dev/null
    say "stopped"
}
trap cleanup EXIT INT TERM

# cd into the daemon's own directory: the Sony SDK resolves its transport
# adapters from a path relative to here.
cd "${RES}/camd" || { alert "CamBridge" "The app bundle is incomplete."; exit 1; }

say "starting camd"
./camd --config "${CONFIG}" >> "${LOG_DIR}/camd.stdout.log" 2>&1 &
CAMD_PID=$!

healthy=false
for _ in $(seq 1 50); do
    if curl -fsS "http://127.0.0.1:${CAMD_PORT}/health" >/dev/null 2>&1; then healthy=true; break; fi
    kill -0 "${CAMD_PID}" 2>/dev/null || break
    sleep 0.2
done
if [[ "${healthy}" != true ]]; then
    alert "CamBridge could not start" \
      "The camera daemon did not start. The log has the details."
    exit 1
fi
say "camd healthy on ${CAMD_PORT}"

"${NODE}" "${RES}/cambridge/src/server.js" --config "${CONFIG}" \
    >> "${LOG_DIR}/cambridge.stdout.log" 2>&1 &
UI_PID=$!

for _ in $(seq 1 50); do
    if curl -fsS "http://127.0.0.1:${UI_PORT}/api/health" >/dev/null 2>&1; then break; fi
    if ! kill -0 "${UI_PID}" 2>/dev/null; then
        alert "CamBridge could not start" "The web interface failed to start. The log has the details."
        exit 1
    fi
    sleep 0.2
done

say "opening http://localhost:${UI_PORT}"
open "http://localhost:${UI_PORT}"
wait
LAUNCHER
chmod +x "${APP}/Contents/MacOS/CamBridge"

# --- icon -------------------------------------------------------------------

if [[ "${STAGE_ONLY}" -eq 0 ]] && command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
  step "Building the icon"
  ICONSET="$(mktemp -d)/CamBridge.iconset"
  mkdir -p "${ICONSET}"
  cat > "${ICONSET}/icon.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" rx="220" fill="#171b20"/>
  <rect x="196" y="250" width="270" height="90" rx="28" fill="#4da3ff"/>
  <circle cx="512" cy="590" r="230" fill="none" stroke="#4da3ff" stroke-width="70"/>
  <circle cx="512" cy="590" r="96" fill="#ef4d5a"/>
</svg>
SVG
  if sips -s format png "${ICONSET}/icon.svg" --out "${ICONSET}/base.png" >/dev/null 2>&1; then
    for sz in 16 32 64 128 256 512; do
      sips -z "${sz}" "${sz}" "${ICONSET}/base.png" --out "${ICONSET}/icon_${sz}x${sz}.png" >/dev/null 2>&1 || true
      sips -z $((sz*2)) $((sz*2)) "${ICONSET}/base.png" --out "${ICONSET}/icon_${sz}x${sz}@2x.png" >/dev/null 2>&1 || true
    done
    rm -f "${ICONSET}/icon.svg" "${ICONSET}/base.png"
    iconutil -c icns "${ICONSET}" -o "${APP}/Contents/Resources/CamBridge.icns" 2>/dev/null || true
  fi
  rm -rf "$(dirname "${ICONSET}")"
fi

# --- sign -------------------------------------------------------------------
#
# Ad-hoc, not a Developer ID. Enough to stop macOS reporting the app as damaged
# on the machine that built it; not enough to pass Gatekeeper on a Mac that
# downloaded it. The README that ships in the DMG explains the one-time
# right-click-Open, which is the correct answer for an internal tool.

if [[ "${STAGE_ONLY}" -eq 0 ]] && command -v codesign >/dev/null 2>&1; then
  step "Ad-hoc signing"
  codesign --force --deep --sign - "${APP}" 2>/dev/null \
    && note "signed ad-hoc" \
    || warn "codesign failed; the app still runs after a right-click → Open"
fi

APP_SIZE="$(du -sh "${APP}" 2>/dev/null | awk '{print $1}')"
note "bundle is ${APP_SIZE}"

if [[ "${STAGE_ONLY}" -eq 1 ]]; then
  step "Stage-only: ${APP}"
  exit 0
fi

# --- dmg --------------------------------------------------------------------

step "Building the DMG"
mkdir -p "${STAGE}"
cp -R "${APP}" "${STAGE}/CamBridge.app"
ln -s /Applications "${STAGE}/Applications"

cat > "${STAGE}/READ ME FIRST.txt" <<'README'
CamBridge
=========

1. Drag CamBridge onto the Applications folder shown here.

2. The first time you open it, macOS will refuse, because this app is not
   signed with a paid Apple Developer certificate.

   Right-click CamBridge in Applications and choose "Open", then confirm.
   You only do this once.

   If macOS says the app is "damaged", open Terminal and run:

       xattr -dr com.apple.quarantine /Applications/CamBridge.app

3. Open CamBridge. It starts the camera daemon and the control panel, and
   opens the panel in your browser. Quitting it stops everything.

4. Add your cameras in the Setup tab.

   If a camera has Access Authentication turned OFF, there is nothing to type
   beyond a name. If it is ON, CamBridge asks for the username and password
   shown on that camera at:

       MENU -> Network -> Network Option -> [Access Authen. Info]

Your cameras and settings are stored in:
    ~/Library/Application Support/CamBridge/

Logs, which are the first thing to check if something misbehaves:
    ~/Library/Logs/CamBridge/

This app contains Sony's Camera Remote SDK, which is licensed per developer.
Keep it inside the company.
README

DMG="${OUT_DIR}/CamBridge-${VERSION}.dmg"
rm -f "${DMG}"
hdiutil create -volname "CamBridge" -srcfolder "${STAGE}" \
  -ov -format UDZO "${DMG}" >/dev/null || die "hdiutil failed"
rm -rf "${STAGE}"

step "Done"
note "${DMG}"
note "$(du -sh "${DMG}" | awk '{print $1}')"
