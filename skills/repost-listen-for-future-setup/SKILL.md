---
name: repost-listen-for-future-setup
description: Install current-harness scheduler entries for Repost-with-agent. Default is one fresh agent/subagent running /repost-run all across enabled listen-for-future pairs; custom per-pair, subset, dry/preview, and arbitrary cadence jobs are supported when the user asks.
when_to_trigger: User wants to wire up automatic, scheduled, recurring repost sweeps, set up cron, make pairs tail new posts automatically, or invokes /repost-setup-cron.
---

# Repost Listen-for-future Setup

Install scheduler entry/entries that trigger fresh current-harness agents on a
cadence. Repost-with-agent does **not** ship a daemon; scheduling belongs to
the harness or host OS.

## Product stance

Default: one daily all-enabled-pairs sweep. It runs `/repost-run all`, sweeps
matching pairs sequentially, and exits.

That default is not a cage. If the user asks for any other safe configuration,
implement it instead of forcing the all-pairs shape:

- one job per pair;
- one job for a named subset of pairs;
- multiple jobs with different cadences/timezones;
- preview/dry scheduled checks that never publish;
- manual-only pairs with no scheduler;
- custom current-harness scheduled prompts, provided they read
  `~/.repost-with-agent`, use the current harness browser, and obey dedupe +
  publish-confirmation rules.

Keep `pair.schedule` and optional top-level `schedulerJobs` metadata as
human/agent-readable intent. The installed OpenClaw cron / launchd / crontab
entry is the operational source of truth for timing.

**OpenClaw is a first-class path.** If the current workflow is running in
OpenClaw, use OpenClaw's native `openclaw cron` scheduler. Do **not** write a
launchd job that shells out to Claude Code, and do **not** prefer Claude Code
just because `claude` happens to be installed. Claude Code / launchd / system
cron are fallbacks only when the workflow is intentionally based on that
harness or the user explicitly asks for them.

## Required state

Scope first, then validate. The scope can be:

- `all-enabled` — every pair where `enabled === true` and
  `runMode === "listen-for-future"`;
- `pair` — one explicit pair id;
- `subset` — an explicit list of pair ids;
- `custom` — a natural-language scheduler prompt that still names exactly what
  pair(s) or criteria it should run.

For **live publish jobs**:

- At least one in-scope pair MUST have `enabled === true`.
- At least one in-scope pair MUST have `mode === "live-approved"`.
- The job MUST publish only pairs in `mode === "live-approved"`; preview-only
  and approval-required pairs may be inspected but must not publish unattended.
- `notification.delivery` MUST be configured and tested for every pair the job
  may publish (run the `repost-notify` test once before enabling scheduled
  publishes).
- The user MUST already be logged into source + destination platforms needed by
  the in-scope pairs in the current harness browser profile. You cannot log in
  for them.
- At least one preview/publish validation MUST have succeeded for each
  publish-capable destination family being scheduled (`audit.jsonl` contains
  `pair.preview.success` or `pair.publish.success`).

For **dry/preview jobs**:

- At least one in-scope pair MUST have `enabled === true` and
  `runMode === "listen-for-future"`.
- The scheduler prompt MUST explicitly say not to publish, even if a pair is
  `live-approved`.
- Browser login is still required when the preview needs source/destination UI.
- `notification.delivery` is not required for preview-only jobs unless the user
  wants preview summaries delivered externally.

**OpenClaw hard rule:** OpenClaw scheduled ticks MUST use OpenClaw's own
browser/profile (`profile: openclaw`, CDP port `18800`). Do **not** use Ethan's
personal browser, Chrome relay, or `profile="user"` for Repost-with-agent
unless the user explicitly overrides this for a specific run.

## Cadence

Default cadence: daily at the current user-facing timezone's preferred
posting/check time (Europe/London unless configured otherwise).

Custom cadence is allowed. Use the user's requested cron expression/timezone or
`everyHours`/`everyMinutes` equivalent. Conservative cadences are still a good
recommendation because social platforms and source feeds usually do not change
every few minutes, but do not pretend the product only supports one global
cadence.

## OpenClaw scheduler — preferred for OpenClaw workflows

### Default all-enabled sweep

Create one OpenClaw cron job for the default sweep:

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

The scheduled agent sweeps pairs sequentially inside this one turn. This is the
recommended starter architecture, not the only architecture.

### Custom job examples

Single-pair job:

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

Subset job:

```bash
openclaw cron add \
  --name "repost-with-agent.professional.weekdays" \
  --description "Repost-with-agent scheduled subset sweep: linkedin-to-x, linkedin-to-bluesky" \
  --agent main \
  --session isolated \
  --message "Use the repost-with-agent skill. Run only these pairs sequentially: linkedin-to-x, linkedin-to-bluesky. Publish only pairs that are enabled, listen-for-future, and live-approved." \
  --thinking medium \
  --timeout-seconds 21600 \
  --cron "0 9 * * 1-5" \
  --tz "Europe/London"
```

Preview-only job:

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

Do not add a restrictive `--tools` list unless you are certain it includes
browser automation, file tools, Bash, and configured user-message delivery.

### Delivery notes

- `/repost-run` itself MUST confirm every successful publish via
  `repost-notify`; that is the important user-facing ping. The concrete
  channel/account/target MUST come from `notification.delivery` in
  `~/.repost-with-agent/pairs.json` (captured from the current chat/harness
  during setup). Never rely on default delivery accounts, and never send raw
  JSON/tool output in user-facing messages.
- Add scheduler transcript announcements only if the user explicitly wants every
  scheduled tick's final transcript delivered too. Otherwise it is usually
  noise.

### Verification

Verify without triggering a publish:

```bash
openclaw cron show <job-name-or-id>
openclaw cron list
```

Do **not** run `openclaw cron run` as a verification step unless the user asks;
it may publish if the job is live.

## launchd fallback — only for non-OpenClaw / explicitly chosen harnesses

Use this only when the current workflow is intentionally Claude Code-based (or
another shell-invokable harness) and the user has approved that harness choice.

1. Choose and verify the current-harness invocation before writing any scheduler
   file. If you cannot verify it, stop and ask rather than guessing.
2. Write a plist whose label and command match the requested job shape. For a
   per-pair job, use a label like
   `com.ethansk.repost-with-agent.<pair-id>.<cadence>` and run the verified
   harness command with a message such as `/repost-run <pair-id>`. For an
   all/subset job, use a job-id label and a clear message (`/repost-run all` or
   a subset prompt).
3. Load and verify with `launchctl list | grep repost-with-agent`.

Prefer `RunAtLoad=false` so loading the plist does not fire a tick immediately.

## Linux crontab fallback — only for non-OpenClaw / explicitly chosen harnesses

1. Copy the user's crontab to temp files (`crontab -l > /tmp/crontab.cur && cp /tmp/crontab.cur /tmp/crontab.new`).
2. Append exactly one line per requested job if it is not already present. The
   command should call the verified current-harness invocation with `/repost-run
   all`, `/repost-run <pair-id>`, or a clear custom prompt.
3. Install and verify: `crontab /tmp/crontab.new && crontab -l | grep repost-with-agent`.

## Optional schedulerJobs metadata

If the user's `~/.repost-with-agent/pairs.json` includes top-level
`schedulerJobs`, update or append a matching record after installing/removing a
job. If the field is absent, do not block; it is metadata, not runtime state.

Suggested shape:

```json
{
  "id": "all-enabled-daily",
  "enabled": true,
  "scope": "all-enabled",
  "pairIds": [],
  "message": "/repost-run all",
  "publishMode": "live-approved-only",
  "schedule": {
    "kind": "cron",
    "tz": "Europe/London",
    "expression": "0 10 * * *",
    "everyHours": 24
  },
  "host": {
    "kind": "openclaw-cron",
    "jobName": "repost-with-agent.all.daily"
  }
}
```

## Updating cadence later

If the user changes a schedule:

- Inspect the host scheduler first (`openclaw cron show/list`, launchd, or
  crontab). The host scheduler is the operational source of truth.
- Update the host job by editing/recreating it as needed.
- Update `pair.schedule` and/or `schedulerJobs` metadata afterward so future
  agents see the intended shape.

## Uninstall

To stop a scheduler entry:

- OpenClaw: `openclaw cron show <job-name-or-id>` to confirm the exact job,
  then `openclaw cron rm <job-id>` and verify with `openclaw cron list`.
- launchd fallback: unload the plist and move/delete it.
- Linux crontab fallback: do not use interactive `crontab -e` from an agent;
  use temp files and `grep -v` the matching `repost-with-agent.<job-id>` line.

## What scheduled runs do

For the default live sweep, `/repost-run all` runs every enabled,
`live-approved`, `listen-for-future` pair sequentially with a small jittered
delay between pairs.

For custom jobs, run only the requested pair/scope and requested mode. Preview
jobs must never publish. Live jobs must still skip pairs that are disabled,
not `listen-for-future`, or not `live-approved`.

## Telegram-confirm every successful publish — non-negotiable

The scheduled agent runs `repost-run`, which already enforces this rule. Don't
add a separate ping for the scheduler tick itself unless the user asks — that is
usually noise. Just the per-publish ping.

## Scheduled agents read + write learnings.md

Every scheduled tick spawns one fresh, ephemeral current-harness agent that
loads this plugin and runs the requested Repost-with-agent scope. That agent
ALSO follows the learnings-file lifecycle for each pair it sweeps:

- **Step 1.5 of `repost-run`**: the agent reads
  `~/.repost-with-agent/pairs/<id>/learnings.md` before scraping, so it inherits
  every quirk discovered by prior ticks.
- **Final step of `repost-run`**: the agent appends any newly-discovered quirks
  to the same file before exiting.

When you install any scheduler entry, ensure
`~/.repost-with-agent/pairs/<id>/learnings.md` exists for each scoped pair
(create the placeholder stub from `templates/learnings.md.template` if
missing). The scheduled agent will populate it organically from there.

See `skills/repost-learnings/SKILL.md` for the full lifecycle + signal-vs-noise
rules.

## See also

- `skills/repost-run/SKILL.md` — what each scheduled tick actually does.
- `skills/repost-learnings/SKILL.md` — the per-pair institutional-memory file
  scheduled agents read + write.
- `commands/setup-cron.md` — slash command wrapper.
- `docs/state-files.md` — pair config + state schemas.
