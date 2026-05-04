---
name: repost-listen-for-future-setup
description: Install a scheduler entry that periodically launches a fresh current-harness agent/subagent to run /repost-run on enabled listen-for-future pairs. Use when the user asks to "schedule <pair>", "set up the cron for <pair>", "make <pair> tail new posts automatically", or invokes /repost-setup-cron.
when_to_trigger: User wants to wire up automatic, scheduled, recurring repost ticks for a listen-for-future pair.
---

# Repost Listen-for-future Setup

Install the scheduler entry that triggers a fresh agent/subagent on a regular
interval to run `/repost-run` against a `listen-for-future` pair.

**OpenClaw is a first-class path.** If the current workflow is running in
OpenClaw, use OpenClaw's native `openclaw cron` scheduler. Do **not** write a
launchd job that shells out to Claude Code, and do **not** prefer Claude Code
just because `claude` happens to be installed. Claude Code / launchd / system
cron are fallbacks only when the workflow is intentionally based on that
harness or Ethan explicitly asks for them.

## Required state

- The pair MUST exist in `~/.repost-with-agent/pairs.json` with
  `runMode === "listen-for-future"` and `enabled === true`.
- The pair MUST be in `mode === "live-approved"` for the scheduler to actually
  publish. Refuse to schedule non-live-approved pairs unless Ethan explicitly
  asks for a preview-only scheduler.
- Telegram/message delivery MUST be configured (run the `repost-notify` test
  once before enabling scheduled publishes).
- The user MUST already be logged into source + destination platforms in the
  current harness browser profile. You cannot log in for them.
- **OpenClaw hard rule:** OpenClaw scheduled ticks MUST use OpenClaw's own
  browser/profile (`profile: openclaw`, CDP port `18800`). Do **not** use
  Ethan's personal browser, Chrome relay, or `profile="user"` for
  Repost-with-agent unless Ethan explicitly overrides this for a specific run.

## Cadence

Default: once per day. Configurable via the pair's `schedule.everyHours` field
(positive integer) or `schedule.expression` if the user wants a full cron spec.

Conservative defaults; LinkedIn / X / Bluesky etc. don't post that often, so
hammering every few minutes burns quota / risks rate-limits without payoff.

## OpenClaw scheduler — preferred for OpenClaw workflows

1. Determine cadence:
   - If `pair.schedule.everyHours` exists, use `--every "<N>h"`.
   - If `pair.schedule.expression` exists and the user explicitly wants a cron
     expression, use `--cron "<expr>" --tz "<pair.schedule.tz>"`.

2. Create an OpenClaw cron job. Template:

   ```bash
   openclaw cron add \
     --name "repost-with-agent.<pair-id>" \
     --description "Repost-with-agent scheduled tick for <pair-id>" \
     --agent main \
     --session isolated \
     --message "/repost-run <pair-id>" \
     --thinking medium \
     --timeout-seconds 10800 \
     --every "<everyHours>h"
   ```

   For cron-expression cadence, replace the last line with:

   ```bash
     --cron "<schedule.expression>" --tz "<schedule.tz or Europe/London>"
   ```

   Do not add a restrictive `--tools` list unless you are certain it includes
   browser automation, file tools, Bash, and Telegram/message delivery.

3. Delivery notes:
   - `/repost-run` itself MUST confirm every successful publish via
     `repost-notify`; that is the important user-facing ping. The confirmation
     goes through the primary current-harness communication channel with the
     user (Telegram in Ethan's OpenClaw setup, or the harness equivalent
     elsewhere) and includes every destination post link created in the run.
   - Add `--announce --channel telegram --account <account> --to <chat-id>` only
     if Ethan explicitly wants every scheduled tick's final transcript delivered
     too. Otherwise it is usually noise.

4. Verify without triggering a publish:

   ```bash
   openclaw cron show repost-with-agent.<pair-id>
   openclaw cron list
   ```

   Do **not** run `openclaw cron run` as a verification step unless Ethan asks;
   it may publish if the pair is live-approved.

## launchd fallback — only for non-OpenClaw / explicitly chosen harnesses

Use this only when the current workflow is intentionally Claude Code-based (or
another shell-invokable harness) and Ethan has approved that harness choice.

1. Choose and verify the current-harness invocation before writing any scheduler
   file. If you cannot verify it, stop and ask rather than guessing.
2. Write a plist to `~/Library/LaunchAgents/com.ethansk.repost-with-agent.<pair-id>.plist`:

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
       <string><verified-current-harness-command> "/repost-run <pair-id>" >> $HOME/.repost-with-agent/pairs/<pair-id>/logs/cron.log 2>&1</string>
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

3. Load and verify:

   ```bash
   launchctl unload ~/Library/LaunchAgents/com.ethansk.repost-with-agent.<pair-id>.plist 2>/dev/null
   launchctl load ~/Library/LaunchAgents/com.ethansk.repost-with-agent.<pair-id>.plist
   launchctl list | grep repost-with-agent
   ```

## Linux crontab fallback — only for non-OpenClaw / explicitly chosen harnesses

1. Copy the user's crontab to temp files (`crontab -l > /tmp/crontab.cur && cp /tmp/crontab.cur /tmp/crontab.new`).
2. Append a line only if it is not already present:

   ```
   0 */<everyHours> * * * <verified-current-harness-command> "/repost-run <pair-id>" >> $HOME/.repost-with-agent/pairs/<pair-id>/logs/cron.log 2>&1 # repost-with-agent.<pair-id>
   ```

3. Install and verify: `crontab /tmp/crontab.new && crontab -l | grep repost-with-agent`.

## Mandatory pre-flight checklist

Before installing the scheduler, verify:

- [ ] `pair.enabled === true`
- [ ] `pair.mode === "live-approved"` (else: refuse and tell the user to bump the mode first)
- [ ] `pair.runMode === "listen-for-future"`
- [ ] User is logged into source + destination platforms in the current harness browser profile
- [ ] At least one preview run has succeeded (check audit.jsonl for a `pair.preview.success` or `pair.publish.success` event)
- [ ] Telegram/message delivery is configured (run the `repost-notify` test skill once, see it land)

If any check fails, refuse to install the scheduler and tell the user which
prerequisite is missing.

## Updating cadence later

If the user changes `pair.schedule.everyHours` or `pair.schedule.expression`:

- OpenClaw: resolve the job with `openclaw cron show repost-with-agent.<pair-id>`,
  then run `openclaw cron edit <job-id> --every "<N>h"` or recreate the job
  if the CLI cannot patch the exact field you need.
- launchd / crontab fallback: remove the old entry, then re-run this skill.

## Uninstall

To stop the scheduler:

- OpenClaw: `openclaw cron show repost-with-agent.<pair-id>` to confirm the exact job,
  then `openclaw cron rm <job-id>` and verify with `openclaw cron list`.
- launchd fallback: `launchctl unload ~/Library/LaunchAgents/com.ethansk.repost-with-agent.<pair-id>.plist` and then move/delete the plist.
- Linux crontab fallback: do not use interactive `crontab -e` from an agent;
  use `crontab -l > /tmp/c && grep -v 'repost-with-agent.<pair-id>' /tmp/c > /tmp/c.new && crontab /tmp/c.new`.

## What `/repost-run all` does

The scheduled invocation can run `/repost-run <pair-id>` for one pair or
`/repost-run all` for EVERY enabled, `live-approved`, `listen-for-future` pair,
sequentially with a small jittered delay between pairs. Prefer one job per pair
unless Ethan explicitly wants a single all-pairs job; it is easier to disable or
reschedule one pair without affecting others.

## Telegram-confirm every successful publish — non-negotiable

The scheduled agent runs `repost-run`, which already enforces this rule. Don't
add a separate ping for the scheduler tick itself — that would be noise. Just
the per-publish ping.

## Scheduled agents read + write learnings.md

Every scheduled tick spawns a fresh, ephemeral current-harness agent that loads
this plugin and runs `/repost-run <pair-id>`. That agent ALSO follows the
learnings-file lifecycle:

- **Step 1.5 of `repost-run`**: the agent reads
  `~/.repost-with-agent/pairs/<id>/learnings.md` before scraping, so it inherits
  every quirk discovered by prior ticks.
- **Final step of `repost-run`**: the agent appends any newly-discovered quirks
  to the same file before exiting.

Over time the file becomes the primary mechanism by which the scheduled
pipeline gets smarter at running this specific pair. There is no shared
in-memory state between ticks — `learnings.md` is the only continuity.

When you install the scheduler entry, ensure
`~/.repost-with-agent/pairs/<id>/learnings.md` exists (create the placeholder
stub from `templates/learnings.md.template` if missing). The scheduled agent
will populate it organically from there.

See `skills/repost-learnings/SKILL.md` for the full lifecycle + signal-vs-noise
rules.

## See also

- `skills/repost-run/SKILL.md` — what each scheduled tick actually does.
- `skills/repost-learnings/SKILL.md` — the per-pair institutional-memory file
  scheduled agents read + write.
- `commands/setup-cron.md` — slash command wrapper.
- `docs/state-files.md` — pair config + state schemas.
