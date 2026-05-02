# CLAUDE.md — Repost-with-agent (v3.0.0)

Guidance for any Claude Code / Claude Agent / OpenClaw session operating on this repo. Read this BEFORE you touch state, run a publish, or hand off to a scheduled tick.

## v3.0.0 architecture in one paragraph

Repost-with-agent is **instructions + JSON state**, not a posting framework. The CLI is a thin orchestrator over `~/.repost-with-agent/pairs.json`, per-pair `posted.jsonl`, and an audit log. The **agent** (Claude Code via `chrome-devtools-mcp`, OpenClaw via its built-in browser tool) drives the user's logged-in browser to scrape sources and submit posts. There is **no** API path (no `@atproto/api`, no Threads Graph, no twitter SDK, no facebook-nodejs-business-sdk) and **no** Playwright in `src/`. Platform names (`linkedin`, `x`, `bluesky`, `threads`, `facebook`) are free-form string labels in pair config; the agent reads them and picks the right URL templates and DOM selectors at task-execution time.

(Ethan voice 6016, 2026-05-01: "this whole project is just instructions for an agent.")

## The non-negotiable rule — Telegram-confirm every successful publish

> **Telegram-confirm every successful publish — non-negotiable.** Every successful post from this tool MUST trigger a Telegram message to Ethan confirming what was posted, the source URL, and the destination URL. The CLI does this automatically via the configured `notify.telegram` channel. If you are an agent operating on this repo and you trigger a publish through any non-CLI path (direct API call, scripted action, etc.) you MUST also fire a Telegram confirmation. Silent publishes are a bug. (Ethan voice 5977 + 5978, 2026-05-01.)

This rule has two layers:

1. **Code-level guarantee.** Every code path that publishes to a destination platform must call `notifyPublishSuccess()` from `src/core/notify.ts` AFTER the destination confirms the post and AFTER `posted.jsonl` is appended. The current wired sites are:
   - `publishNextForPair()` in `src/core/orchestrator.ts` — covers `pair post --approve` and `pair scheduled-run --allow-publish`.
   - The publish-success branch in `runBackfill()` in `src/core/backfill.ts` — covers `pair backfill --allow-publish`.

   Any new publish path you add MUST call `notifyPublishSuccess()` in the same place — right after the agent's `post-to-destination-result` returns success and the local `posted.jsonl`/state has been written. Notify failures are recorded as `notify.publish.failure` + `pair.publish.notify_failed` audit events but never roll back the publish (the post is already up).

2. **Doc-level guarantee.** This rule is repeated, verbatim, across `README.md`, `CLAUDE.md`, `AGENTS.md`, `openclaw.plugin.json`, both `skills/*/SKILL.md`, all of `commands/*.md`, and `docs/WORKFLOW.md` + `docs/setup-flow.md`. Defense in depth.

## Agent-task contract — how the CLI talks to you

The orchestrator emits typed JSON tasks; you fulfil them via your browser MCP and write back typed results. Three task kinds, all platform-agnostic:

- `fetch-source` → scrape the user's profile on the source platform → return `fetch-source-result` with an `items` array.
- `post-to-destination` → navigate to the destination's compose page → fill `draft_text` → click submit → return `post-to-destination-result` with `posted_url` + `posted_at`.
- `check-destination` → scrape recent posts on the destination → fuzzy-match against `candidate_text` → return `check-destination-result` with `exists: bool`.

Each task has a `correlation_id`; you must echo it back in the matching result. The CLI writes tasks to `~/.repost-with-agent/agent-tasks/<correlation_id>.task.json` and polls for `<correlation_id>.result.json`. Both files are visible in stdout via banner lines.

Full schema: `src/core/agent-task-contract.ts`. Per-platform DOM hints: `docs/destinations/<platform>.md`.

## What to do before flipping any pair to live

```bash
repost-with-agent notify configure --bot-token <TELEGRAM_BOT_TOKEN> --chat-id <CHAT_ID> --test
```

`--test` sends a verification message immediately. If the test fails, do NOT flip the pair to live.

Verify with:

```bash
repost-with-agent notify status
# Expect `Resolved source: file` (or `env`). NEVER `none`.
```

## Two run-modes

- **`backfill`**: walk back through historical source posts, **newest-first** (Ethan voice 6021). Use `pair backfill <id>`. Default 2 pages, 20 max publishes, 10-minute interval.
- **`listen-for-future`**: continuous tail. Use `pair scheduled-run <id>` invoked by the host scheduler (OpenClaw cron / launchd / system cron). Always preview-only unless `--allow-publish` AND `pair.mode=live-approved`.

Both modes share the same agent-task contract; only the orchestration loop differs.

## URL expander (v3.0.0)

Every URL in a draft body is followed up to 5 hops (5-second timeout per hop) before publish. Shorteners covered: lnkd.in, t.co, bit.ly, buff.ly, goo.gl, tinyurl.com, ow.ly, plus any URL that returns 30x. Failure is fail-soft — original URL kept. Audit event `pair.publish.url_expanded` per substitution.

Helper commands:

```bash
repost-with-agent urls expand <url>
repost-with-agent urls expand-text "<body containing one or more URLs>"
```

See `docs/url-expander.md`.

## Audit events — what to grep for

- `pair.publish.success` — destination confirmed the post.
- `notify.publish.success` — Telegram delivered immediately after.
- `notify.publish.failure` + `pair.publish.notify_failed` — Telegram failed; publish still up. Investigate.
- `pair.publish.notify_skipped_unconfigured` — notify wasn't wired up. **Treat as an alert: the project shipped a silent publish.** Fix immediately.
- `pair.publish.url_expanded` — a shortened URL in the draft was expanded to its final destination before publish.
- `pair.preview.fetch_failed` — agent returned an error result for a `fetch-source` task; preview returned no items.

## Agent-bridge / cross-machine

`scripts/agent-bridge-handler.sh` is read-only / approval-gated. No remote machine can publish on Ethan's behalf — `pair post --approve` and `pair backfill --allow-publish` are local-operator-only. The notify rule applies regardless of which machine the publish runs on.

## Project map (where things live)

- Agent-task contract: `src/core/agent-task-contract.ts` — typed AgentTask / AgentResult union + inbox file helpers.
- Agent-task runner: `src/core/agent-runner.ts` — handler/inbox-poll dispatch.
- URL expander: `src/core/url-expander.ts`.
- Orchestrator publish boundary: `src/core/orchestrator.ts:publishNextForPair()`.
- Backfill publish boundary: `src/core/backfill.ts:runBackfill()`.
- Scheduled-run wrapper: `src/core/scheduling.ts:runScheduled()` — re-uses `publishNextForPair`.
- Notify hook: `src/core/notify.ts:notifyPublishSuccess()`.
- CLI entry: `src/index.ts` — `pair create | list | show | preview | history | post | backfill | scheduled-run | schedule | unschedule | edit`, `notify configure | status | test`, `urls expand | expand-text`.
- Tests: `tests/dedupe-regression.js`, `tests/scheduling-regression.js`, `tests/backfill-regression.js`, `tests/notify-regression.js`, `tests/truncate-regression.js`, `tests/overlength-regression.js`, `tests/url-expander-regression.js`, `tests/agent-task-contract-regression.js`.

## What to do if you find a notify-skipped audit event

1. Tell Ethan directly via Telegram (so the missed ping is replaced).
2. Run `repost-with-agent notify configure` so subsequent publishes are wired up.
3. File the gap in this file (date + audit-event line) so future sessions can see it.

## Project rules in one paragraph

- New pairs default to `mode: preview-only` and `enabled: false`. That's intentional. Don't flip without explicit user authorization.
- Live publish always needs `--approve` (or `--allow-publish` on scheduled / backfill paths) AND a non-`preview-only` mode.
- Dedupe is re-checked at post time. The orchestrator refuses uncertain matches unless `--allow-uncertain` is explicitly set.
- No stealth, no CAPTCHA / 2FA bypass, no hidden posting. Browser automation is only for transparent user-controlled login sessions.
- See `docs/safety.md` for the full safety contract.

## v2 → v3 migration

v2-shaped `pairs.json` is auto-migrated on first read. The original is backed up to `~/.repost-with-agent/pairs.json.v2.bak`; the migration injects `platform` labels into source/destination, sets `runMode: "listen-for-future"`, and stamps `schemaVersion: 3`. The 11 entries in `~/.repost-with-agent/pairs/linkedin-to-x/posted.jsonl` are preserved untouched.

See `docs/migration-v2-to-v3.md` for the full migration walkthrough.
