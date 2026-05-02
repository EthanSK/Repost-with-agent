# v3 → v4 migration

v4 is the **second** major rewrite within an hour, shipped 2026-05-01. v3 had
already stripped Playwright + API SDKs and introduced an agent-task contract.
v4 deletes the CLI entirely and ships ONLY skills + slash commands.

If you're upgrading an existing v3 install, this doc walks you through it.

## TL;DR

1. Run `bash scripts/install.sh` from the v4 plugin clone. It registers the
   plugin with Claude Code (`~/.claude/settings.json`) and OpenClaw
   (`~/.openclaw/openclaw.json`), backs up both files, and migrates
   `~/.repost-with-agent/pairs.json` from `schemaVersion: 3` to `4`.
2. Restart Claude Code (`/exit` and re-open) and OpenClaw (gateway bootout +
   kickstart) to load the new plugin.
3. Verify with `/pair list` (Claude Code) — should show your existing pairs
   with the v4 schema.

The v3 CLI binary is no longer needed. You can `npm uninstall -g
repost-with-agent` if you had it globally installed; nothing in v4 depends on
it.

## What changed

### Deleted (v3 → v4)

- The entire `src/` TypeScript codebase (CLI, orchestrator, agent-task
  contract, dedupe, scheduling, notify, url-expander, types, etc.).
- The `tests/` regression suite (none of it applies to skill-driven flow).
- `package-lock.json`, `tsconfig.json`, `.env.example`, `node_modules/`.
- `dist/` build artefacts.
- The `examples/`, `site/`, `.github/` directories.
- `docs/WORKFLOW.md`, `docs/scheduling.md`, `docs/safety.md`,
  `docs/setup-flow.md`, `docs/migration-v2-to-v3.md`, `docs/url-expander.md`,
  `docs/migration.md`, `docs/architecture.md` (old v3 version).
- The `repost-with-agent` CLI binary entry from `package.json`.
- `commands/preview.md` (functionality folded into `commands/run.md`).
- `scripts/agent-bridge-handler.sh`, `scripts/init_repost_with_agent_workspace.py`,
  `scripts/install-for-openclaw.sh` (old v3 installer).
- `templates/repost_with_agent_workspace/` (old workspace template).

### Added (v3 → v4)

- `.claude-plugin/marketplace.json` (directory-source marketplace manifest).
- 10 `skills/*/SKILL.md` files (the playbook).
- 4 `commands/*.md` slash command wrappers.
- `scripts/install.sh` + `scripts/uninstall.sh` (idempotent, edits both
  Claude Code and OpenClaw config files with backups).
- `templates/pairs.json.template`, `templates/posted.jsonl.template`,
  `templates/audit.jsonl.template`.
- `docs/state-files.md`, `docs/architecture.md`, `docs/migration-v3-to-v4.md`,
  `docs/url-expander.md` (rewritten as agent-facing).
- `INSTRUCTIONS.md` for the running agent.

### Changed (v3 → v4)

- `package.json` — bare metadata. No `bin`, no `main`, no `scripts`, no
  dependencies.
- `.claude-plugin/plugin.json` — declares 10 skills + 4 commands. `version`
  bumped 3.0.0 → 4.0.0.
- `openclaw.plugin.json` — `runtime` block removed (no entrypoint to run);
  `skills_roots` + `commands_roots` only.
- `pairs.json` schema — `schemaVersion` bumped 3 → 4. Deprecated fields
  ignored (`policy.requirePreviewBeforeFirstLiveRun`,
  `policy.preferOfficialApi`, `dedupe.strategy`, `*.authRef`, `source.type`,
  `destination.type`).
- The Telegram-on-publish rule is now enforced by the `repost-notify` skill
  (and replayed in `repost-run` step 10 + `repost-backfill` step 6) — there's
  no `notify.json` config file in v4. The plugin uses the running session's
  `plugin:telegram:telegram` plugin, which has its own access config.

## Schema migration: pairs.json v3 → v4

The `scripts/install.sh` script handles this for you. The transformation:

```diff
 {
-  "version": 1,
-  "schemaVersion": 3,
+  "schemaVersion": 4,
   "pairs": [
     {
       "id": "linkedin-to-x",
       "name": "Legacy LinkedIn to X",
       "enabled": true,
       "mode": "live-approved",
       "source": {
-        "type": "linkedin-profile-activity",
         "url": "https://www.linkedin.com/in/ethansk",
         "profileUrl": "https://www.linkedin.com/in/ethansk",
-        "authRef": "browser:playwright:linkedin",
         "platform": "linkedin"
       },
       "destination": {
-        "type": "x-account",
         "accountHint": "@REEEthan_YT",
-        "authRef": "oauth1:x:env",
         "platform": "x"
       },
       "schedule": {
         "kind": "manual",
         "tz": "Europe/London",
-        "expression": "0 10 * * *"
+        "expression": "0 */5 * * *",
+        "everyHours": 5
       },
       "policy": {
-        "requirePreviewBeforeFirstLiveRun": true,
         "maxItemsPerRun": 1,
         "minDelayBetweenPostsMinutes": 60,
-        "preferOfficialApi": true,
-        "blockOnUncertainDuplicate": true
+        "blockOnUncertainDuplicate": true,
+        "overlengthStrategy": "skip"
       },
-      "dedupe": {
-        "strategy": "source-id-url-content-hash"
-      },
+      "runMode": "listen-for-future"
     }
   ]
 }
```

Backups:

- `~/.repost-with-agent/pairs.json.v3.bak` — the v3 file as it was before migration.
- The v2 file from the previous rewrite is still at `~/.repost-with-agent/pairs.json.v2.bak`.

## State files preserved across the rewrite

- `~/.repost-with-agent/pairs/<id>/posted.jsonl` — UNTOUCHED. Schema is the
  same in v3 and v4.
- `~/.repost-with-agent/pairs/<id>/audit.jsonl` — UNTOUCHED. v4 adds new event
  names but doesn't change existing ones.
- `~/.repost-with-agent/pairs/<id>/learnings.md` — UNTOUCHED.

The 11 entries in `~/.repost-with-agent/pairs/linkedin-to-x/posted.jsonl` from
the v3 install survive the migration unchanged.

## What you (the user) need to do

1. `cd` to your v4 clone.
2. `bash scripts/install.sh`.
3. Restart Claude Code (`/exit` and re-open) and OpenClaw (gateway bootout +
   kickstart).
4. In a fresh Claude Code session, run `/pair list`. Confirm your existing
   pairs show up.
5. Run `/pair show linkedin-to-x` (or whichever pair). Confirm the schema is
   v4.
6. Run `/repost-run <pair-id>` to do a manual tick. Confirm a Telegram
   confirmation lands.
7. Run `/repost-setup-cron <pair-id>` to install the launchd / cron entry for
   recurring listen-for-future ticks (default every 5 hours).

## Rollback

If v4 doesn't work for you and you need to roll back to v3:

1. `git checkout 013d92f` (the last v3 commit) — or use a separate clone.
2. `npm install && npm run build` (v3 needed a build step).
3. Edit `~/.claude/settings.json` to point the marketplace path back at the
   v3 clone.
4. Manually restore `~/.repost-with-agent/pairs.json` from
   `~/.repost-with-agent/pairs.json.v3.bak`.
5. Restart Claude Code.

But honestly: try v4 first. The rewrite was driven by Ethan's explicit voice
direction (6024 + 6026) — if it doesn't work, the right move is to fix v4,
not roll back.
