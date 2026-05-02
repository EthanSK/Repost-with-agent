#!/usr/bin/env bash
set -euo pipefail

# Repost-with-agent v4.0.0 uninstaller
# Idempotent. Removes the plugin from Claude Code (~/.claude/settings.json) and
# OpenClaw (~/.openclaw/openclaw.json). Does NOT delete ~/.repost-with-agent/
# state — that stays intact in case you reinstall later.
#
# Usage:
#   bash scripts/uninstall.sh
#
# Pass --dry-run to print the planned changes without writing.

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
  esac
done

PYBIN=""
if command -v python3 >/dev/null 2>&1; then PYBIN=python3
elif command -v python  >/dev/null 2>&1; then PYBIN=python
else
  printf 'uninstall.sh: python3 / python is required.\n' >&2
  exit 1
fi

UNIX_TS="$(date +%s)"

backup_file() {
  local f="$1"
  if [[ -f "$f" ]]; then
    cp "$f" "${f}.bak.${UNIX_TS}"
  fi
}

unregister_claude_code() {
  local settings_path="$HOME/.claude/settings.json"
  if [[ ! -f "$settings_path" ]]; then
    printf '  [skip] Claude Code not detected.\n'
    return 0
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '  [dry-run] would unregister from %s\n' "$settings_path"
    return 0
  fi
  backup_file "$settings_path"

  SETTINGS_PATH="$settings_path" "$PYBIN" - <<'PYEOF'
import json, os, pathlib
p = pathlib.Path(os.environ["SETTINGS_PATH"])
data = json.loads(p.read_text(encoding="utf-8"))
changed = False
mp = data.get("extraKnownMarketplaces", {})
if "repost-with-agent" in mp:
    del mp["repost-with-agent"]
    changed = True
ep = data.get("enabledPlugins", {})
if "repost-with-agent@repost-with-agent" in ep:
    del ep["repost-with-agent@repost-with-agent"]
    changed = True
if changed:
    p.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print("removed")
else:
    print("already-absent")
PYEOF
  printf '  [ok] Claude Code: removed from %s\n' "$settings_path"
}

unregister_openclaw() {
  local cfg="$HOME/.openclaw/openclaw.json"
  if [[ ! -f "$cfg" ]]; then
    printf '  [skip] OpenClaw not detected.\n'
    return 0
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '  [dry-run] would unregister from %s\n' "$cfg"
    return 0
  fi
  backup_file "$cfg"
  CFG_PATH="$cfg" "$PYBIN" - <<'PYEOF'
import json, os, pathlib
p = pathlib.Path(os.environ["CFG_PATH"])
data = json.loads(p.read_text(encoding="utf-8"))
plugins = data.get("plugins", {})
load = plugins.get("load", {})
paths = load.get("paths", []) or []
new_paths = [x for x in paths if "Repost-with-agent" not in x and "repost-with-agent" not in x]
changed = (len(new_paths) != len(paths))
if changed:
    load["paths"] = new_paths
entries = plugins.get("entries", {})
if "repost-with-agent" in entries:
    del entries["repost-with-agent"]
    changed = True
if changed:
    p.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print("removed")
else:
    print("already-absent")
PYEOF
  printf '  [ok] OpenClaw: removed from %s\n' "$cfg"
}

printf '\n'
printf '  Repost-with-agent v4.0.0 uninstaller\n'
printf '  -----------------------------------\n'

unregister_claude_code
unregister_openclaw

printf '\n'
printf '  Done. State directory ~/.repost-with-agent/ left intact.\n'
printf '  Remove it manually if you want a clean slate: rm -rf ~/.repost-with-agent\n'
printf '\n'
