#!/usr/bin/env bash
# Check the control Mac has what it needs before any SDK or build work.
# Installs nothing — it reports, and tells you the command to fix each gap.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; fail=1; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fixit(){ printf '      \033[36mfix:\033[0m %s\n' "$*"; }

echo "Preflight check for CamBridge"
echo "Repo root: ${REPO_ROOT}"
echo

# --- are you actually in the repo? ------------------------------------------
# The single most common mistake: running the documented commands from ~ instead
# of the checkout. Relative paths then create stray directories in $HOME.
if [[ "$(pwd)" != "${REPO_ROOT}" ]]; then
  # A hard failure, not a warning. This has bitten twice, and it is insidious
  # because git commands keep working from a subdirectory — so the mistake stays
  # invisible until cmake or node resolves a relative path against the wrong
  # place and reports something that looks unrelated.
  bad "your shell is in $(pwd), not the repo root"
  fixit "cd ${REPO_ROOT}"
  echo "      Every command in the docs uses paths relative to the repo root."
  echo "      Note git works fine from a subdirectory, so a successful 'git pull'"
  echo "      here does not mean the other commands will resolve correctly."
else
  ok "shell is at the repo root"
fi

if [[ -d "${HOME}/vendor/CrSDK" && "${REPO_ROOT}" != "${HOME}" ]]; then
  warn "found a stray ~/vendor/CrSDK — SDK files were copied outside the repo"
  fixit "rm -rf ~/vendor    # then redo the copy from inside ${REPO_ROOT}"
fi

echo

# --- platform ---------------------------------------------------------------
if [[ "$(uname -s)" == "Darwin" ]]; then
  ok "macOS $(sw_vers -productVersion 2>/dev/null), $(uname -m)"
  [[ "$(uname -m)" == "arm64" ]] || warn "not arm64 — the SDK ships universal so this still works, but the docs assume Apple Silicon"
else
  bad "not macOS — camd targets macOS only"
fi

# --- Xcode command line tools ----------------------------------------------
if xcode-select -p >/dev/null 2>&1; then
  ok "Xcode command line tools -> $(xcode-select -p)"
  if ! command -v clang >/dev/null 2>&1; then
    bad "clang not on PATH despite CLT being installed"
  fi
else
  bad "Xcode command line tools missing"
  fixit "xcode-select --install"
fi

# --- cmake ------------------------------------------------------------------
# The only hard build dependency beyond the Xcode toolchain. Verified against
# Sony's RemoteCli build: it is pure CMake plus a C++ compiler linking prebuilt
# dylibs. Sony's README also lists autoconf/automake/libtool, but nothing in
# the build path uses them — they would only matter when building the bundled
# OSS dependencies from source, and Sony ships those prebuilt. Homebrew is
# therefore optional; it is just one of several ways to get cmake.
if command -v cmake >/dev/null 2>&1; then
  cmv="$(cmake --version 2>/dev/null | head -1 | awk '{print $3}')"
  major="${cmv%%.*}"; rest="${cmv#*.}"; minor="${rest%%.*}"
  if (( major < 3 || (major == 3 && minor < 24) )); then
    bad "cmake ${cmv} is too old — camd needs 3.24 or later"
    fixit "upgrade cmake (brew upgrade cmake, or reinstall from cmake.org)"
  else
    ok "cmake ${cmv} -> $(command -v cmake)"
  fi
elif [[ -x /Applications/CMake.app/Contents/bin/cmake ]]; then
  bad "CMake.app is installed but its cmake is not on PATH"
  fixit 'echo '"'"'export PATH="/Applications/CMake.app/Contents/bin:$PATH"'"'"' >> ~/.zprofile'
  echo "      then open a new terminal tab, or run that export in this one"
else
  bad "cmake not found — this is the only build tool you still need"
  echo "      Either of these works; the first avoids installing Homebrew:"
  echo "        1. Download the macOS universal .dmg from https://cmake.org/download/"
  echo "           drag CMake.app to /Applications, then add it to PATH:"
  echo '           echo '"'"'export PATH="/Applications/CMake.app/Contents/bin:$PATH"'"'"' >> ~/.zprofile'
  echo "        2. Install Homebrew, then: brew install cmake"
fi

# --- node -------------------------------------------------------------------
# Required by cambridge (the app server and web UI), not by camd. The daemon
# builds and runs without it; the browser panel does not.
if command -v node >/dev/null 2>&1; then
  nodev="$(node --version 2>/dev/null | sed 's/^v//')"
  nodemajor="${nodev%%.*}"
  if [[ "${nodemajor}" -ge 22 ]]; then
    ok "node ${nodev} -> $(command -v node)"
  else
    bad "node ${nodev} is too old — cambridge needs 22 or later"
    echo "      It uses Node's built-in WebSocket client and test runner, which is"
    echo "      how cambridge avoids having any npm dependencies at all."
    fixit "install Node 22 LTS from https://nodejs.org/en/download (macOS arm64 .pkg)"
  fi
else
  bad "node not found — needed for cambridge (the web UI); camd itself does not need it"
  echo "      Either of these works; the first avoids installing Homebrew:"
  echo "        1. Download the macOS Apple Silicon .pkg from https://nodejs.org/en/download"
  echo "           (take the LTS build, 22 or later) and run the installer"
  echo "        2. Install Homebrew, then: brew install node"
fi

# Advisory only — present in Sony's README, unused by this build path.
for tool in autoconf automake libtool; do
  command -v "${tool}" >/dev/null 2>&1 \
    && ok "${tool} (not required, but present)"
done
command -v brew >/dev/null 2>&1 && ok "Homebrew -> $(command -v brew) (optional)"

echo

# --- git checkout sanity ----------------------------------------------------
if [[ -d "${REPO_ROOT}/.git" ]]; then
  branch="$(git -C "${REPO_ROOT}" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  ok "git checkout on branch '${branch}'"
else
  bad "${REPO_ROOT} is not a git checkout"
fi

for f in scripts/check-sdk.sh scripts/build-remotecli.sh; do
  if [[ -x "${REPO_ROOT}/${f}" ]]; then
    ok "${f} present and executable"
  elif [[ -f "${REPO_ROOT}/${f}" ]]; then
    bad "${f} present but not executable"
    fixit "chmod +x ${REPO_ROOT}/scripts/*.sh"
  else
    bad "${f} missing from the checkout"
  fi
done

echo
if [[ "${fail}" -eq 0 ]]; then
  printf '\033[32mPreflight OK\033[0m — next: place the SDK per docs/sdk-install.md, then ./scripts/check-sdk.sh\n'
else
  printf '\033[31mPreflight found gaps\033[0m — apply the fixes above and re-run\n'
fi
exit "${fail}"
