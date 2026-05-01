#!/usr/bin/env bash
#
# install-for-openclaw.sh — One-shot setup for Repost-with-agent under OpenClaw.
#
# Idempotent. Safe to re-run.
#
# Steps:
#   1. Verify Node + npm available.
#   2. Install npm deps + build TypeScript.
#   3. Verify CLI is callable via `npx repost-with-agent --help`.
#   4. Ensure runtime data dir (~/.repost-with-agent) exists.
#   5. Print the OpenClaw skills_root and plugin id so the operator (or
#      OpenClaw's plugin loader) knows where to point.
#
# This script does NOT install OpenClaw itself, register cron jobs, or log
# you into LinkedIn / X. Those are explicit human-controlled operations.
set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DATA_DIR="${REPOST_DATA_DIR:-$HOME/.repost-with-agent}"

log() { printf "[install-for-openclaw] %s\n" "$*"; }

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

log "Installing npm dependencies (npm install)..."
npm install --no-audit --no-fund --silent

log "Building TypeScript (npm run build)..."
npm run build --silent

if [[ ! -x "$REPO_DIR/dist/index.js" ]]; then
  chmod +x "$REPO_DIR/dist/index.js" || true
fi

log "Smoke-testing CLI..."
node "$REPO_DIR/dist/index.js" --version

mkdir -p "$DATA_DIR/pairs"
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
Repost-with-agent is installed for OpenClaw use.

Next steps for the operator:
  1. Register the plugin with your OpenClaw install. Pointing at this repo:
       openclaw plugins register "$REPO_DIR/openclaw.plugin.json"
     (or copy/symlink the directory into your configured plugins root).

  2. Log into LinkedIn (and X if you'll use the OAuth flow) inside the
     persistent Playwright profile referenced by PLAYWRIGHT_PROFILE_DIR or
     pluginConfig.playwrightProfileDir.

  3. Create your first pair:
       npx repost-with-agent pair create \\
         --source-type linkedin-profile-activity \\
         --source-url "https://www.linkedin.com/in/<you>/recent-activity/all/" \\
         --destination-type x-account \\
         --destination-account "@<you>"

  4. Preview before publishing:
       npx repost-with-agent pair preview <pair-id>

  5. Schedule via OpenClaw cron (see README "Scheduling" section).

Live publishing always requires an explicit --approve flag and a non-preview
pair mode. See README and docs/safety.md.
EOF
