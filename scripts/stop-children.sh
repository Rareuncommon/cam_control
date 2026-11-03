# Stopping what a CamBridge launcher started, without ever waiting forever.
# Sourced by scripts/app-launch.sh and scripts/start.sh, and copied into the
# DMG's app. Written for macOS's /bin/bash 3.2: no arrays, no `wait -n`.
#
#   stop_children SECONDS PID [PID…]
#
# Each process gets SIGTERM and SECONDS to stop cleanly (cambridge stops PTZ
# heads and closes its connections; camd disconnects the cameras); whatever is
# still running then gets SIGKILL. Their pids are left in STOP_CHILDREN_KILLED
# for the log. Without this, a launcher waiting on a child that did not stop
# kept CamBridge running in Activity Monitor after Quit.

STOP_CHILDREN_KILLED=""

# A child that has exited but not been reaped still answers kill -0.
stop_children_running() {
    kill -0 "$1" 2>/dev/null || return 1
    case "$(ps -o stat= -p "$1" 2>/dev/null)" in
        Z*|"") return 1 ;;
    esac
    return 0
}

stop_children() {
    local grace="$1" pids="" p alive ticks=0
    shift
    for p in "$@"; do
        [ -n "${p}" ] || continue
        stop_children_running "${p}" || continue
        kill -TERM "${p}" 2>/dev/null && pids="${pids} ${p}"
    done
    STOP_CHILDREN_KILLED=""
    while [ -n "${pids}" ]; do
        alive=""
        for p in ${pids}; do
            stop_children_running "${p}" && alive="${alive} ${p}"
        done
        [ -n "${alive}" ] || return 0
        if [ "${ticks}" -ge $((grace * 5)) ]; then
            kill -KILL ${alive} 2>/dev/null
            STOP_CHILDREN_KILLED="${alive# }"
            return 1
        fi
        sleep 0.2
        ticks=$((ticks + 1))
    done
    return 0
}
