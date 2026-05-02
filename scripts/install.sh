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
# `command -v` alone trusts the PATH, which on Windows / Microsoft Store can
# point at a stub redirector that exits nonzero when actually run. So actually
# exec the candidate to confirm it runs.
PYBIN=""
for cand in python3 python python3.13 python3.12 python3.11; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c "import sys" >/dev/null 2>&1; then
    PYBIN="$cand"
    break
  fi
done
if [ -z "$PYBIN" ]; then
  printf 'install.sh: python3 / python is required for safe JSON editing.\n' >&2
  printf 'install.sh: tried python3 / python / python3.13 / python3.12 / python3.11 — none executed cleanly.\n' >&2
  printf 'install.sh: on Windows, ensure a real Python is on PATH ahead of the WindowsApps Store stub.\n' >&2
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
    printf '  [skip] %s/pairs.json already exists; checking schema...\n' "$root"
    migrate_pairs_json "$root/pairs.json"
  fi
}

# ---- v3 → v4 schema migration on existing pairs.json ------------------------
migrate_pairs_json() {
  local pairs_path="$1"
  if [[ ! -f "$pairs_path" ]]; then return 0; fi

  PAIRS_PATH="$pairs_path" "$PYBIN" - <<'PYEOF'
import json, os, pathlib, shutil, sys
p = pathlib.Path(os.environ["PAIRS_PATH"])
try:
    data = json.loads(p.read_text(encoding="utf-8"))
except Exception as e:
    print(f"  [warn] {p} is not valid JSON ({e}); skipping migration.", file=sys.stderr)
    sys.exit(0)

current_version = data.get("schemaVersion")
if current_version == 4:
    print("  [skip] pairs.json already at schemaVersion 4; nothing to migrate.")
    sys.exit(0)

# Back up the v3 file (or whatever earlier shape) first.
backup = p.with_suffix(p.suffix + ".v3.bak")
if not backup.exists():
    shutil.copy2(str(p), str(backup))
    print(f"  [backup] {p} → {backup}")

# Migrate each pair to schemaVersion 4 shape.
pairs = data.get("pairs", []) or []
for pair in pairs:
    src = pair.get("source", {}) or {}
    dst = pair.get("destination", {}) or {}
    # Drop deprecated keys.
    for k in ("type", "authRef"):
        src.pop(k, None)
        dst.pop(k, None)
    # Ensure platform exists.
    if "platform" not in src and "url" in src and "linkedin" in src["url"]:
        src["platform"] = "linkedin"
    if "platform" not in dst:
        # Best-effort guess.
        for guess in ("x", "bluesky", "threads", "facebook", "linkedin"):
            hint = (dst.get("accountHint") or "") + " " + (dst.get("url") or "")
            if guess in hint.lower():
                dst["platform"] = guess
                break
    pair["source"] = src
    pair["destination"] = dst

    # Default runMode.
    pair.setdefault("runMode", "listen-for-future")

    # Schedule.everyHours default + cron expression.
    sched = pair.setdefault("schedule", {})
    sched.setdefault("kind", sched.get("kind", "manual"))
    sched.setdefault("tz", sched.get("tz", "Europe/London"))
    sched.setdefault("everyHours", 5)
    if sched["kind"] == "cron" and "expression" not in sched:
        sched["expression"] = f"0 */{sched['everyHours']} * * *"

    # Policy keys.
    pol = pair.setdefault("policy", {})
    pol.pop("requirePreviewBeforeFirstLiveRun", None)
    pol.pop("preferOfficialApi", None)
    pol.setdefault("maxItemsPerRun", 1)
    pol.setdefault("minDelayBetweenPostsMinutes", 60)
    pol.setdefault("blockOnUncertainDuplicate", True)
    pol.setdefault("overlengthStrategy", "skip")

    # Drop deprecated dedupe block.
    pair.pop("dedupe", None)

    # Drop nested schemaVersion (it's a top-level field in v4).
    pair.pop("schemaVersion", None)

# Set schemaVersion.
data["schemaVersion"] = 4
# v2/v3 had a "version" field; drop in v4.
data.pop("version", None)

p.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
print(f"  [ok] Migrated {p} from schemaVersion {current_version} to 4")
PYEOF
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
