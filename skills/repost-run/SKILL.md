# Repost Run

Use this skill when the user wants to inspect, preview, review, or live-publish a saved Repost-with-agent pair or queue workspace.

## Preferred actions

- `repost-with-agent pair list`
- `repost-with-agent pair show <id>`
- `repost-with-agent pair preview <id>`
- `repost-with-agent pair history <id>`
- `repost-with-agent pair post <id> --approve` *(approval-gated; only when the user explicitly authorizes the live publish)*
- `repost-with-agent pair scheduled-run <id> [--json]` *(deterministic per-tick entry point; what host schedulers should call. Always preview-only unless `--allow-publish` is passed AND pair mode is `live-approved`. Emits structured `pair.scheduled.*` audit events.)*
- `repost-with-agent pair schedule <id>` / `pair schedule <id> --apply launchd` / `pair unschedule <id>` *(render or install host scheduling artifacts)*
- `repost-with-agent pair edit <id> --schedule-kind cron --schedule-expression "..." --timezone "..."` *(update saved schedule fields)*

## Run behavior

- Load existing pair config from `~/.repost-with-agent/pairs.json`, or queue workspace files (`user-setup.json`, `queue.jsonl`, `state.json`) when a workspace is provided.
- Respect pair mode, `publish_mode`, and run policy.
- Treat preview/manual approval as the safe default.
- Mention learnings/history/logs when relevant because they are loaded every run.

## Live publish rules

- `pair post <id>` requires the explicit `--approve` flag. Without it the orchestrator returns `needs-approval` and writes nothing.
- It also requires the pair to be in `approval-required` or `live-approved` mode — `preview-only` always refuses.
- The orchestrator re-runs preview, re-checks dedupe at post time (race-safe), and refuses if the top candidate is `uncertain` unless `--allow-uncertain` is also passed.
- Never invoke `--approve` on the user's behalf without an explicit, current-conversation green light.

## Telegram-confirm every successful publish — non-negotiable

> Every successful post from this tool MUST trigger a Telegram message to Ethan confirming what was posted, the source URL, and the destination URL. The CLI does this automatically via the configured `notify.telegram` channel. If you are an agent operating on this repo and you trigger a publish through any non-CLI path (direct API call, scripted action, etc.) you MUST also fire a Telegram confirmation. Silent publishes are a bug. (Ethan voice 5977 + 5978, 2026-05-01.)

Pre-flight before any live run:

```bash
repost-with-agent notify status     # MUST report `source: file` or `env`, NEVER `none`
```

If `none`, run `repost-with-agent notify configure --bot-token <T> --chat-id <C> --test` and verify the test message lands before flipping any pair to live.

Audit events to grep for after a publish:

- `pair.publish.success` + `notify.publish.success` → ideal: post landed, ping delivered.
- `pair.publish.success` + `notify.publish.failure` + `pair.publish.notify_failed` → post landed, but Ethan didn't get the ping. Tell him directly via Telegram and investigate the notify error.
- `pair.publish.success` + `pair.publish.notify_skipped_unconfigured` → silent publish. Treat as an alert, fix immediately.

## Scheduled runs

- The host scheduler (OpenClaw cron / launchd / system cron) should invoke `repost-with-agent pair scheduled-run <id>`, not improvise from a natural-language prompt.
- Every tick writes `pair.scheduled.start` + `pair.scheduled.end` audit events. Use them to prove a tick ran and to debug skipped runs.
- See `docs/scheduling.md` for the full outcome taxonomy (`preview-only` / `no-candidate` / `duplicate` / `uncertain-blocked` / `min-delay` / `blocked-mode` / `auth-failed` / `publish-failed` / `published`).
- Default is preview-only. `--allow-publish` is ignored unless `pair.mode === "live-approved"`.
