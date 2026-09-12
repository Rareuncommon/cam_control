#!/usr/bin/env bash
# What does each camera actually offer, and can it take a focus point?
#
# Written for one question — why tapping the multiview to focus returns "does
# not accept a focus point" — but it answers the general form of it too: the
# ordinary property list is filtered down to what CamBridge models, so a
# property the body lacks and one CamBridge never asks about look identical.
# This prints the unfiltered list.
#
# No arguments. It finds the port from the config and the camera ids from the
# running server, because a command with a placeholder in it is a command that
# gets pasted literally — zsh reads <id> as a redirect and never runs curl.
#
# Usage:
#   ./scripts/focus-report.sh                  print a summary
#   ./scripts/focus-report.sh --full           every property, as JSON
#   ./scripts/focus-report.sh --out report.txt write it to a file to send on
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

CONFIG="${CONFIG:-./config/cambridge.json}"
FULL=0
OUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --full) FULL=1; shift ;;
    --out)  OUT="${2:-}"; shift 2 ;;
    --config=*) CONFIG="${1#--config=}"; shift ;;
    *) echo "focus-report.sh: unknown option '$1'" >&2; exit 2 ;;
  esac
done

PORT="$(node -e '
  const fs = require("fs");
  try {
    const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(c.cambridge?.port ?? 8088));
  } catch { process.stdout.write("8088"); }
' "${CONFIG}" 2>/dev/null || echo 8088)"

BASE="http://localhost:${PORT}"

if ! curl -sf "${BASE}/api/health" >/dev/null 2>&1; then
  echo "CamBridge is not answering on ${BASE}." >&2
  echo "Start it first, then run this again." >&2
  exit 1
fi

# The panel may be behind a PIN. This endpoint is operator-level, so a token
# from the config works without anyone typing anything.
TOKEN="$(node -e '
  const fs = require("fs");
  try {
    const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const t = Object.keys(c.auth?.tokens ?? {});
    process.stdout.write(t[0] ?? "");
  } catch { process.stdout.write(""); }
' "${CONFIG}" 2>/dev/null || echo "")"

AUTH=()
[[ -n "${TOKEN}" ]] && AUTH=(-H "Authorization: Bearer ${TOKEN}")

report() {
  echo "CamBridge focus report — $(date)"
  echo "server: ${BASE}"
  echo

  local ids
  ids="$(curl -s "${AUTH[@]}" "${BASE}/api/state" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const v = JSON.parse(s);
        const cams = v.view?.cameras ?? v.cameras ?? [];
        process.stdout.write(cams.map((c) => c.id).join(" "));
      } catch { process.stdout.write(""); }
    });
  ')"

  if [[ -z "${ids}" ]]; then
    echo "No cameras reported. Is the daemon connected?"
    return
  fi

  for id in ${ids}; do
    echo "=============================================================="
    echo "camera: ${id}"
    echo "=============================================================="
    local body
    body="$(curl -s "${AUTH[@]}" "${BASE}/api/cameras/${id}/properties/raw")"

    if [[ "${FULL}" -eq 1 ]]; then
      echo "${body}" | python3 -m json.tool 2>/dev/null || echo "${body}"
      echo
      continue
    fi

    echo "${body}" | node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        let d;
        try { d = JSON.parse(s); } catch { console.log("  (no answer)", s.slice(0, 200)); return; }
        if (d.error) { console.log("  error:", d.error); return; }
        const props = d.properties ?? [];
        console.log(`  ${props.length} properties reported`);

        // The ones this report exists for. Matched on whole terms rather than
        // a bare "af", which quietly caught mediaFree.
        const focus = props.filter((p) => /focus|afarea|recognitionaf/i.test(p.name ?? ""));
        console.log("\n  focus-related:");
        if (!focus.length) console.log("    none");
        for (const p of focus) {
          console.log(`    ${p.code}  ${(p.name || "(unmapped)").padEnd(24)} ` +
            `${p.writable ? "writable" : "read-only"}  current=${p.current}`);
        }

        // The blind spot: codes the camera offers that CamBridge does not model.
        // A point-focus property could be sitting here under a name we never ask
        // about, which is the possibility the filtered list cannot rule out.
        const unmapped = props.filter((p) => !p.mapped);
        console.log(`\n  ${unmapped.length} codes CamBridge does not model:`);
        console.log("    " + unmapped.map((p) => p.code).join(" "));
        console.log("");
      });
    '
  done

  echo "=============================================================="
  echo "Run this once with Focus Area set to Wide on the camera, and"
  echo "again with it set to Flexible Spot. If afAreaPositionAFC or"
  echo "afAreaPositionAFS appears only in the second, tapping can be"
  echo "made to work by switching Focus Area automatically."
}

if [[ -n "${OUT}" ]]; then
  report > "${OUT}"
  echo "Written to ${OUT}"
else
  report
fi
