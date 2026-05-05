---
name: repost-listen-for-future-setup
description: Install a scheduler entry that periodically launches ONE fresh current-harness agent/subagent to run /repost-run all across every enabled listen-for-future pair. Use when the user asks to schedule Repost-with-agent, set up the cron, make pairs tail new posts automatically, or invokes /repost-setup-cron.
when_to_trigger: User wants to wire up automatic, scheduled, recurring repost sweeps for enabled listen-for-future pairs.
---

# Repost Listen-for-future Setup

Install the scheduler entry that triggers a single fresh agent/subagent on a
regular interval to run `/repost-run all` across every enabled
`listen-for-future` pair.

**OpenClaw is a first-class path.** If the current workflow is running in
OpenClaw, use OpenClaw's native `openclaw cron` scheduler. Do **not** write a
launchd job that shells out to Claude Code, and do **not** prefer Claude Code
just because `claude` happens to be installed. Claude Code / launchd / system
cron are fallbacks only when the workflow is intentionally based on that
harness or Ethan explicitly asks for them.

## Required state

- At least one pair MUST exist in `~/.repost-with-agent/pairs.json` with
  `runMode === "listen-for-future"` and `enabled === true`.
- The all-pairs scheduler MUST only publish pairs in `mode === "live-approved"`.
  Refuse to schedule if no enabled live-approved listen-for-future pairs exist,
  unless Ethan explicitly asks for a preview-only scheduler.
- `notification.delivery` MUST be configured and tested for every pair the sweep
  may publish (run the `repost-notify` test once before enabling scheduled publishes).
- The user MUST already be logged into source + destination platforms needed by
  the enabled pairs in the current harness browser profile. You cannot log in for them.
- **OpenClaw hard rule:** OpenClaw scheduled ticks MUST use OpenClaw's own
  browser/profile (`profile: openclaw`, CDP port `18800`). Do **not** use
  Ethan's personal browser, Chrome relay, or `profile="user"` for
  Repost-with-agent unless Ethan explicitly overrides this for a specific run.

## Cadence

Default: once per day. Configurable via a deliberately chosen global sweep
cadence. Do not infer per-pair staggered schedules unless Ethan explicitly asks
for separate per-pair jobs.

Conservative defaults; LinkedIn / X / Bluesky etc. don't post that often, so
hammering every few minutes burns quota / risks rate-limits without payoff.

## OpenClaw scheduler — preferred for OpenClaw workflows

1. Determine the global sweep cadence. Default is daily at the current
   user-facing timezone's preferred posting/check time (Europe/London unless
   configured otherwise).

2. Create exactly one OpenClaw cron job for the sweep. Template:

   ```bash
   openclaw cron add \
     --name "repost-with-agent.all.daily" \
     --description "Repost-with-agent scheduled all-pairs sweep" \
     --agent main \
     --session isolated \
     --message "/repost-run all" \
     --thinking medium \
     --timeout-seconds 21600 \
     --cron "0 10 * * *" \
     --tz "Europe/London"
   ```

   The scheduled agent must sweep pairs sequentially inside this one turn. Do
   not create one cron job or one spawned sub-agent per pair unless Ethan
   explicitly asks for that exception.

   Do not add a restrictive `--tools` list unless you are certain it includes
   browser automation, file tools, Bash, and configured user-message delivery.

3. Delivery notes:
   - `/repost-run` itself MUST confirm every successful publish via
     `repost-notify`; that is the important user-facing ping. The concrete
     channel/account/target MUST come from `notification.delivery` in
     `~/.repost-with-agent/pairs.json` (captured from the current chat/harness
     during setup). Never rely on default delivery accounts, and never send raw
     JSON/tool output in user-facing messages.
   - Add `--announce --channel telegram --account <account> --to <chat-id>` only
     if Ethan explicitly wants every scheduled tick's final transcript delivered
     too. Otherwise it is usually noise.

4. Verify without triggering a publish:

   ```bash
   openclaw cron show repost-with-agent.all.daily
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

- [ ] At least one pair has `enabled === true`
- [ ] At least one pair has `mode === "live-approved"` (else: refuse and tell the user to bump modes first)
- [ ] At least one pair has `runMode === "listen-for-future"`
- [ ] User is logged into source + destination platforms needed by the enabled live-approved pairs in the current harness browser profile
- [ ] At least one preview run has succeeded for each publish-capable destination family being scheduled (check audit.jsonl for `pair.preview.success` or `pair.publish.success` events)
- [ ] `notification.delivery` is configured for the current user-facing channel and the `repost-notify` test landed for each publish-capable pair

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

The scheduled invocation should run `/repost-run all` for EVERY enabled,
`live-approved`, `listen-for-future` pair, sequentially with a small jittered
delay between pairs. This is the default architecture: one cron job, one fresh
agent turn, one all-pairs sweep. Only create per-pair jobs if Ethan explicitly
asks for that exception.

## Telegram-confirm every successful publish — non-negotiable

The scheduled agent runs `repost-run`, which already enforces this rule. Don't
add a separate ping for the scheduler tick itself — that would be noise. Just
the per-publish ping.

## Scheduled agents read + write learnings.md

Every scheduled tick spawns one fresh, ephemeral current-harness agent that
loads this plugin and runs `/repost-run all`. That agent ALSO follows the
learnings-file lifecycle for each pair it sweeps:

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
