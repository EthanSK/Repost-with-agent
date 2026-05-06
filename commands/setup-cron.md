---
description: Install current-harness scheduler entries for Repost-with-agent. Default is one daily all-enabled-pairs sweep; custom per-pair, subset, dry/preview, and arbitrary cadence jobs are supported when the user asks.
---

# `/repost-setup-cron`

Install scheduler entry/entries that launch a fresh current-harness agent turn to
run Repost-with-agent on a cadence.

## Usage

```text
/repost-setup-cron
```

Default behavior for listen-for-future: install **one daily all-enabled-pairs
sweep** that runs `/repost-run all`. This is the simple starter shape and the
current intended shape for Ethan's listen mode.

Default behavior for source backfills: install a source-item fanout job. Each
slot chooses one source item and processes every enabled destination pair for
that source before moving on. Do not install one backfill slot per destination
unless the user explicitly asks for destination-specific jobs.

The default is not a limitation. If the user asks for a different layout, honor
it as long as it stays safe and current-harness-owned:

- source-item fanout jobs per source platform;
- separate cron jobs per pair when explicitly requested;
- named subset jobs, e.g. “work pairs at 09:00, personal pairs at 18:00”;
- custom cron expressions/timezones/every-N-hours cadences;
- dry/preview scheduled checks that never publish;
- manual-only pairs with no scheduler;
- multiple scheduler entries that run the same pair/scope in different modes.

Prefer recording the chosen shape in optional top-level `schedulerJobs` metadata
inside `~/.repost-with-agent/pairs.json` when the user wants the config visible
there, but treat the host scheduler entry itself as the source of truth for when
jobs actually fire.

## Pre-flight checklist

The matching skill (`skills/repost-listen-for-future-setup/SKILL.md`) verifies
against the requested job shape.

For **live publish jobs**:

- [ ] At least one pair in scope has `enabled === true`.
- [ ] At least one pair in scope has `mode === "live-approved"`.
- [ ] At least one pair in scope has `runMode === "listen-for-future"`.
- [ ] User is logged into source + destination platforms needed by scoped live-approved pairs in the current harness browser profile.
- [ ] Preview/publish validation has succeeded for each publish-capable destination family being scheduled (`audit.jsonl` shows `pair.preview.success` or `pair.publish.success`).
- [ ] `notification.delivery` is configured for the current user-facing channel and the `repost-notify` test landed for publish-capable pairs.

For **dry/preview jobs**:

- [ ] At least one pair in scope has `enabled === true` and `runMode === "listen-for-future"`.
- [ ] The scheduler prompt explicitly says not to publish, even if a pair is `live-approved`.
- [ ] Source/destination login is still checked when the preview flow needs the browser.

**Notification routing rule:** user-visible Repost notifications are not inherently Telegram-specific. Store the route in `~/.repost-with-agent/pairs.json` under `notification.delivery` (for example `channel`, `accountId`, `target`, optional `threadId`) using the current harness/chat metadata during setup. Scheduled runs must read that route and pass it explicitly to the harness message tool; never rely on a default account/bot, and never paste raw JSON/tool output into user-facing messages.

## What gets installed

- **OpenClaw workflows (preferred):** `openclaw cron` jobs that start fresh
  isolated agent turns with messages such as `/repost-run all`,
  `/repost-run <pair-id>`, or a clear natural-language subset/dry-run prompt.
  Use `thinking=medium` by default; escalate only when the user or pair needs
  heavier reasoning.
- **Claude Code / other explicitly chosen harnesses:** equivalent scheduler
  entries for that harness. On macOS this can be a launchd plist; on Linux this
  can be a crontab line. Use this fallback only when the workflow is
  intentionally not OpenClaw-based or the user explicitly asks for it.

Do **not** route an OpenClaw-owned Repost-with-agent workflow through Claude
Code just because `claude` is installed. The scheduler should invoke the same
harness that owns the workflow.

## Examples

Default all-pairs live sweep:

```bash
openclaw cron add \
  --name "repost-with-agent.all.daily" \
  --description "Repost-with-agent scheduled all-enabled-pairs sweep" \
  --agent main \
  --session isolated \
  --message "/repost-run all" \
  --thinking medium \
  --timeout-seconds 21600 \
  --cron "0 10 * * *" \
  --tz "Europe/London"
```

Source backfill fanout cadence:

```bash
openclaw cron add \
  --name "repost-with-agent.linkedin.source-fanout.hourly" \
  --description "Repost-with-agent LinkedIn source-item fanout backfill slot" \
  --agent main \
  --session isolated \
  --message "Use Repost-with-agent. Run one LinkedIn source-item fanout backfill slot: choose the next eligible LinkedIn source item, enumerate all enabled LinkedIn destination pairs, post/skip/block every destination together, write the fanout manifest, and do not select another source item if any destination is partial." \
  --thinking medium \
  --timeout-seconds 21600 \
  --cron "0 * * * *" \
  --tz "Europe/London"
```

Single-pair custom cadence (destination-specific):

```bash
openclaw cron add \
  --name "repost-with-agent.linkedin-to-x.hourly" \
  --description "Repost-with-agent scheduled single-pair sweep" \
  --agent main \
  --session isolated \
  --message "/repost-run linkedin-to-x" \
  --thinking medium \
  --timeout-seconds 21600 \
  --cron "0 * * * *" \
  --tz "Europe/London"
```

Preview-only dry sweep:

```bash
openclaw cron add \
  --name "repost-with-agent.all.preview.daily" \
  --description "Repost-with-agent preview-only scheduled sweep; never publish" \
  --agent main \
  --session isolated \
  --message "Use the repost-with-agent skill. Run a preview-only dry sweep for enabled listen-for-future pairs with /repost-run all. Do not publish, even if a pair is live-approved." \
  --thinking medium \
  --timeout-seconds 21600 \
  --cron "30 9 * * *" \
  --tz "Europe/London"
```

Verify by inspecting the scheduler only:

```bash
openclaw cron show <job-name-or-id>
openclaw cron list
```

Do **not** run a scheduler job as verification unless the user asks; live jobs
may publish.

## Uninstall

To stop a scheduler entry:

- OpenClaw: `openclaw cron show <job-name-or-id>` to confirm the exact job,
  then `openclaw cron rm <job-id>` and verify with `openclaw cron list`.
- launchd fallback: unload the plist and move/delete it.
- crontab fallback: remove the matching `repost-with-agent.<job-id>` line.

## See also

- `skills/repost-listen-for-future-setup/SKILL.md` — full step-by-step.
- `skills/repost-run/SKILL.md` — what each scheduled tick actually does.
- `/pair edit <pair-id>` — adjust pair eligibility/policy/schedule metadata.
