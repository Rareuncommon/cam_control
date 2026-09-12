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
  cat >&2 <<EOF
No config at ${CONFIG}.

  cp config/cambridge.example.json config/cambridge.json

then fill in each camera's MAC and its own access-authentication username and
password (MENU -> Network -> Network Option -> [Access Authen. Info]).
Credentials are per-body — the three cameras do not share them.
EOF
  exit 1
fi

if [[ ! -x ./camd/build/camd ]]; then
  echo "camd is not built. Run: cmake -S camd -B camd/build && cmake --build camd/build" >&2
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
for port_name in "${CAMD_PORT}:camd" "${CAMBRIDGE_PORT}:cambridge"; do
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

echo "Starting camd${CAMD_ARGS[*]+ ${CAMD_ARGS[*]}}…"
./camd/build/camd --config "${CONFIG}" ${CAMD_ARGS[@]+"${CAMD_ARGS[@]}"} &
CAMD_PID=$!

# Wait for camd to answer before starting the UI, so the browser never opens
# onto a "camd unreachable" banner that is really just a startup race.
for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:${CAMD_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "${CAMD_PID}" 2>/dev/null; then
    echo "camd exited during startup — see the output above." >&2
    exit 1
  fi
  sleep 0.2
done

if ! curl -fsS "http://127.0.0.1:${CAMD_PORT}/health" >/dev/null 2>&1; then
  echo "camd did not become healthy within 10s." >&2
  exit 1
fi
echo "camd is up on 127.0.0.1:${CAMD_PORT}"

node cambridge/src/server.js --config "${CONFIG}" &
CAMBRIDGE_PID=$!

echo
echo "Ctrl-C stops both."
wait
