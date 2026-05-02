# AGENTS.md — Repost-with-agent (v3.0.0)

Guidance for any AI agent (Codex, Claude Agent, Claude Code, OpenClaw, Gemini, Cursor, etc.) operating on this repo. This file mirrors `CLAUDE.md` so a single read is enough regardless of which agent harness you're driving from.

## v3.0.0 in one paragraph

Repost-with-agent is **instructions + JSON state**, not a posting framework. The CLI is a thin orchestrator. The **agent** (you) drives the user's logged-in browser via your browser MCP (`chrome-devtools-mcp`, `claude-in-chrome`, OpenClaw's built-in browser tool) to scrape sources and submit posts. There is **no** API path and **no** Playwright in `src/`. Platform labels (`linkedin`, `x`, `bluesky`, `threads`, `facebook`) are free-form strings; you read the label from the agent-task and pick the right URL templates and DOM selectors.

## The non-negotiable rule — Telegram-confirm every successful publish

> **Telegram-confirm every successful publish — non-negotiable.** Every successful post from this tool MUST trigger a Telegram message to Ethan confirming what was posted, the source URL, and the destination URL. The CLI does this automatically via the configured `notify.telegram` channel. If you trigger a publish through any non-CLI path you MUST also fire a Telegram confirmation. Silent publishes are a bug. (Ethan voice 5977 + 5978, 2026-05-01.)

## Code-level wiring (where notify lives)

- `src/core/notify.ts` — `notifyPublishSuccess()`, `sendTelegramMessage()`, `loadNotifyConfig()`, `writeNotifyConfig()`, `buildPublishMessage()`.
- `src/core/orchestrator.ts:publishNextForPair()` — calls `notifyPublishSuccess()` after the destination confirms.
- `src/core/backfill.ts:runBackfill()` — calls `notifyPublishSuccess()` in the publish-success branch.
- `src/core/scheduling.ts:runScheduled()` — re-uses `publishNextForPair()`, no separate wiring.

If you add a new publish path, wire `notifyPublishSuccess()` at the same boundary: AFTER the agent's `post-to-destination-result` returns success AND AFTER `posted.jsonl` / state is written. Never in parallel.

## Agent-task contract — the v3 boundary

The CLI hands you typed `AgentTask` JSON; you fulfil via your browser MCP and write back typed `AgentResult` JSON. Three task kinds:

| Kind | Purpose | Result kind |
| --- | --- | --- |
| `fetch-source` | Scrape source profile | `fetch-source-result` |
| `post-to-destination` | Submit a draft to the destination | `post-to-destination-result` |
| `check-destination` | Cross-state dedupe | `check-destination-result` |

Each task has a `correlation_id`. Echo it back in your result. The CLI writes tasks to `~/.repost-with-agent/agent-tasks/<correlation_id>.task.json` and polls for the matching `<correlation_id>.result.json`. Both files are surfaced via stdout banner lines.

Errors: write an `{"kind": "error-result", "correlation_id": ..., "error": "...", "category": "needs-login|needs-config|rate-limit|platform-error|unknown"}`.

Full schema: `src/core/agent-task-contract.ts`. Step-by-step instructions per task kind: `skills/repost-pair-setup/SKILL.md` + `skills/repost-run/SKILL.md`. Platform-specific DOM hints: `docs/destinations/<platform>.md`.

## CLI

```bash
repost-with-agent pair create --source-platform <p> --destination-platform <p> ...
repost-with-agent pair list
repost-with-agent pair show <id>
repost-with-agent pair preview <id>
repost-with-agent pair history <id>
repost-with-agent pair post <id> --approve [--overlength-strategy truncate]
repost-with-agent pair backfill <id> [--allow-publish] [--overlength-strategy {skip|truncate}]
repost-with-agent pair scheduled-run <id> [--allow-publish] [--json]
repost-with-agent pair schedule <id> [--apply launchd] [--allow-publish]
repost-with-agent pair unschedule <id>
repost-with-agent pair edit <id> --mode ... --run-mode ... --schedule-kind ...
repost-with-agent notify configure --bot-token <T> --chat-id <C> [--test] [--disable]
repost-with-agent notify status
repost-with-agent notify test
repost-with-agent urls expand <url>
repost-with-agent urls expand-text "<body>"
```

Notify config sources (priority): `~/.repost-with-agent/notify.json` (mode `0600`) → `REPOST_TELEGRAM_BOT_TOKEN` + `REPOST_TELEGRAM_CHAT_ID` env vars → unconfigured (loud `WARN` + audit event on every publish).

## Pre-flight checks before flipping a pair to live

1. `repost-with-agent notify status` returns `source: file` (or `env`).
2. `repost-with-agent notify configure --test` (or `notify test`) lands a real Telegram message.
3. The pair has been previewed at least once (`repost-with-agent pair preview <id>` exits clean).
4. `pair show <id>` shows the intended `mode` (`approval-required` or `live-approved`) and `runMode`.
5. The user is logged into both source AND destination platforms in the agent's persistent browser profile.

## What to do if you see a `pair.publish.notify_skipped_unconfigured` audit event

1. Tell Ethan via Telegram (so the missed ping is replaced).
2. Run `repost-with-agent notify configure` to wire it up.
3. Note the gap in `CLAUDE.md` for future sessions.

## Other project rules in one paragraph

- New pairs default to `mode: preview-only` and `enabled: false` — intentional.
- Live publish requires `--approve` (or `--allow-publish` for scheduled/backfill) AND a non-`preview-only` mode.
- Dedupe is re-checked at post time; uncertain matches are refused unless `--allow-uncertain`.
- No stealth, no CAPTCHA / 2FA bypass, no hidden posting. Browser automation only with transparent user-controlled login sessions.
- See `docs/safety.md`, `docs/WORKFLOW.md`, `docs/scheduling.md`, `docs/architecture.md`, `docs/url-expander.md` for the long form.
