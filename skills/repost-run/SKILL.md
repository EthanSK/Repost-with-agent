# Repost Run

Use this skill when the user wants to inspect, preview, review, or live-publish a saved Repost-with-agent pair.

## v3.0.0 architecture in one sentence

The CLI is a thin orchestrator over JSON state. The agent (you, via your browser MCP) does the actual reposting work. When the CLI runs, it emits typed `agent-task` JSON; you fulfil each task by driving the browser; you write back a typed `agent-result`; the orchestrator consumes the result.

Supported platforms: **LinkedIn, X, Bluesky, Threads, Facebook**. The `platform` field on a pair config is a free-form string label.

## Preferred actions

- `repost-with-agent pair list`
- `repost-with-agent pair show <id>`
- `repost-with-agent pair preview <id>` — runs a `fetch-source` task; you scrape; CLI shows the draft.
- `repost-with-agent pair history <id>`
- `repost-with-agent pair post <id> --approve` — approval-gated; emits `post-to-destination` task; you post; CLI records.
- `repost-with-agent pair backfill <id> [--allow-publish]` — newest-first walk-back; emits one task per page + per publish.
- `repost-with-agent pair scheduled-run <id> [--allow-publish] [--json]` — deterministic per-tick entry point. Default preview-only.
- `repost-with-agent pair schedule <id>` / `pair schedule <id> --apply launchd` / `pair unschedule <id>` — render or install host scheduling artifacts.
- `repost-with-agent pair edit <id> --schedule-kind cron --schedule-expression "..." --timezone "..." --run-mode listen-for-future` — update saved fields.

## Agent-task workflow

When you run `pair preview` / `pair post` / `pair backfill` / `pair scheduled-run`, the CLI:

1. Loads the pair config from `~/.repost-with-agent/pairs.json`.
2. Builds a typed `AgentTask` with a `correlation_id`.
3. Writes the task to `~/.repost-with-agent/agent-tasks/<correlation_id>.task.json` AND prints a stdout banner like:

   ```
   [agent-task fetch-source] platform=linkedin source_url=https://... max_items=10 correlation_id=...
   [agent-task] task_file=... result_file=...
   [agent-task] waiting up to 300000ms for result...
   ```

4. Polls for the result file.

Your job (as the agent operating this repo):

1. Read the task JSON.
2. Use your browser MCP (chrome-devtools-mcp / claude-in-chrome / OpenClaw built-in browser) to fulfil the task. The user's logged-in browser profile is what the MCP drives.
3. Write the result JSON to `<correlation_id>.result.json` in the same directory. The orchestrator picks it up automatically.

See `skills/repost-pair-setup/SKILL.md` for the full schema of each task kind. Per-platform DOM hints live in `docs/destinations/<platform>.md`.

## Run behavior

- Load existing pair config from `~/.repost-with-agent/pairs.json`.
- Respect pair `mode` and `runMode`.
- Treat preview as the safe default.
- Mention learnings/history/logs when relevant — they're loaded every run.

## Live publish rules

- `pair post <id>` requires the explicit `--approve` flag. Without it the orchestrator returns `needs-approval` and writes nothing.
- It also requires the pair to be in `approval-required` or `live-approved` mode — `preview-only` always refuses.
- The orchestrator re-runs preview, re-checks dedupe at post time (race-safe), and refuses if the top candidate is `uncertain` unless `--allow-uncertain` is also passed.
- Drafts that exceed the destination's character cap are blocked at publish time (default `--overlength-strategy skip`). Pass `--overlength-strategy truncate` to opt in to smart truncation.
- Never invoke `--approve` on the user's behalf without an explicit, current-conversation green light.

## Two run-modes (v3.0.0)

- **`backfill`**: walk back through historical source posts, **newest-first** (Ethan voice 6021). Use `pair backfill <id>`. Default 2 pages, 20 max publishes, 10-minute interval.
- **`listen-for-future`**: continuous tail. Use `pair scheduled-run <id>` invoked by the host scheduler (OpenClaw cron / launchd / system cron). Always preview-only unless `--allow-publish` AND `pair.mode=live-approved`.

Both modes share the same agent-task contract; only the orchestration loop differs.

## URL expansion

Drafts are passed through `expandUrlsInText()` before publish. Shortened URLs (lnkd.in, t.co, bit.ly, buff.ly, goo.gl, tinyurl.com, ow.ly, etc.) are followed up to 5 hops with a 5-second timeout each. Failure is fail-soft: if expansion errors, the original URL is kept and a `pair.publish.url_expanded` audit event is NOT emitted (only successful expansions get logged).

You don't need to do anything special — the CLI handles expansion before handing you `draft_text`.

## Telegram-confirm every successful publish — non-negotiable

> Every successful post from this tool MUST trigger a Telegram message to Ethan confirming what was posted, the source URL, and the destination URL. The CLI does this automatically via the configured `notify.telegram` channel. If you are an agent operating on this repo and you trigger a publish through any non-CLI path you MUST also fire a Telegram confirmation. Silent publishes are a bug. (Ethan voice 5977 + 5978, 2026-05-01.)

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

- The host scheduler should invoke `repost-with-agent pair scheduled-run <id>`, not improvise from a natural-language prompt.
- Every tick writes `pair.scheduled.start` + `pair.scheduled.end` audit events.
- See `docs/scheduling.md` for the full outcome taxonomy.
- Default is preview-only. `--allow-publish` is ignored unless `pair.mode === "live-approved"`.

## Backfill specifics

- Newest-first ordering (v3.0.0).
- Idempotent restart: a `~/.repost-with-agent/pairs/<id>/backfill-state.json` file records every publish in the current run. Killing and restarting picks up where you left off.
- Cross-state dedupe: the orchestrator runs a `check-destination` task BEFORE each publish; if you (the agent) report the post already exists on the destination, the candidate is recorded as `skip-destination` and added to `posted.jsonl` so future runs short-circuit on local dedupe.
- See `docs/WORKFLOW.md` for the full walkthrough.

## URL expander helpers

For diagnostics:

```bash
repost-with-agent urls expand https://lnkd.in/abc        # follow one URL
repost-with-agent urls expand-text "Check out https://lnkd.in/abc and https://bit.ly/xyz"
```
