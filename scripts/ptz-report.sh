#!/usr/bin/env bash
# What does each PTZ camera actually answer?
#
# The PTZ drivers are written from the vendors' protocol documents and checked
# against fakes built from the same documents. That proves the code matches
# our reading of the spec — not that the camera does. This asks the real
# cameras, through the running CamBridge, and prints:
#
#   - model, firmware and what the driver believes the camera can do
#   - every setting in its table, with the value the camera gave
#   - settings the camera refused to answer (hidden from the panel)
#   - settings marked "verify": taken from an implementation rather than the
#     vendor's document, or from a sibling model. These are the ones to try
#     by hand on site.
#
# No arguments: the port comes from the config and the cameras from the server,
# for the same reason as focus-report.sh — a placeholder in a command gets
# pasted literally.
#
# Usage:
#   ./scripts/ptz-report.sh                  print it
#   ./scripts/ptz-report.sh --full           every value as JSON too
#   ./scripts/ptz-report.sh --out ptz.txt    write it to a file to send on
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

CONFIG="${CONFIG:-./config/cambridge.json}"
[[ -f "${CONFIG}" ]] || CONFIG="${HOME}/Library/Application Support/CamBridge/cambridge.json"
FULL=0
OUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --full) FULL=1; shift ;;
    --out)  OUT="${2:-}"; shift 2 ;;
    --config=*) CONFIG="${1#--config=}"; shift ;;
    *) echo "ptz-report.sh: unknown option '$1'" >&2; exit 2 ;;
  esac
done

read -r PORT TOKEN <<<"$(node -e '
  const fs = require("fs");
  try {
    const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const t = Object.keys(c.auth?.tokens ?? {});
    process.stdout.write(`${c.cambridge?.port ?? 8088} ${t[0] ?? ""}`);
  } catch { process.stdout.write("8088"); }
' "${CONFIG}" 2>/dev/null || echo 8088)"

BASE="http://localhost:${PORT}"
if ! curl -sf "${BASE}/api/health" >/dev/null 2>&1; then
  echo "CamBridge is not answering on ${BASE}. Start it first, then run this again." >&2
  exit 1
fi
AUTH=()
[[ -n "${TOKEN:-}" ]] && AUTH=(-H "Authorization: Bearer ${TOKEN}")

report() {
  echo "CamBridge PTZ report — $(date)"
  echo "server: ${BASE}"
  echo

  local ids
  ids="$(curl -s "${AUTH[@]}" "${BASE}/api/state" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const v = JSON.parse(s);
        const cams = (v.view?.cameras ?? []).filter((c) => c.kind === "ptz");
        process.stdout.write(cams.map((c) => c.id).join(" "));
      } catch { process.stdout.write(""); }
    });
  ')"

  if [[ -z "${ids}" ]]; then
    echo "No PTZ cameras configured. Add them in Setup first."
    return
  fi

  for id in ${ids}; do
    echo "=============================================================="
    echo "camera: ${id}"
    echo "=============================================================="
    curl -s "${AUTH[@]}" "${BASE}/api/cameras/${id}/properties/raw" | FULL="${FULL}" node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        let d;
        try { d = JSON.parse(s); } catch { console.log("  (no answer)", s.slice(0, 200)); return; }
        if (d.error) { console.log("  error:", d.error); return; }
        const entries = d.entries ?? [];
        const values = d.values ?? {};
        console.log(`  ${d.vendor} ${d.model}${d.firmware ? `  firmware ${d.firmware}` : ""}`);
        const c = d.capabilities ?? {};
        console.log(`  can: ${["panTilt", "zoom", "focus", "tally", "snapshot", "pointToCentre"].filter((k) => c[k]).join(", ") || "nothing reported yet"}`);
        console.log(`  presets: ${c.presets ?? 0} from ${c.presetBase ?? "?"}   tracking: ${c.tracking ? c.tracking.label : "none"}`);
        const missing = entries.filter((e) => e.available === false);
        const verify = entries.filter((e) => e.verify && e.available !== false);
        const settings = entries.filter((e) => e.type !== "action" && e.available !== false);
        const answered = settings.filter((e) => values[e.id] !== undefined);
        console.log(`  ${entries.length} table entries; ${answered.length} of ${settings.length} settings answered; ${missing.length} refused`);

        const show = (e) => {
          const v = values[e.id];
          const val = e.secret ? "(secret)" : v === undefined ? "—" : JSON.stringify(v.value);
          return `    ${e.id.padEnd(28)} ${String(e.label).slice(0, 30).padEnd(30)} ${val}${v && v.writable === false ? "  read-only now" : ""}`;
        };
        console.log("\n  to confirm by hand (verify):");
        if (!verify.length) console.log("    none");
        for (const e of verify) console.log(show(e));
        console.log("\n  refused by this camera (hidden from the panel):");
        if (!missing.length) console.log("    none");
        for (const e of missing) console.log(`    ${e.id.padEnd(28)} ${e.label}`);
        if (process.env.FULL === "1") {
          console.log("\n  every setting:");
          for (const e of settings) console.log(show(e));
        }
        console.log("");
      });
    '
  done

  echo "=============================================================="
  echo "Send this file back with a note of anything on the 'verify'"
  echo "list that did not do what its label says on the camera."
}

if [[ -n "${OUT}" ]]; then
  report > "${OUT}"
  echo "Written to ${OUT}"
else
  report
fi
