---
description: Install a launchd plist (macOS) or cron entry (Linux) that periodically launches a fresh agent subagent to run /repost-run on enabled listen-for-future pairs.
---

# `/repost-setup-cron`

Install the host-level scheduler entry that triggers a fresh agent subagent on
a regular interval to run `/repost-run` against every enabled `live-approved`
`listen-for-future` pair.

## Usage

```
/repost-setup-cron <pair-id>
```

Default cadence: every 5 hours. Configurable via the pair's
`schedule.everyHours` field; edit the pair first with `/pair edit <id>` if you
want a different cadence.

## Pre-flight checklist

The matching skill (`skills/repost-listen-for-future-setup/SKILL.md`) refuses
to install the scheduler unless ALL of these hold:

- [ ] `pair.enabled === true`
- [ ] `pair.mode === "live-approved"`
- [ ] `pair.runMode === "listen-for-future"`
- [ ] User is logged into source + destination platforms in the browser MCP profile
- [ ] At least one preview run has succeeded (audit.jsonl shows a `pair.preview.success` or `pair.publish.success`)
- [ ] Telegram is configured (run `repost-notify` test once)

If any check fails, the skill tells the user which prerequisite is missing and
stops.

## What gets installed

- macOS: `~/Library/LaunchAgents/com.ethansk.repost-with-agent.<pair-id>.plist`
  loaded with `launchctl load`. `StartInterval = everyHours * 3600` seconds.
- Linux: a cron line in the user's crontab.

The scheduler shells out to:

```bash
/usr/local/bin/claude --print --no-banner "/repost-run <pair-id>"
```

(Or the OpenClaw equivalent if Claude Code isn't installed.) The fresh
subagent loads this plugin, runs the command, exits.

## Uninstall

To stop the scheduler:

- macOS: `launchctl unload ~/Library/LaunchAgents/com.ethansk.repost-with-agent.<pair-id>.plist && rm` it.
- Linux: edit the crontab and remove the line.

## See also

- `skills/repost-listen-for-future-setup/SKILL.md` — full step-by-step.
- `skills/repost-run/SKILL.md` — what each cron tick actually does.
- `/pair edit <pair-id>` — adjust cadence by editing `schedule.everyHours`.
