#!/usr/bin/env bash
# What CamBridge.app actually runs.
#
# Kept in the repo rather than inside the bundle so it can be edited and version
# controlled normally, and so the app never carries a stale copy of the logic.
#
# Differs from start.sh in the ways a double-clicked app has to: there is no
# terminal to read, so problems are reported with a native dialog, and the
# browser is opened automatically.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

CONFIG="./config/cambridge.json"
LOG_DIR="./logs"
mkdir -p "${LOG_DIR}"
LAUNCH_LOG="${LOG_DIR}/launch.log"

say() { echo "$(date '+%Y-%m-%dT%H:%M:%S') $*" >> "${LAUNCH_LOG}"; }

# There is no terminal behind a double-click, so anything the operator must act
# on has to be a dialog. Offers to open the log, because that is the next thing
# they will want.
alert() {
    local title="$1" message="$2"
    say "ALERT: ${title} — ${message}"
    osascript >/dev/null 2>&1 <<OSA || true
    set logPath to POSIX path of "${REPO_ROOT}/${LAUNCH_LOG#./}"
    display dialog "${message}" with title "${title}" buttons {"Open Log", "OK"} default button "OK" with icon caution
    if button returned of result is "Open Log" then
        do shell script "open -a Console " & quoted form of logPath
    end if
OSA
}

say "--- launch ---"

# First run: create a config from the example so adoption has somewhere to write.
if [[ ! -f "${CONFIG}" ]]; then
    if [[ -f ./config/cambridge.example.json ]]; then
        # Start with no cameras at all — they get adopted through the UI. Copying
        # the example's placeholder entries would produce three permanently
        # offline cards on first run.
        /usr/bin/python3 - "${CONFIG}" <<'PY' 2>>"${LAUNCH_LOG}"
import json, sys
with open('config/cambridge.example.json') as f:
    text = f.read()
cfg = json.loads('\n'.join(l for l in text.splitlines()))
cfg['cameras'] = []
for key in list(cfg):
    if key.startswith('$'):
        del cfg[key]
with open(sys.argv[1], 'w') as f:
    json.dump(cfg, f, indent=2)
    f.write('\n')
PY
        say "created ${CONFIG} with no cameras (adopt them in the UI)"
    else
        alert "CamBridge" "No configuration found and no example to copy from. Is the CamBridge folder intact?"
        exit 1
    fi
fi

if [[ ! -x ./camd/build/camd ]]; then
    alert "CamBridge" "The camera daemon has not been built yet.

Open Terminal once and run:
    cd ${REPO_ROOT}
    cmake -S camd -B camd/build && cmake --build camd/build

After that, CamBridge starts normally from the Dock."
    exit 1
fi

if ! command -v node >/dev/null 2>&1; then
    # Double-clicked apps do not inherit a login shell's PATH, so a Node installed
    # under Homebrew or nvm is invisible here. Look where it actually lives before
    # concluding it is missing.
    for candidate in /usr/local/bin /opt/homebrew/bin "${HOME}/.nvm/versions/node"/*/bin; do
        if [[ -x "${candidate}/node" ]]; then
            export PATH="${candidate}:${PATH}"
            say "found node at ${candidate}"
            break
        fi
    done
fi
if ! command -v node >/dev/null 2>&1; then
    alert "CamBridge" "Node.js was not found.

Install the macOS LTS package from nodejs.org, then launch CamBridge again."
    exit 1
fi

read -r CAMD_PORT UI_PORT <<<"$(
  node -e '
    const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(`${c.camd?.restPort ?? 8787} ${c.cambridge?.port ?? 8088}`);
  ' "${CONFIG}" 2>>"${LAUNCH_LOG}" || echo "8787 8088"
)"

for pn in "${CAMD_PORT}:camera daemon" "${UI_PORT}:web interface"; do
    port="${pn%%:*}"; what="${pn##*:}"
    if lsof -ti:"${port}" >/dev/null 2>&1; then
        alert "CamBridge is already running" \
          "Port ${port} (${what}) is in use — CamBridge may already be open.

Opening the control panel instead."
        open "http://localhost:${UI_PORT}"
        exit 0
    fi
done

CAMD_PID=""
UI_PID=""
cleanup() {
    say "shutting down"
    [[ -n "${UI_PID}" ]] && kill "${UI_PID}" 2>/dev/null
    [[ -n "${CAMD_PID}" ]] && kill "${CAMD_PID}" 2>/dev/null
    wait 2>/dev/null
    say "stopped"
}
trap cleanup EXIT INT TERM

say "starting camd"
./camd/build/camd --config "${CONFIG}" >> "${LOG_DIR}/camd.stdout.log" 2>&1 &
CAMD_PID=$!

healthy=false
for _ in $(seq 1 50); do
    if curl -fsS "http://127.0.0.1:${CAMD_PORT}/health" >/dev/null 2>&1; then
        healthy=true
        break
    fi
    if ! kill -0 "${CAMD_PID}" 2>/dev/null; then break; fi
    sleep 0.2
done

if [[ "${healthy}" != true ]]; then
    alert "CamBridge could not start" \
      "The camera daemon did not start.

This is usually the Sony SDK missing from vendor/CrSDK, or a configuration error. The log has the details."
    exit 1
fi
say "camd healthy on ${CAMD_PORT}"

CAMBRIDGE_LAUNCHER_PID=$$ \
  node cambridge/src/server.js --config "${CONFIG}" >> "${LOG_DIR}/cambridge.stdout.log" 2>&1 &
UI_PID=$!

for _ in $(seq 1 50); do
    if curl -fsS "http://127.0.0.1:${UI_PORT}/api/health" >/dev/null 2>&1; then break; fi
    if ! kill -0 "${UI_PID}" 2>/dev/null; then
        alert "CamBridge could not start" "The web interface failed to start. The log has the details."
        exit 1
    fi
    sleep 0.2
done

say "opening browser at http://localhost:${UI_PORT}"
open "http://localhost:${UI_PORT}"

# Hold the app open. Quitting from the Dock terminates this script, and the trap
# stops both children.
wait
