#!/usr/bin/env bash
# Export this Claude Code session into a folder you can hand to another tool.
#
# Finds the transcript itself, so there is no path to paste and no placeholder
# to substitute. Redacts by default, because exporting means handing the text
# to someone else and the safe behaviour should not be the one you remember to
# ask for.
#
# Usage:
#   ./scripts/export-session.sh                      export to ./session-export
#   ./scripts/export-session.sh ~/Desktop/cambridge  export somewhere else
#   ./scripts/export-session.sh --no-redact          keep paths, IPs, addresses
#   ./scripts/export-session.sh --extra "Acme Corp"  also redact that string
#   ./scripts/export-session.sh --only transcript    just the Markdown
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

OUTDIR="./session-export"
PASSTHROUGH=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-redact) PASSTHROUGH+=("--no-redact"); shift ;;
    --no-images) PASSTHROUGH+=("--no-images"); shift ;;
    --only)      PASSTHROUGH+=("--only" "${2:-}"); shift 2 ;;
    --extra)     PASSTHROUGH+=("--redact-extra" "${2:-}"); shift 2 ;;
    --cap)       PASSTHROUGH+=("--cap" "${2:-}"); shift 2 ;;
    -h|--help)   sed -n '2,16p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*)          echo "export-session.sh: unknown option '$1'" >&2; exit 2 ;;
    *)           OUTDIR="$1"; shift ;;
  esac
done

# Claude Code keeps transcripts in a directory named after the project path,
# flattened. Both slashes and underscores become dashes — cam_control lands
# under -home-user-cam-control, which is why deriving the name from the path
# alone gets it wrong.
#
# Rather than encode that scheme and be broken by the next change to it, derive
# the obvious candidate and then fall back to searching for whichever project
# directory actually holds the newest transcript.
PROJECT_KEY="$(pwd | sed 's|[/_]|-|g')"
ROOTS=("${HOME}/.claude/projects" "/root/.claude/projects")

TRANSCRIPT_DIR=""
for root in "${ROOTS[@]}"; do
  if [[ -d "${root}/${PROJECT_KEY}" ]]; then TRANSCRIPT_DIR="${root}/${PROJECT_KEY}"; break; fi
done

if [[ -z "${TRANSCRIPT_DIR}" ]]; then
  for root in "${ROOTS[@]}"; do
    [[ -d "${root}" ]] || continue
    newest="$(ls -t "${root}"/*/*.jsonl 2>/dev/null | head -1)"
    if [[ -n "${newest}" ]]; then
      TRANSCRIPT_DIR="$(dirname "${newest}")"
      echo "note: using ${TRANSCRIPT_DIR}" >&2
      break
    fi
  done
fi

if [[ -z "${TRANSCRIPT_DIR}" || ! -d "${TRANSCRIPT_DIR}" ]]; then
  echo "No transcripts found for this project." >&2
  echo "Looked for ${PROJECT_KEY} under: ${ROOTS[*]}" >&2
  exit 1
fi

# Newest .jsonl wins — that is the session you are in.
TRANSCRIPT="$(ls -t "${TRANSCRIPT_DIR}"/*.jsonl 2>/dev/null | head -1)"
if [[ -z "${TRANSCRIPT}" ]]; then
  echo "No .jsonl transcript in ${TRANSCRIPT_DIR}" >&2
  exit 1
fi

# The operator's own login name is the commonest thing worth redacting and the
# patterns cannot know it, so pass it automatically.
[[ -n "${USER:-}" ]] && PASSTHROUGH+=("--redact-extra" "${USER}")

echo "Exporting $(basename "${TRANSCRIPT}")"
mkdir -p "${OUTDIR}"

python3 "${REPO_ROOT}/scripts/export_session.py" \
  "${TRANSCRIPT}" "${OUTDIR}" "${PASSTHROUGH[@]}" || exit 1

# The handoff brief is a maintained document, not something generated per run:
# it improves as the project does, and it is the piece worth reading first.
if [[ -f "${REPO_ROOT}/docs/handoff.md" ]]; then
  cp "${REPO_ROOT}/docs/handoff.md" "${OUTDIR}/handoff.md"
  echo "  handoff.md      $(wc -c < "${OUTDIR}/handoff.md" | tr -d ' ') bytes"
fi

cat > "${OUTDIR}/README.md" <<'INNER'
# CamBridge session export

Four things, most useful first.

| File | What it is |
|---|---|
| `handoff.md` | Project state, the decisions that matter, and what is still unknown. Small enough to paste straight into a prompt. **Start here.** |
| `transcript.md` | The conversation. Assistant reasoning and editor plumbing omitted; everything else verbatim. |
| `session.jsonl` | The raw session, one JSON record per line, for running code over. |
| `images/` | Screenshots referenced from the transcript. |

## One caveat about the transcript

This session was compacted partway through. Everything before that point exists
**only** as a summary, which appears at the top of `transcript.md` under its own
heading. The verbatim record starts after it. The summary is not a substitute
for the turns it replaced, and it is labelled rather than spliced in as if it
were conversation.

## Redaction

Unless it was exported with `--no-redact`, the operator's home path, login name,
the studio's VLAN addresses and email addresses have been replaced. Camera
credentials never appeared in the conversation at all, and the Sony SDK is not
present in it either — only project code that references its symbols.
INNER

echo "  README.md"
echo
echo "Done: ${OUTDIR}"
