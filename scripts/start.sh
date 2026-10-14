#!/usr/bin/env bash
# Start both halves of CamBridge and shut both down together.
#
# Running camd and cambridge as two separate terminals is how you end up with
# one of them quietly not running and a browser saying "camd unreachable". This
# starts them as a pair, waits until camd is actually answering before bringing
# up the UI, and stops both on Ctrl-C.
#
# Usage:
#   ./scripts/start.sh                 real cameras
#   ./scripts/start.sh --fake          three simulated bodies, no hardware
#   ./scripts/start.sh --verbose       debug logging from camd
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

CONFIG="${CONFIG:-./config/cambridge.json}"
CAMD_ARGS=()
for arg in "$@"; do
  case "${arg}" in
    --fake|--fake-portfolio|--verbose) CAMD_ARGS+=("${arg}") ;;
    --config=*)       CONFIG="${arg#--config=}" ;;
    *) echo "start.sh: unknown option '${arg}'" >&2; exit 2 ;;
  esac
done

if [[ ! -f "${CONFIG}" ]]; then
  # First run: a config with the example's settings and no cameras. Cameras are
  # added in Setup — PTZ heads, stills and cinema cameras by address, Sony
  # bodies as camd discovers them.
  node "${REPO_ROOT}/cambridge/src/venue.js" --init "${CONFIG}" ./config/cambridge.example.json || exit 1
  echo "Created ${CONFIG} with no cameras — add them in the Setup tab."
fi

# Whether camd is needed is the server's rule (camdMode in venue.js); this asks
# it rather than keeping a copy. 'optional' — no cameras yet — starts camd if it
# is built and goes without it if not, so a Mac set up for PTZ heads alone
# starts without a daemon it does not need.
CAMD_MODE="$(node "${REPO_ROOT}/cambridge/src/venue.js" "${CONFIG}" 2>/dev/null || echo yes)"
case "${CAMD_MODE}" in
  no) NEED_CAMD=no ;;
  optional)
    if [[ -x ./camd/build/camd ]]; then NEED_CAMD=yes; else NEED_CAMD=no; export CAMBRIDGE_CAMD=off; fi ;;
  *) NEED_CAMD=yes ;;
esac

if [[ "${NEED_CAMD}" == yes && ! -x ./camd/build/camd ]]; then
  echo "camd is not built, and the Sony bodies in ${CONFIG} need it." >&2
  echo "Run: cmake -S camd -B camd/build && cmake --build camd/build   (see docs/install.md)" >&2
  exit 1
fi

# Read the ports out of the config so this script never disagrees with it.
read -r CAMD_PORT CAMBRIDGE_PORT <<<"$(
  node -e '
    const fs = require("fs");
    const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(`${c.camd?.restPort ?? 8787} ${c.cambridge?.port ?? 8088}`);
  ' "${CONFIG}" 2>/dev/null || echo "8787 8088"
)"

busy() { lsof -ti:"$1" >/dev/null 2>&1; }
PORT_NAMES=("${CAMBRIDGE_PORT}:cambridge")
[[ "${NEED_CAMD}" == yes ]] && PORT_NAMES+=("${CAMD_PORT}:camd")
for port_name in "${PORT_NAMES[@]}"; do
  port="${port_name%%:*}"; name="${port_name##*:}"
  if busy "${port}"; then
    echo "Port ${port} (${name}) is already in use." >&2
    echo "  Stop it:  lsof -ti:${port} | xargs kill" >&2
    exit 1
  fi
done

CAMD_PID=""
CAMBRIDGE_PID=""

cleanup() {
  echo
  echo "Stopping…"
  [[ -n "${CAMBRIDGE_PID}" ]] && kill "${CAMBRIDGE_PID}" 2>/dev/null
  [[ -n "${CAMD_PID}" ]] && kill "${CAMD_PID}" 2>/dev/null
  wait 2>/dev/null
  echo "Stopped."
}
trap cleanup INT TERM EXIT

# camd requires a per-launch access token on every request (audit DC-1). One
# fresh secret per launch, exported so camd and the Node service share it; it is
# never written to the config file.
export CAMD_AUTH_TOKEN="$(LC_ALL=C od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
camd_health() {
  curl -fsS -H @<(printf 'Authorization: Bearer %s\n' "${CAMD_AUTH_TOKEN}") \
    "http://127.0.0.1:${CAMD_PORT}/health" >/dev/null 2>&1
}

# With no cameras yet camd is optional, and a camd that cannot run here — built
# without the Sony SDK, which CMake does by itself when the SDK is absent — is
# the same as one not built: CamBridge starts without it instead of refusing.
camd_unavailable() {
  if [[ "${CAMD_MODE}" == optional ]]; then
    [[ -n "${CAMD_PID:-}" ]] && kill "${CAMD_PID}" 2>/dev/null
    CAMD_PID=""
    NEED_CAMD=no
    export CAMBRIDGE_CAMD=off
    echo "camd could not start ($1) — starting without it, as no Sony bodies are configured."
    return 0
  fi
  echo "camd $1." >&2
  exit 1
}

if [[ "${NEED_CAMD}" == yes ]]; then
  echo "Starting camd${CAMD_ARGS[*]+ ${CAMD_ARGS[*]}}…"
  ./camd/build/camd --config "${CONFIG}" ${CAMD_ARGS[@]+"${CAMD_ARGS[@]}"} &
  CAMD_PID=$!

  # Wait for camd to answer before starting the UI, so the browser never opens
  # onto a "camd unreachable" banner that is really just a startup race.
  camd_state=starting
  for _ in $(seq 1 50); do
    if camd_health; then camd_state=up; break; fi
    if ! kill -0 "${CAMD_PID}" 2>/dev/null; then camd_state=exited; break; fi
    sleep 0.2
  done
  if [[ "${camd_state}" == up ]] || camd_health; then
    echo "camd is up on 127.0.0.1:${CAMD_PORT}"
  elif [[ "${camd_state}" == exited ]]; then
    camd_unavailable "exited during startup — see the output above"
  else
    camd_unavailable "did not become healthy within 10s"
  fi
elif [[ "${CAMD_MODE}" == optional ]]; then
  echo "No Sony bodies configured and camd is not built — starting without it."
  echo "PTZ, stills and cinema cameras need nothing more; Sony bodies need camd (docs/install.md)."
else
  echo "No Sony bodies — camd is not needed and not started."
fi

node cambridge/src/server.js --config "${CONFIG}" &
CAMBRIDGE_PID=$!

echo
[[ "${NEED_CAMD}" == yes ]] && echo "Ctrl-C stops both." || echo "Ctrl-C stops it."
wait
