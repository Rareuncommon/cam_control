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
  warn "your shell is in $(pwd), not the repo root"
  fixit "cd ${REPO_ROOT}"
  echo "      (every command in the docs uses paths relative to the repo root)"
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

# --- Homebrew ---------------------------------------------------------------
if command -v brew >/dev/null 2>&1; then
  ok "Homebrew -> $(command -v brew)"
else
  bad "Homebrew not found"
  fixit '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
  echo "      then, on Apple Silicon, add it to your shell:"
  echo '        echo '"'"'eval "$(/opt/homebrew/bin/brew shellenv)"'"'"' >> ~/.zprofile'
  echo '        eval "$(/opt/homebrew/bin/brew shellenv)"'
fi

# --- build tools ------------------------------------------------------------
# Sony's README asks for cmake, autoconf, automake and libtool.
missing=()
for tool in cmake autoconf automake libtool; do
  if command -v "${tool}" >/dev/null 2>&1; then
    ver=""
    case "${tool}" in
      cmake) ver=" $(cmake --version 2>/dev/null | head -1 | awk '{print $3}')" ;;
    esac
    ok "${tool}${ver}"
  else
    bad "${tool} not found"
    missing+=("${tool}")
  fi
done
if [[ ${#missing[@]} -gt 0 ]]; then
  fixit "brew install ${missing[*]}"
fi

# CMake 3.24+ is what camd/CMakeLists.txt requires.
if command -v cmake >/dev/null 2>&1; then
  cmv="$(cmake --version | head -1 | awk '{print $3}')"
  major="${cmv%%.*}"; rest="${cmv#*.}"; minor="${rest%%.*}"
  if (( major < 3 || (major == 3 && minor < 24) )); then
    bad "cmake ${cmv} is too old — camd needs 3.24 or later"
    fixit "brew upgrade cmake"
  fi
fi

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
