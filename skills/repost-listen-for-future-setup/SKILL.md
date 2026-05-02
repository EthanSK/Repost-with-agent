---
name: repost-listen-for-future-setup
description: Install a launchd plist (macOS) or cron entry (Linux) that periodically launches a fresh Claude Code or OpenClaw subagent to run /repost-run on enabled listen-for-future pairs. Use when the user asks to "schedule <pair>", "set up the cron for <pair>", "make <pair> tail new posts automatically", or invokes /repost-setup-cron.
when_to_trigger: User wants to wire up automatic, scheduled, recurring repost ticks for a listen-for-future pair.
---

# Repost Listen-for-future Setup

Install the host-level scheduler entry that triggers a fresh agent subagent on
a regular interval to run `/repost-run` against every enabled `listen-for-future`
pair.

The scheduler is OS-native (launchd on macOS, cron on Linux). The launched
process is a one-shot Claude Code or OpenClaw invocation that loads the
plugin, runs the command, exits.

## Required state

- The pair MUST exist in `~/.repost-with-agent/pairs.json` with
  `runMode === "listen-for-future"` and `enabled === true`.
- The pair MUST be in `mode === "live-approved"` for the scheduler to actually
  publish (otherwise the scheduled subagent will preview-only).
- Telegram MUST be configured (run the `repost-notify` test once before
  enabling cron).

## Cadence

Default: every 5 hours. Configurable via the pair's `schedule.everyHours` field
(positive integer) or `schedule.expression` if the user wants a full cron
spec.

Conservative defaults; LinkedIn / X / Bluesky etc. don't post that often, so
hammering every 5 minutes burns API quota / risks rate-limits without payoff.

## macOS — launchd

1. Determine which agent harness to use:
   - If `command -v claude` succeeds (Claude Code CLI installed) → use Claude Code.
   - Else if `command -v openclaw` succeeds → use OpenClaw.
   - Else stop and tell the user to install one.

2. Choose the invocation pattern. For Claude Code:

   ```bash
   /usr/local/bin/claude --print --no-banner "/repost-run-all"
   ```

   For OpenClaw (consult its CLI flags; OpenClaw spawns a fresh ephemeral agent
   per invocation by default):

   ```bash
   /usr/local/bin/openclaw run "/repost-run-all"
   ```

3. Write a plist to `~/Library/LaunchAgents/com.ethansk.repost-with-agent.<pair-id>.plist`:

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key>
     <string>com.ethansk.repost-with-agent.<pair-id></string>
     <key>ProgramArguments</key>
     <array>
       <string>/bin/bash</string>
       <string>-lc</string>
       <string>/usr/local/bin/claude --print --no-banner "/repost-run <pair-id>" >> $HOME/.repost-with-agent/pairs/<pair-id>/logs/cron.log 2>&1</string>
     </array>
     <key>StartInterval</key>
     <integer><everyHours * 3600></integer>
     <key>RunAtLoad</key>
     <false/>
     <key>StandardOutPath</key>
     <string>/tmp/repost-with-agent.<pair-id>.stdout.log</string>
     <key>StandardErrorPath</key>
     <string>/tmp/repost-with-agent.<pair-id>.stderr.log</string>
   </dict>
   </plist>
   ```

   Replace `<pair-id>` and `<everyHours * 3600>` (e.g. 5h = 18000) before writing.

4. Load it:

   ```bash
   launchctl unload ~/Library/LaunchAgents/com.ethansk.repost-with-agent.<pair-id>.plist 2>/dev/null
   launchctl load ~/Library/LaunchAgents/com.ethansk.repost-with-agent.<pair-id>.plist
   ```

5. Verify with `launchctl list | grep repost-with-agent`. Tell the user.

## Linux — cron

1. Open the user's crontab (`crontab -l > /tmp/crontab.cur && cp /tmp/crontab.cur /tmp/crontab.new`).
2. Append a line (don't duplicate if already present — grep first):

   ```
   0 */<everyHours> * * * /usr/local/bin/claude --print --no-banner "/repost-run <pair-id>" >> $HOME/.repost-with-agent/pairs/<pair-id>/logs/cron.log 2>&1
   ```

3. Install the new crontab: `crontab /tmp/crontab.new`.
4. Verify with `crontab -l | grep repost-with-agent`. Tell the user.

## Mandatory pre-flight checklist

Before installing the scheduler, the agent must verify:

- [ ] `pair.enabled === true`
- [ ] `pair.mode === "live-approved"` (else: refuse and tell the user to bump the mode first)
- [ ] `pair.runMode === "listen-for-future"`
- [ ] User is logged into source + destination platforms in the browser MCP profile
- [ ] At least one preview run has succeeded (check audit.jsonl for a `pair.preview.success` or `pair.publish.success` event)
- [ ] Telegram is configured (run the `repost-notify` test skill once, see it land)

If any of these fail, refuse to install the scheduler and tell the user which
prerequisite is missing.

## Updating cadence later

If the user changes `pair.schedule.everyHours` later, the agent must re-write
the plist / crontab. Easy way:

1. Run the uninstall script first (un-load the plist / remove the cron line).
2. Re-run this skill.

## Uninstall

To stop the scheduler:

- macOS: `launchctl unload ~/Library/LaunchAgents/com.ethansk.repost-with-agent.<pair-id>.plist && rm ~/Library/LaunchAgents/com.ethansk.repost-with-agent.<pair-id>.plist`
- Linux: edit crontab (`crontab -e` — but DON'T do this interactively from an
  agent; use `crontab -l > /tmp/c && grep -v 'repost-with-agent.<pair-id>' /tmp/c > /tmp/c.new && crontab /tmp/c.new`).

## What `/repost-run-all` does

The scheduled invocation runs `/repost-run` for EVERY enabled, `live-approved`,
`listen-for-future` pair, sequentially with a small jittered delay between
pairs. Implementation: the slash command (`commands/run.md`) supports both
`<pair-id>` and `all` as arguments; with `all` the agent iterates pairs.json.

## Telegram-confirm every successful publish — non-negotiable

The scheduled subagent runs `repost-run`, which already enforces this rule.
Don't add a separate ping for the cron tick itself — that would be noise. Just
the per-publish ping.

## Cron-spawned subagents read + write learnings.md

Every cron / launchd tick spawns a fresh, ephemeral Claude Code or OpenClaw
subagent that loads this plugin and runs `/repost-run <pair-id>`. That
subagent ALSO follows the learnings-file lifecycle:

- **Step 1.5 of `repost-run`**: the subagent reads
  `~/.repost-with-agent/pairs/<id>/learnings.md` before scraping, so it
  inherits every quirk discovered by prior ticks.
- **Final step of `repost-run`**: the subagent appends any newly-discovered
  quirks to the same file before exiting.

Over time the file becomes the primary mechanism by which the cron pipeline
gets smarter at running this specific pair. There is no shared in-memory
state between ticks — `learnings.md` is the only continuity.

When you install the scheduler entry, ensure
`~/.repost-with-agent/pairs/<id>/learnings.md` exists (create the placeholder
stub from `templates/learnings.md.template` if missing). The cron-spawned
subagent will populate it organically from there.

See `skills/repost-learnings/SKILL.md` for the full lifecycle + signal-vs-noise
rules.

## See also

- `skills/repost-run/SKILL.md` — what each cron tick actually does.
- `skills/repost-learnings/SKILL.md` — the per-pair institutional-memory file
  cron-spawned subagents read + write.
- `commands/setup-cron.md` — slash command wrapper.
- `docs/state-files.md` — pair config + state schemas.
