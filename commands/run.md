---
description: Run a Repost-with-agent pair end-to-end (scrape + dedupe + URL expand + publish + Telegram-confirm). Skill-driven; no CLI.
---

# `/repost-run`

Run a Repost-with-agent pair end-to-end: scrape the source, dedupe against
local history + destination feed, expand shortened URLs, publish via the
user's logged-in browser, append history, and Telegram-confirm Ethan.

## Usage

- `/repost-run <pair-id>` — run that one pair.
- `/repost-run all` — iterate over every enabled `live-approved` `listen-for-future` pair (this is what the cron / launchd subagent invokes).

## What it does

Dispatches to `skills/repost-run/SKILL.md`. The running agent uses its native
tools (Read, Edit, Write, Bash, browser MCP, plugin:telegram:telegram) to:

1. Load the pair config from `~/.repost-with-agent/pairs.json`.
2. Refuse if `pair.enabled === false` or `pair.mode === "preview-only"` (unless explicitly previewing).
3. Use the browser MCP to navigate to the source profile and scrape recent posts.
4. Run dedupe (local: `posted.jsonl`; remote: scrape destination profile).
5. Pick the newest non-duplicate item.
6. Expand shortened URLs in the draft body (`lnkd.in`, `t.co`, `bit.ly`, ...).
7. Drive the destination compose flow via the browser MCP.
8. Append to `~/.repost-with-agent/pairs/<id>/posted.jsonl`.
9. Telegram-confirm Ethan via `plugin:telegram:telegram`.

## Mode rules

- `preview-only`: scrape + dedupe + show draft only. Never publishes.
- `approval-required`: scrape + dedupe + ask user per-post. Publishes only on user's "yes".
- `live-approved`: end-to-end without prompting. Required for cron-driven ticks.

## Telegram-confirm every successful publish — non-negotiable

> Every successful post from this plugin MUST trigger a Telegram message to
> Ethan confirming the source and destination URL. Silent publishes are a bug.
> (Ethan voice 5977 + 5978, 2026-05-01.)

`skills/repost-run/SKILL.md` step 10 enforces this. Don't bypass.

## See also

- `skills/repost-run/SKILL.md` — full step-by-step the agent follows.
- `/repost-backfill` — multi-post version.
- `/pair show <id>` — inspect a pair before running.
