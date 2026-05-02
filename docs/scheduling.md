# Scheduling

Repost-with-agent does **not** ship its own scheduler daemon. Scheduling is host-driven: the actual tick is fired by OpenClaw cron, system cron, launchd, or any other scheduler that can invoke a CLI on a cadence. Repost-with-agent provides:

1. A deterministic per-tick CLI entry point: `repost-with-agent pair scheduled-run <pair-id>`.
2. A render/install helper for host scheduling artifacts: `repost-with-agent pair schedule <pair-id>`.
3. Structured audit events (`pair.scheduled.start`, `pair.scheduled.end`, `pair.scheduled.error`) so each tick is provable after the fact.

This page is the contract between the host scheduler and Repost-with-agent.

## Per-tick entry point

```bash
repost-with-agent pair scheduled-run <pair-id> [--allow-publish] [--json]
```

What it does on every tick:

1. Loads the pair from `~/.repost-with-agent/pairs.json`.
2. Writes a `pair.scheduled.start` audit event with the pair mode, enabled flag, source URL, and destination target.
3. If `--allow-publish` is set AND `pair.mode === "live-approved"`:
   - Enforces `pair.policy.minDelayBetweenPostsMinutes` against the most recent `pair.publish.success` audit event timestamp. If the window isn't open, returns `outcome: "min-delay"` and stops without calling source/destination.
   - Otherwise calls `publishNextForPair()` with `approve: true` (which still re-runs preview, re-checks dedupe at post time, and refuses on uncertain).
4. Otherwise (the default) runs `previewPair()` once, classifies the top candidate as `new` / `duplicate` / `uncertain`, and returns without publishing.
5. Writes a `pair.scheduled.end` audit event with the structured outcome, reason, candidate count, source/destination, and (if published) the destination id and url.
6. Emits a JSON object on stdout when `--json` is passed (for `--announce`-style host delivery), or a human-readable summary otherwise.
7. Exit code: `0` for `preview-only` / `no-candidate` / `duplicate` / `uncertain-blocked` / `min-delay` / `blocked-mode` / `needs-approval` / `published`. Exit code `2` only for `auth-failed` / `publish-failed`.

### Outcome taxonomy

| Outcome | Meaning |
| --- | --- |
| `preview-only` | Default for ticks without `--allow-publish`. A new candidate exists; preview drafted; nothing posted. |
| `no-candidate` | Source returned zero candidates. |
| `duplicate` | Top candidate matches `posted.jsonl` by `sourceItemId`, `canonicalUrl`, or `contentHash`. Skipped. |
| `uncertain-blocked` | Top candidate matched a normalised summary but no exact ID/URL/hash. Skipped per safety policy. |
| `min-delay` | `pair.policy.minDelayBetweenPostsMinutes` window is still open since the last successful publish. Skipped. |
| `blocked-mode` | `--allow-publish` was set but pair mode isn't `live-approved`. Ran preview only. |
| `needs-approval` | Reserved for future flows where `pair post` returns this status; currently the scheduler refuses to set it. |
| `auth-failed` | Destination adapter test failed (token expired, login lapsed, etc.). Exit code 2. |
| `publish-failed` | Destination publish call returned an error. Exit code 2. |
| `published` | A post was published. `posted.jsonl` was updated and `pair.publish.success` was logged. |

## Wiring up a host scheduler

```bash
repost-with-agent pair schedule <pair-id>          # render artifacts to stdout
repost-with-agent pair schedule <pair-id> --apply launchd
                                                   # write ~/Library/LaunchAgents/<label>.plist
repost-with-agent pair schedule <pair-id> --allow-publish
                                                   # render artifacts that pass --allow-publish
```

`pair schedule` reads `pair.schedule.kind` / `pair.schedule.expression` / `pair.schedule.everyMinutes` / `pair.schedule.tz` from the saved pair and emits four artifacts:

1. **launchd plist** (macOS) — full `<plist>` document with `ProgramArguments`, `WorkingDirectory`, `EnvironmentVariables` (PATH + HOME), `StandardOutPath`, `StandardErrorPath`, and either `StartCalendarInterval` (cron-translatable expressions) or `StartInterval` (every-N-minutes) or no calendar block (manual). `RunAtLoad=false` so loading the plist doesn't fire a tick immediately.
2. **crontab line** — for system cron users; pipes stdout/stderr into a per-pair logfile.
3. **OpenClaw cron command** — `openclaw cron add` invocation that wraps the scheduled-run as an isolated agent session with `--announce` delivery.
4. **Direct shell invocation** — for ad-hoc testing.

Use `--apply launchd` to actually write the plist; `launchctl load ~/Library/LaunchAgents/com.repost-with-agent.<pair-id>.plist` activates it. Use `pair unschedule <pair-id>` to remove the plist (idempotent).

The launchd label is always `com.repost-with-agent.<sanitised-pair-id>`. List currently-loaded plists with:

```bash
launchctl list | grep com.repost-with-agent
```

### Cron expression → launchd translation

Repost-with-agent's translator handles 5-field cron expressions where every field is either `*` or a literal integer. Examples that translate cleanly:

| Cron | launchd `StartCalendarInterval` |
| --- | --- |
| `0 10 * * *` | `Minute=0, Hour=10` (daily at 10:00) |
| `30 9 1 * *` | `Minute=30, Hour=9, Day=1` (1st of each month at 09:30) |
| `0 19 * * 5` | `Minute=0, Hour=19, Weekday=5` (Fridays at 19:00) |

Anything more complex (`*/3`, `1-5`, `0,30`, `MON-FRI`) is **not** translated to launchd — the renderer falls back to an hourly placeholder block with a warning comment. For those, prefer system cron or OpenClaw cron, which support the full cron grammar.

## Schedule field on the pair

The pair record's `schedule` field is **advisory metadata** describing the desired cadence. The CLI does not run a daemon and does not poll. The host scheduler is the source of truth for when ticks fire.

Fields:

```jsonc
{
  "schedule": {
    "kind": "manual" | "cron" | "every",
    "expression": "0 10 * * *",        // when kind=cron
    "everyMinutes": 30,                 // when kind=every
    "tz": "Europe/London",
    "jitterMinutes": 5                  // optional, host-honoured
  }
}
```

Edit a pair's schedule with:

```bash
repost-with-agent pair edit <pair-id> \
  --schedule-kind cron \
  --schedule-expression "0 10 * * *" \
  --timezone "Europe/London"
```

Other `pair edit` fields: `--mode`, `--enable` / `--disable`, `--max-items-per-run`, `--min-delay-minutes`, `--source-url`, `--destination-account`, `--every-minutes`.

## Safety defaults

- Scheduled ticks default to **preview-only**. `--allow-publish` is opt-in.
- `--allow-publish` is ignored unless `pair.mode === "live-approved"`. The scheduler will run preview only and emit `outcome: "blocked-mode"` instead.
- `pair.policy.minDelayBetweenPostsMinutes` is enforced before publishing.
- The orchestrator's normal preview/dedupe/uncertain gates still apply on every tick.
- `pair.policy.maxItemsPerRun` is enforced by the orchestrator (top-N slice).
- Audit events (`pair.scheduled.start`, `pair.scheduled.end`, `pair.scheduled.error`, plus the underlying `pair.preview` / `pair.publish.*`) make every tick provable.

## Observability

Every scheduled tick writes at least two lines to `~/.repost-with-agent/pairs/<pair-id>/audit.jsonl`:

```jsonc
// pair.scheduled.start
{"at":"2026-05-01T21:34:53.543Z","pairId":"linkedin-to-x","event":"pair.scheduled.start","details":{"mode":"live-approved","enabled":true,"allowPublish":false,"sourceUrl":"https://www.linkedin.com/in/ethansk","destinationTarget":"@REEEthan_YT"}}
// pair.scheduled.end
{"at":"2026-05-01T21:35:02.054Z","pairId":"linkedin-to-x","event":"pair.scheduled.end","details":{"outcome":"duplicate","reason":"Matched source item id in pair history.","candidateCount":1,"durationMs":8511,"sourceUrl":"https://www.linkedin.com/in/ethansk","destinationTarget":"@REEEthan_YT"}}
```

When `pair schedule --apply launchd` is used, stdout/stderr also stream to:

```text
~/.repost-with-agent/pairs/<pair-id>/logs/scheduled.out.log
~/.repost-with-agent/pairs/<pair-id>/logs/scheduled.err.log
```

When the crontab line is used, both streams go into:

```text
~/.repost-with-agent/pairs/<pair-id>/logs/scheduled.cron.log
```

Tail live ticks with:

```bash
tail -f ~/.repost-with-agent/pairs/<pair-id>/audit.jsonl
```

## Uninstall

```bash
repost-with-agent pair unschedule <pair-id>            # remove launchd plist
./scripts/install-for-openclaw.sh uninstall            # remove ALL repost-with-agent plists
                                                       # (data dir kept intact)
```

OpenClaw cron jobs need explicit removal:

```bash
openclaw cron list | grep 'repost-with-agent'
openclaw cron rm <job-id>
```

## OpenClaw cron — recommended flow

1. Create the pair: `npx repost-with-agent pair create ...`
2. Edit its schedule: `npx repost-with-agent pair edit <id> --schedule-kind cron --schedule-expression "0 10 * * 1-5" --timezone Europe/London`
3. Render the OpenClaw cron command: `npx repost-with-agent pair schedule <id>`
4. Copy/paste the printed `openclaw cron add ...` block, or pipe it through `bash` if you trust the shell-quoting.
5. Verify: `openclaw cron list | grep repost-with-agent`
6. Force a single run for testing: `openclaw cron run <job-id>`

The scheduled message tells the agent to call `repost-with-agent pair scheduled-run <id>` directly (no improvisation). The agent reads the JSON stdout, summarises the outcome to `--announce`, and reports any blockers.

## Backfill mode (cross-link)

Per-tick `scheduled-run` only ever considers the *latest* candidate for a pair (`maxItemsPerRun: 1` by default). To walk back through history and publish anything that's missing, use `pair backfill` instead — see [WORKFLOW.md → Backfill](WORKFLOW.md#backfill-mode-walk-back-through-history). Backfill performs cross-state dedupe (local `posted.jsonl` AND destination lookup), paginates the source, and stages publishes at a configurable interval. It is a one-shot foreground process, not a scheduled tick.

`pair backfill` also accepts `--overlength-strategy {skip|truncate}` (default `skip`): drafts that exceed the destination's `maxLength` (X = 280 chars) are either dropped at plan time (with a `pair.backfill.skipped_overlength` audit event) or smart-shortened at sentence/word boundary + ellipsis (with `pair.backfill.truncated` + `truncated: true` on the resulting `pair.backfill.publish.end`).

## Why a deterministic CLI command instead of natural-language scheduled prompts?

Natural-language scheduled prompts ("preview the linkedin-to-x pair, then..." ) work but they're non-deterministic, hard to audit, and easy to drift. Wiring `scheduled-run` as the host scheduler's invocation:

- Always emits the same `pair.scheduled.start` / `pair.scheduled.end` audit events.
- Always uses `pair.policy.minDelayBetweenPostsMinutes` and `pair.policy.maxItemsPerRun`.
- Returns a structured JSON outcome the host can announce, alert on, or aggregate.
- Cannot accidentally skip the dedupe re-check or the uncertain block.
- Doesn't depend on a particular agent prompt to behave correctly.

The scheduled NL prompt becomes a thin wrapper: "run this command, summarise the result, announce."
