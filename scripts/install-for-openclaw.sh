#!/usr/bin/env bash
#
# install-for-openclaw.sh — One-shot setup for Repost-with-agent v3.0.0
# under OpenClaw and Claude Code (the name is historical).
#
# Idempotent. Safe to re-run.
#
# Steps:
#   1. Verify Node + npm available.
#   2. Install npm deps (commander only — no Playwright, no API SDKs in v3)
#      + build TypeScript.
#   3. Smoke-test the CLI (`--version` plus `pair --help`).
#   4. Ensure runtime data dir (~/.repost-with-agent) exists.
#   5. Print the OpenClaw skills_root and plugin id so the operator (or
#      OpenClaw's plugin loader) knows where to point.
#
# Subcommands:
#   ./install-for-openclaw.sh             # default install
#   ./install-for-openclaw.sh check       # verify install without rebuilding
#   ./install-for-openclaw.sh uninstall   # remove launchd plists for any
#                                         #   repost-with-agent pair, print
#                                         #   the openclaw cron rm steps,
#                                         #   leave the data dir untouched.
#
# This script does NOT install OpenClaw itself, install cron jobs, or log you
# into any platform. Scheduling is wired up explicitly per pair via:
#     npx repost-with-agent pair schedule <pair-id>
#     npx repost-with-agent pair schedule <pair-id> --apply launchd
# or by hand (see docs/scheduling.md).
#
# v3.0.0 architecture: the CLI is a thin orchestrator. The agent drives the
# user's logged-in browser via its own browser MCP. There is no Playwright,
# no API SDKs, and no per-platform config in this script.
set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DATA_DIR="${REPOST_DATA_DIR:-$HOME/.repost-with-agent}"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

log() { printf "[install-for-openclaw] %s\n" "$*"; }

mode="${1:-install}"

case "$mode" in
  install|"")
    ;;
  check)
    ;;
  uninstall)
    log "Uninstalling repost-with-agent scheduling artifacts (data dir kept intact)..."
    if compgen -G "$LAUNCH_AGENTS_DIR/com.repost-with-agent.*.plist" >/dev/null; then
      for plist in "$LAUNCH_AGENTS_DIR"/com.repost-with-agent.*.plist; do
        log "Unloading + removing $plist"
        launchctl unload "$plist" 2>/dev/null || true
        rm -f "$plist"
      done
    else
      log "No launchd plists at $LAUNCH_AGENTS_DIR/com.repost-with-agent.*.plist"
    fi
    cat <<EOF

If you registered OpenClaw cron jobs for any pair, list and remove them:
  openclaw cron list | grep 'repost-with-agent'
  openclaw cron rm <job-id>

Runtime state at $DATA_DIR was left untouched.
The repo at $REPO_DIR was left untouched.
EOF
    exit 0
    ;;
  -h|--help|help)
    cat <<EOF
Usage:
  $(basename "${BASH_SOURCE[0]}")               install (default)
  $(basename "${BASH_SOURCE[0]}") check         verify CLI is callable, do not rebuild
  $(basename "${BASH_SOURCE[0]}") uninstall     remove launchd plists, print openclaw cron rm steps
EOF
    exit 0
    ;;
  *)
    echo "error: unknown mode '$mode'" >&2
    exit 1
    ;;
esac

cd "$REPO_DIR"

log "Repo dir: $REPO_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required but not found on PATH" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm is required but not found on PATH" >&2
  exit 1
fi

log "Node $(node --version), npm $(npm --version)"

if [[ "$mode" != "check" ]]; then
  log "Installing npm dependencies (npm install)..."
  npm install --no-audit --no-fund --silent

  log "Building TypeScript (npm run build)..."
  npm run build --silent
fi

if [[ ! -f "$REPO_DIR/dist/index.js" ]]; then
  echo "error: dist/index.js not found at $REPO_DIR/dist/index.js" >&2
  echo "       Run \`npm run build\` from the repo root." >&2
  exit 1
fi

log "Smoke-testing CLI (--version + pair --help)..."
node "$REPO_DIR/dist/index.js" --version
node "$REPO_DIR/dist/index.js" pair --help >/dev/null

mkdir -p "$DATA_DIR/pairs" "$DATA_DIR/agent-tasks"
log "Runtime data dir ready at $DATA_DIR"

PLUGIN_MANIFEST="$REPO_DIR/openclaw.plugin.json"
if [[ -f "$PLUGIN_MANIFEST" ]]; then
  PLUGIN_ID=$(node -e "console.log(require('$PLUGIN_MANIFEST').id)")
  log "OpenClaw plugin id:        $PLUGIN_ID"
  log "OpenClaw plugin manifest:  $PLUGIN_MANIFEST"
  log "OpenClaw skills root:      $REPO_DIR/skills"
fi

cat <<EOF

---
Repost-with-agent v3.0.0 is installed.

Next steps for the operator:
  1. Wire up Telegram notify (NON-NEGOTIABLE before any live publish):
       npx repost-with-agent notify configure --bot-token <T> --chat-id <C> --test
       npx repost-with-agent notify status     # MUST report source: file or env

  2. Make sure the agent's persistent browser profile is logged into BOTH the
     source AND destination platforms you'll cross-post between. The agent
     CANNOT log in for the user.

  3. Register the plugin with your OpenClaw install. Pointing at this repo:
       openclaw plugins register "$REPO_DIR/openclaw.plugin.json"
     (or copy/symlink the directory into your configured plugins root).

  4. Create your first pair:
       npx repost-with-agent pair create \\
         --source-platform linkedin \\
         --source-url "https://www.linkedin.com/in/<you>/recent-activity/all/" \\
         --destination-platform x \\
         --destination-account "@<you>" \\
         --run-mode listen-for-future \\
         --mode preview-only

  5. Preview before publishing:
       npx repost-with-agent pair preview <pair-id>
     The CLI will emit a [agent-task fetch-source ...] banner. The agent (you)
     reads the task and uses its browser MCP to fulfil it.

  6. Wire up scheduling per pair (one of):
       # OpenClaw users:
       npx repost-with-agent pair schedule <pair-id>     # prints openclaw cron add command
       # macOS launchd:
       npx repost-with-agent pair schedule <pair-id> --apply launchd
       launchctl load ~/Library/LaunchAgents/com.repost-with-agent.<pair-id>.plist
       # System cron:
       npx repost-with-agent pair schedule <pair-id>     # prints crontab line; pipe into crontab -e

     The host scheduler should call:
       repost-with-agent pair scheduled-run <pair-id>
     which is the deterministic, auditable per-tick entry point.

Live publishing always requires explicit --approve and a non-preview pair mode.
Scheduled runs default to preview-only; pass --allow-publish only when the saved
policy explicitly authorises live posting. See README and docs/safety.md.
EOF
