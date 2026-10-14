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

# The same locations the DMG app uses. They used to differ — this app wrote the
# repo's config while the DMG app wrote Application Support — so adopting cameras
# under one and launching the other looked exactly like "it forgot my cameras".
SUPPORT="${HOME}/Library/Application Support/CamBridge"
LOG_DIR="${HOME}/Library/Logs/CamBridge"
CONFIG="${SUPPORT}/cambridge.json"
mkdir -p "${SUPPORT}" "${LOG_DIR}"

# Carry across a config from the old location so nobody re-adopts their cameras.
if [[ ! -f "${CONFIG}" && -f ./config/cambridge.json ]]; then
    cp ./config/cambridge.json "${CONFIG}"
    chmod 600 "${CONFIG}"
fi
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

# First run: a config with the example's settings and no cameras, so adoption
# has somewhere to write. Cameras are added in Setup; copying the example's
# placeholder entries would produce permanently offline cards on first run.
if [[ ! -f "${CONFIG}" ]]; then
    if ! node cambridge/src/venue.js --init "${CONFIG}" ./config/cambridge.example.json 2>>"${LAUNCH_LOG}"; then
        alert "CamBridge" "No configuration found and none could be created. Is the CamBridge folder intact?"
        exit 1
    fi
    say "created ${CONFIG} with no cameras (add them in Setup)"
fi

# Whether camd is needed is the server's rule (camdMode in venue.js), asked
# rather than copied so the launcher and the server can never disagree.
# 'optional' — no cameras yet — starts camd if it is built and goes without it
# if not: a Mac set up for PTZ heads alone has no SDK and needs no daemon.
CAMD_MODE="$(node "${REPO_ROOT}/cambridge/src/venue.js" "${CONFIG}" 2>>"${LAUNCH_LOG}" || echo yes)"
case "${CAMD_MODE}" in
    no) NEED_CAMD=no ;;
    optional)
        if [[ -x ./camd/build/camd ]]; then NEED_CAMD=yes; else NEED_CAMD=no; export CAMBRIDGE_CAMD=off; fi ;;
    *) NEED_CAMD=yes ;;
esac
say "camd: ${CAMD_MODE} -> starting: ${NEED_CAMD}"

if [[ "${NEED_CAMD}" == yes && ! -x ./camd/build/camd ]]; then
    alert "CamBridge" "The camera daemon has not been built yet.

Open Terminal once and run:
    cd ${REPO_ROOT}
    cmake -S camd -B camd/build && cmake --build camd/build

After that, CamBridge starts normally from the Dock."
    exit 1
fi

read -r CAMD_PORT UI_PORT <<<"$(
  node -e '
    const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(`${c.camd?.restPort ?? 8787} ${c.cambridge?.port ?? 8088}`);
  ' "${CONFIG}" 2>>"${LAUNCH_LOG}" || echo "8787 8088"
)"

PORTS=("${UI_PORT}:web interface")
[[ "${NEED_CAMD}" == yes ]] && PORTS+=("${CAMD_PORT}:camera daemon")
for pn in "${PORTS[@]}"; do
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

# camd requires a per-launch access token on every request (audit DC-1). One
# fresh secret per launch, exported so camd and the Node service share it; it is
# never written to the config file.
export CAMD_AUTH_TOKEN="$(LC_ALL=C od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
camd_health() {
  curl -fsS -H @<(printf 'Authorization: Bearer %s\n' "${CAMD_AUTH_TOKEN}") \
    "http://127.0.0.1:${CAMD_PORT}/health" >/dev/null 2>&1
}

if [[ "${NEED_CAMD}" == yes ]]; then
    say "starting camd"
    ./camd/build/camd --config "${CONFIG}" >> "${LOG_DIR}/camd.stdout.log" 2>&1 &
    CAMD_PID=$!

    healthy=false
    for _ in $(seq 1 50); do
        if camd_health; then
            healthy=true
            break
        fi
        if ! kill -0 "${CAMD_PID}" 2>/dev/null; then break; fi
        sleep 0.2
    done

    if [[ "${healthy}" == true ]]; then
        say "camd healthy on ${CAMD_PORT}"
    elif [[ "${CAMD_MODE}" == optional ]]; then
        # No cameras yet, and a camd that cannot run here (built without the
        # Sony SDK, which CMake does by itself when it is absent): start
        # without it rather than refuse. PTZ, stills and cinema need none.
        kill "${CAMD_PID}" 2>/dev/null
        CAMD_PID=""
        NEED_CAMD=no
        export CAMBRIDGE_CAMD=off
        say "camd could not start; no Sony bodies configured, so starting without it"
    else
        alert "CamBridge could not start" \
          "The camera daemon did not start.

This is usually the Sony SDK missing from vendor/CrSDK, or a configuration error. The log has the details."
        exit 1
    fi
else
    say "no Sony bodies — not starting camd"
fi

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
