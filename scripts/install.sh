#!/usr/bin/env bash
set -euo pipefail

# Repost-with-agent v4.0.0 installer
# Idempotent. Registers this skill-only plugin with both Claude Code (via
# ~/.claude/settings.json extraKnownMarketplaces + enabledPlugins) and OpenClaw
# (via ~/.openclaw/openclaw.json plugins.load.paths + plugins.entries).
#
# Usage:
#   bash scripts/install.sh
#
# Pass --dry-run to print the planned changes without writing.

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
  esac
done

# ---- locate plugin source ---------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ ! -f "$PLUGIN_ROOT/.claude-plugin/marketplace.json" ]]; then
  printf 'install.sh: cannot find .claude-plugin/marketplace.json next to %s\n' "$PLUGIN_ROOT" >&2
  exit 1
fi

# ---- pick a python interpreter for safe JSON edits --------------------------
PYBIN=""
if command -v python3 >/dev/null 2>&1; then PYBIN=python3
elif command -v python  >/dev/null 2>&1; then PYBIN=python
else
  printf 'install.sh: python3 / python is required for safe JSON editing.\n' >&2
  exit 1
fi

UNIX_TS="$(date +%s)"

backup_file() {
  local f="$1"
  if [[ -f "$f" ]]; then
    cp "$f" "${f}.bak.${UNIX_TS}"
    printf '  [backup] %s → %s.bak.%s\n' "$f" "$f" "$UNIX_TS"
  fi
}

validate_json() {
  local f="$1"
  if ! "$PYBIN" -c "import json,sys; json.load(open(sys.argv[1]))" "$f" >/dev/null 2>&1; then
    printf 'install.sh: %s is not valid JSON after edit. Restoring backup.\n' "$f" >&2
    if [[ -f "${f}.bak.${UNIX_TS}" ]]; then
      cp "${f}.bak.${UNIX_TS}" "$f"
    fi
    return 1
  fi
}

# ---- Claude Code: ~/.claude/settings.json -----------------------------------
register_claude_code() {
  local settings_path="$HOME/.claude/settings.json"
  if [[ ! -d "$HOME/.claude" ]]; then
    printf '  [skip] Claude Code not detected (no ~/.claude/).\n'
    return 0
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '  [dry-run] would register repost-with-agent in %s\n' "$settings_path"
    return 0
  fi

  backup_file "$settings_path"

  PLUGIN_ROOT="$PLUGIN_ROOT" SETTINGS_PATH="$settings_path" "$PYBIN" - <<'PYEOF'
import json, os, pathlib, sys
p = pathlib.Path(os.environ["SETTINGS_PATH"])
src = os.environ["PLUGIN_ROOT"]
data = {}
if p.exists():
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"could not parse {p}: {e}", file=sys.stderr)
        raise
data.setdefault("extraKnownMarketplaces", {})
data.setdefault("enabledPlugins", {})
changed = False
if data["extraKnownMarketplaces"].get("repost-with-agent") != {"source": {"source": "directory", "path": src}}:
    data["extraKnownMarketplaces"]["repost-with-agent"] = {
        "source": {"source": "directory", "path": src}
    }
    changed = True
key = "repost-with-agent@repost-with-agent"
if not data["enabledPlugins"].get(key):
    data["enabledPlugins"][key] = True
    changed = True
if changed:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print("registered")
else:
    print("already")
PYEOF

  validate_json "$settings_path"

  printf '  [ok] Claude Code: registered repost-with-agent in %s\n' "$settings_path"
  printf '       Restart Claude Code to load the skills + commands.\n'
}

# ---- OpenClaw: ~/.openclaw/openclaw.json -----------------------------------
register_openclaw() {
  local cfg="$HOME/.openclaw/openclaw.json"
  if [[ ! -f "$cfg" ]]; then
    printf '  [skip] OpenClaw not detected (no ~/.openclaw/openclaw.json).\n'
    return 0
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '  [dry-run] would register repost-with-agent in %s\n' "$cfg"
    return 0
  fi

  backup_file "$cfg"

  PLUGIN_ROOT="$PLUGIN_ROOT" CFG_PATH="$cfg" "$PYBIN" - <<'PYEOF'
import json, os, pathlib, sys
p = pathlib.Path(os.environ["CFG_PATH"])
src = os.environ["PLUGIN_ROOT"]
data = {}
if p.exists():
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"could not parse {p}: {e}", file=sys.stderr)
        raise
plugins = data.setdefault("plugins", {})
load = plugins.setdefault("load", {})
paths = load.setdefault("paths", [])
entries = plugins.setdefault("entries", {})
changed = False
if src not in paths:
    paths.append(src)
    changed = True
existing = entries.get("repost-with-agent")
if not existing:
    entries["repost-with-agent"] = {"enabled": True}
    changed = True
elif not existing.get("enabled"):
    existing["enabled"] = True
    changed = True
if changed:
    p.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print("registered")
else:
    print("already")
PYEOF

  validate_json "$cfg"

  printf '  [ok] OpenClaw: registered repost-with-agent in %s\n' "$cfg"
  printf '       Restart OpenClaw gateway (launchctl bootout / kickstart) to load the plugin.\n'
}

# ---- ~/.repost-with-agent/ scaffold ----------------------------------------
ensure_state_root() {
  local root="$HOME/.repost-with-agent"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '  [dry-run] would ensure %s exists with scaffold files\n' "$root"
    return 0
  fi
  mkdir -p "$root/pairs"
  if [[ ! -f "$root/pairs.json" ]]; then
    printf '{\n  "schemaVersion": 4,\n  "pairs": []\n}\n' > "$root/pairs.json"
    printf '  [ok] Created %s/pairs.json (empty)\n' "$root"
  else
    printf '  [skip] %s/pairs.json already exists; not overwriting.\n' "$root"
  fi
}

# ---- run --------------------------------------------------------------------
printf '\n'
printf '  Repost-with-agent v4.0.0 installer\n'
printf '  ---------------------------------\n'
printf '  Plugin source: %s\n' "$PLUGIN_ROOT"
printf '\n'

ensure_state_root
register_claude_code
register_openclaw

printf '\n'
printf '  Done. Read ./README.md for next steps.\n'
printf '\n'
