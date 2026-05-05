---
description: Install a current-harness scheduler entry that periodically launches a fresh agent/subagent to run /repost-run on enabled listen-for-future pairs. OpenClaw cron is the preferred scheduler for OpenClaw workflows.
---

# `/repost-setup-cron`

Install the scheduler entry that triggers a fresh agent/subagent on a regular
interval to run `/repost-run` against every enabled `live-approved`
`listen-for-future` pair.

## Usage

```
/repost-setup-cron <pair-id>
```

Default cadence: once per day. Configurable via the pair's
`schedule.everyHours` field; edit the pair first with `/pair edit <id>` if you
want a different cadence.

## Pre-flight checklist

The matching skill (`skills/repost-listen-for-future-setup/SKILL.md`) refuses
to install the scheduler unless ALL of these hold:

- [ ] `pair.enabled === true`
- [ ] `pair.mode === "live-approved"`
- [ ] `pair.runMode === "listen-for-future"`
- [ ] User is logged into source + destination platforms in the current harness browser profile
- [ ] At least one preview run has succeeded (audit.jsonl shows a `pair.preview.success` or `pair.publish.success`)
- [ ] `notification.delivery` is configured for the current user-facing channel and the `repost-notify` test landed


**Notification routing rule:** user-visible Repost notifications are not inherently Telegram-specific. Store the route in `~/.repost-with-agent/pairs.json` under `notification.delivery` (for example `channel`, `accountId`, `target`, optional `threadId`) using the current harness/chat metadata during setup. Scheduled runs must read that route and pass it explicitly to the harness message tool; never rely on a default account/bot, and never paste raw JSON/tool output into user-facing messages.

If any check fails, the skill tells the user which prerequisite is missing and
stops.

## What gets installed

- **OpenClaw workflows (preferred):** an `openclaw cron` job that starts a
  fresh isolated agent turn with `--message "/repost-run <pair-id>"` and
  `thinking=medium` by default. Escalate only when the user or pair explicitly
  needs heavier reasoning.
- **Claude Code / other explicitly chosen harnesses:** an equivalent scheduler
  for that harness. On macOS this can be a launchd plist; on Linux this can be
  a crontab line. Use this fallback only when the workflow is intentionally not
  OpenClaw-based or Ethan explicitly asks for it.

Do **not** route an OpenClaw-owned Repost-with-agent workflow through Claude
Code just because `claude` is installed. The scheduler should invoke the same
harness that owns the workflow.

## Uninstall

To stop the scheduler:

- OpenClaw: `openclaw cron show repost-with-agent.<pair-id>` to confirm the exact job,
  then `openclaw cron rm <job-id>` and verify with `openclaw cron list`.
- launchd fallback: unload the plist and move/delete it.
- crontab fallback: remove the matching `repost-with-agent.<pair-id>` line.

## See also

- `skills/repost-listen-for-future-setup/SKILL.md` — full step-by-step.
- `skills/repost-run/SKILL.md` — what each scheduled tick actually does.
- `/pair edit <pair-id>` — adjust cadence by editing `schedule.everyHours`.
