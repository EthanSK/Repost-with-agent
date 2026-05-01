# CLAUDE.md — Repost-with-agent

Guidance for any Claude Code / Claude Agent / OpenClaw session operating on this repo. Read this BEFORE you touch state, run a publish, or hand off to a scheduled tick.

## The non-negotiable rule — Telegram-confirm every successful publish

> **Telegram-confirm every successful publish — non-negotiable.** Every successful post from this tool MUST trigger a Telegram message to Ethan confirming what was posted, the source URL, and the destination URL. The CLI does this automatically via the configured `notify.telegram` channel. If you are an agent operating on this repo and you trigger a publish through any non-CLI path (direct API call, scripted action, etc.) you MUST also fire a Telegram confirmation. Silent publishes are a bug. (Ethan voice 5977 + 5978, 2026-05-01.)

This rule has two layers:

1. **Code-level guarantee.** Every code path that publishes to a destination platform must call `notifyPublishSuccess()` from `src/core/notify.ts` AFTER the destination confirms the post and AFTER `posted.jsonl` is appended. The current wired sites are:
   - `publishNextForPair()` in `src/core/orchestrator.ts` — covers `pair post --approve` and `pair scheduled-run --allow-publish`.
   - The publish-success branch in `runBackfill()` in `src/core/backfill.ts` — covers `pair backfill --allow-publish`.

   Any new publish path you add (new destination adapter, new orchestrator entry point, new CLI verb that ends in a destination call) MUST call `notifyPublishSuccess()` in the same place — right after the platform confirms and the local `posted.jsonl`/state has been written. Notify failures are recorded as `notify.publish.failure` + `pair.publish.notify_failed` audit events but never roll back the publish (the post is already up).

2. **Doc-level guarantee.** This rule is repeated, verbatim, across `README.md`, `CLAUDE.md`, `AGENTS.md`, `openclaw.plugin.json`, both `skills/*/SKILL.md`, all of `commands/*.md`, and `docs/WORKFLOW.md` + `docs/setup-flow.md`. Defense in depth — if an agent is operating from a single doc file it will still see the rule.

## What to do before flipping any pair to live

Before any pair runs live for the first time:

```bash
repost-with-agent notify configure --bot-token <TELEGRAM_BOT_TOKEN> --chat-id <CHAT_ID> --test
```

`--test` sends a verification message immediately. If the test fails, do NOT flip the pair to live. Resolve the Telegram delivery first.

Verify with:

```bash
repost-with-agent notify status
# Expect `Resolved source: file` (or `env`). NEVER `none`.
```

Config sources (priority order):

1. `~/.repost-with-agent/notify.json` (mode `0600`).
2. Env vars `REPOST_TELEGRAM_BOT_TOKEN` + `REPOST_TELEGRAM_CHAT_ID` (CI / cron fallback).

## Audit events — what to grep for

- `pair.publish.success` — destination confirmed the post.
- `notify.publish.success` — Telegram delivered immediately after.
- `notify.publish.failure` + `pair.publish.notify_failed` — Telegram failed; publish still up but Ethan didn't get the ping. Investigate.
- `pair.publish.notify_skipped_unconfigured` — notify wasn't wired up. **Treat as an alert: the project shipped a silent publish.** Fix immediately.

## What to do if you find a notify-skipped audit event

1. Tell Ethan directly via Telegram (so the missed ping is replaced).
2. Run `repost-with-agent notify configure` so subsequent publishes are wired up.
3. File the gap in this file (date + audit-event line) so future sessions can see it.

## Agent-bridge / cross-machine

`scripts/agent-bridge-handler.sh` is read-only / approval-gated. No remote machine can publish on Ethan's behalf — `pair post --approve` and `pair backfill --allow-publish` are local-operator-only. The notify rule applies regardless of which machine the publish runs on.

## Project map (where things live)

- Notify hook: `src/core/notify.ts` — `notifyPublishSuccess()` is the function every publish path must call.
- Orchestrator publish boundary: `src/core/orchestrator.ts:publishNextForPair()`.
- Backfill publish boundary: `src/core/backfill.ts:runBackfill()` (the success branch around the `appendPostedHistory` for the `published` decision).
- Scheduled-run wrapper: `src/core/scheduling.ts:runScheduled()` — re-uses `publishNextForPair`, no separate notify wiring needed.
- CLI entry: `src/index.ts` — `notify configure | status | test` subcommands.
- Tests: `tests/notify-regression.js`, `tests/dedupe-regression.js`, `tests/scheduling-regression.js`, `tests/backfill-regression.js`.

## The other project rules in one paragraph

- New pairs default to `mode: preview-only` and `enabled: false`. That's intentional. Don't flip without explicit user authorization.
- Live publish always needs `--approve` (or `--allow-publish` on scheduled / backfill paths) AND a non-`preview-only` mode.
- Dedupe is re-checked at post time. The orchestrator refuses uncertain matches unless `--allow-uncertain` is explicitly set.
- No stealth, no CAPTCHA / 2FA bypass, no hidden posting. Browser automation is only for transparent user-controlled login sessions.
- See `docs/safety.md` for the full safety contract.
