#!/usr/bin/env bash
#
# agent-bridge-handler.sh — Bridge-callable entry point for Repost-with-agent.
#
# Designed for cross-machine agent-to-agent invocation via agent-bridge:
#
#   bridge_send_message({
#     machine: "<paired>",
#     target: "claude-code" | "openclaw/<acct>",
#     message: "/repost <verb> [args]"
#   })
#
# The receiving agent reads this script, picks the matching verb, and runs it
# in its shell. All verbs are read-only or approval-gated — no remote agent
# can publish without an explicit `--approve` flag mirrored from the
# originating user.
#
# Verbs:
#   list                          → all saved pairs
#   show <pair-id>                → JSON for one pair
#   preview <pair-id>             → preview top candidate (no posting)
#   history <pair-id>             → recent posted + audit entries
#   scheduled-run <pair-id>       → deterministic per-tick run; emits JSON to
#                                   stdout. Always preview-only — never passes
#                                   --allow-publish from a remote agent.
#   schedule <pair-id>            → render scheduling artifacts (read-only)
#   status                        → environment summary + pair count
#   safe-publish <pair-id>        → dry-run only; emits "approval needed"
#                                   stub (real publish requires explicit
#                                   --approve from the operator)
#
# Exit code 0 on success, 1 on misuse, 2 on CLI failure.
set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CLI=("npx" "--prefix" "$REPO_DIR" "repost-with-agent")

usage() {
  cat <<'USAGE'
repost-with-agent agent-bridge handler

Usage:
  agent-bridge-handler.sh list
  agent-bridge-handler.sh show <pair-id>
  agent-bridge-handler.sh preview <pair-id>
  agent-bridge-handler.sh history <pair-id>
  agent-bridge-handler.sh scheduled-run <pair-id>
  agent-bridge-handler.sh schedule <pair-id>
  agent-bridge-handler.sh status
  agent-bridge-handler.sh safe-publish <pair-id>

Bridge-call from another machine:
  bridge_send_message machine=<peer> target=claude-code \
    message="/repost preview linkedin-to-x"
USAGE
}

require_pair_id() {
  if [[ $# -lt 1 || -z "${1:-}" ]]; then
    echo "error: <pair-id> required" >&2
    usage >&2
    exit 1
  fi
}

verb="${1:-help}"
shift || true

case "$verb" in
  list)
    "${CLI[@]}" pair list
    ;;
  show)
    require_pair_id "$@"
    "${CLI[@]}" pair show "$1"
    ;;
  preview)
    require_pair_id "$@"
    "${CLI[@]}" pair preview "$1"
    ;;
  history)
    require_pair_id "$@"
    "${CLI[@]}" pair history "$1"
    ;;
  scheduled-run)
    require_pair_id "$@"
    # Always preview-only across the bridge — never propagate --allow-publish
    # from a remote agent. The local operator must opt in with
    # `pair scheduled-run <id> --allow-publish` directly.
    "${CLI[@]}" pair scheduled-run "$1" --json
    ;;
  schedule)
    require_pair_id "$@"
    "${CLI[@]}" pair schedule "$1"
    ;;
  status)
    "${CLI[@]}" pair list || true
    echo "---"
    echo "REPOST_DATA_DIR=${REPOST_DATA_DIR:-~/.repost-with-agent}"
    ;;
  safe-publish)
    require_pair_id "$@"
    cat <<EOF
{
  "status": "needs-approval",
  "reason": "Live posting requires the operator to run \`repost-with-agent pair post $1 --approve\` directly. The agent-bridge handler refuses to publish on a peer's behalf.",
  "next_step": "Forward the preview to the human operator and have them invoke the local pair post command with explicit --approve."
}
EOF
    ;;
  help|--help|-h|"")
    usage
    ;;
  *)
    echo "error: unknown verb '$verb'" >&2
    usage >&2
    exit 1
    ;;
esac
