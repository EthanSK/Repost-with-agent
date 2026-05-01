# AGENTS.md — Repost-with-agent

Guidance for any AI agent (Codex, Claude Agent, Claude Code, OpenClaw, Gemini, Cursor, etc.) operating on this repo. This file mirrors `CLAUDE.md` so a single read is enough regardless of which agent harness you're driving from.

## The non-negotiable rule — Telegram-confirm every successful publish

> **Telegram-confirm every successful publish — non-negotiable.** Every successful post from this tool MUST trigger a Telegram message to Ethan confirming what was posted, the source URL, and the destination URL. The CLI does this automatically via the configured `notify.telegram` channel. If you are an agent operating on this repo and you trigger a publish through any non-CLI path (direct API call, scripted action, etc.) you MUST also fire a Telegram confirmation. Silent publishes are a bug. (Ethan voice 5977 + 5978, 2026-05-01.)

## Code-level wiring (where notify lives)

- `src/core/notify.ts` — `notifyPublishSuccess()`, `sendTelegramMessage()`, `loadNotifyConfig()`, `writeNotifyConfig()`, `buildPublishMessage()`.
- `src/core/orchestrator.ts:publishNextForPair()` — calls `notifyPublishSuccess()` after the destination confirms.
- `src/core/backfill.ts:runBackfill()` — calls `notifyPublishSuccess()` in the publish-success branch.
- `src/core/scheduling.ts:runScheduled()` — re-uses `publishNextForPair()`, no separate wiring.

If you add a new publish path, wire `notifyPublishSuccess()` at the same boundary: AFTER the destination confirms the post AND AFTER `posted.jsonl` / state is written. Never in parallel. Notify failures emit `notify.publish.failure` + `pair.publish.notify_failed` audit events but never roll back the publish.

## CLI

```bash
repost-with-agent notify configure --bot-token <T> --chat-id <C> [--test] [--disable]
repost-with-agent notify status
repost-with-agent notify test
```

Config sources (priority): `~/.repost-with-agent/notify.json` (mode `0600`) → `REPOST_TELEGRAM_BOT_TOKEN` + `REPOST_TELEGRAM_CHAT_ID` env vars → unconfigured (loud `WARN` + audit event on every publish).

## Pre-flight checks before flipping a pair to live

1. `repost-with-agent notify status` returns `source: file` (or `env`).
2. `repost-with-agent notify configure --test` (or `notify test`) lands a real Telegram message.
3. The pair has been previewed at least once (`repost-with-agent pair preview <id>` exits clean).
4. `pair show <id>` shows the intended `mode` (`approval-required` or `live-approved`).

## What to do if you see a `pair.publish.notify_skipped_unconfigured` audit event

1. Tell Ethan via Telegram (so the missed ping is replaced).
2. Run `repost-with-agent notify configure` to wire it up.
3. Note the gap in `CLAUDE.md` for future sessions.

## Other project rules in one paragraph

- New pairs default to `mode: preview-only` and `enabled: false` — intentional.
- Live publish requires `--approve` (or `--allow-publish` for scheduled/backfill) AND a non-`preview-only` mode.
- Dedupe is re-checked at post time; uncertain matches are refused unless `--allow-uncertain`.
- No stealth, no CAPTCHA / 2FA bypass, no hidden posting. Browser automation only with transparent user-controlled login sessions.
- See `docs/safety.md`, `docs/WORKFLOW.md`, `docs/scheduling.md` for the long form.
