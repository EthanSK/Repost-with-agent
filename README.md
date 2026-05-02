# Repost-with-agent (v4.2.0)

A skill-only Claude Code / OpenClaw plugin that drives the running agent
through cross-platform reposting. **No CLI, no MCP server, no platform SDKs,
no Playwright.** The plugin ships zero code that does the work — it ships
instructions (skills) and the agent's existing toolkit (Read, Edit, Write,
Bash, browser MCP, plugin:telegram:telegram) does everything.

Supports LinkedIn, X, Bluesky, Threads, Facebook. Browser automation only
operates on the user's transparent, logged-in sessions — no API keys, no
stealth, no CAPTCHA / 2FA bypass.

## TL;DR

1. Clone this repo.
2. `bash scripts/install.sh` — registers the plugin with Claude Code
   (`~/.claude/settings.json`) and OpenClaw (`~/.openclaw/openclaw.json`).
3. Restart Claude Code (or OpenClaw gateway).
4. In a fresh session: `/pair create` to set up a source → destination pair.
5. `/repost-run <pair-id>` to do a manual end-to-end repost.
6. `/repost-setup-cron <pair-id>` to schedule recurring ticks (default every 5h).

That's it. The agent does everything else.

## Architecture in one sentence

This plugin is a folder of Markdown skills + slash commands; the running agent
reads them and executes the procedure using its native tools. The plugin
itself runs zero code at runtime.

The agent maintains a per-pair `learnings.md` so it doesn't re-figure quirks
every run — pagination caps, DOM changes, rate-limit signatures, and
account-specific gotchas accumulate across cron ticks instead of being
rediscovered from scratch each time. v4.2.0 adds a structured entry shape
(optional `### Selectors`, `### Step playbook`, and `### Quirks`
sub-sections) so each entry doubles as a recipe the next run can follow
verbatim — read learnings.md FIRST, fall back to
`docs/destinations/<platform>.md` only when learnings.md is silent or a
cached selector misses. (See
[`skills/repost-learnings/SKILL.md`](skills/repost-learnings/SKILL.md).)

(See [`docs/architecture.md`](docs/architecture.md) for the long version.)

## Required harness toolkit

The agent in your harness session must have:

- **Read, Edit, Write, Bash** — built-in for both Claude Code and OpenClaw.
- **A browser MCP** — `chrome-devtools-mcp` (Claude Code), the OpenClaw
  built-in browser tool, or `claude-in-chrome`. Used to navigate, scrape,
  fill forms, click buttons.
- **`plugin:telegram:telegram`** — the Telegram channel plugin. Used to send
  the mandatory publish-confirmation pings to Ethan.

If any of those is missing in a session, the relevant skill will surface the
missing dependency and stop. There's no fallback — the plugin trusts the
harness toolkit, it doesn't reimplement it.

## What the running agent does

When you invoke `/repost-run linkedin-to-x`:

1. Slash command resolves to `skills/repost-run/SKILL.md`.
2. Agent reads the skill (Markdown).
3. Agent reads `~/.repost-with-agent/pairs.json` to find the pair.
4. Agent uses the browser MCP to navigate to the LinkedIn profile, scroll to
   load recent posts, scrape text + URLs.
5. Agent reads `~/.repost-with-agent/pairs/linkedin-to-x/posted.jsonl` to
   check local dedupe.
6. Agent navigates to the X profile and scrapes recent posts to check
   destination dedupe (fuzzy match: normalize whitespace, lowercase, strip
   URLs, ≥80-char prefix overlap).
7. Agent picks the newest non-duplicate item.
8. Agent expands shortened URLs (`lnkd.in`, `t.co`, `bit.ly`, etc.) via
   `curl -sIL` in Bash.
9. Agent navigates to `x.com/compose/post`, fills the textarea, clicks Post.
10. Agent reads the resulting URL from the page.
11. Agent appends `{ts, sourceItemId, destinationUrl, ...}` to `posted.jsonl`.
12. Agent uses `plugin:telegram:telegram` to send the publish-confirmation:

    ```
    [Repost-with-agent] ✅ Posted: linkedin-to-x
    Source: https://www.linkedin.com/feed/update/...
    → Destination: https://x.com/REEEthan_YT/status/...
    ```

That's the full v4 flow. No code on disk did any of it.

## Telegram-confirm every successful publish — non-negotiable

> Every successful post from this plugin MUST trigger a Telegram message to
> Ethan confirming the source and destination URL. Silent publishes are a bug.
> (Ethan voice 5977 + 5978, 2026-05-01.)

This rule is enforced in `skills/repost-notify/SKILL.md` and replayed in
`skills/repost-run/SKILL.md` step 10, `skills/repost-backfill/SKILL.md`
step 6, plus every slash command body. Defense in depth.

If you (the running agent) trigger a publish through any non-skill path, you
MUST also fire a Telegram confirmation.

## Slash commands

- `/pair list` — list configured pairs.
- `/pair show <id>` — show full pair details + recent posts + audit.
- `/pair create` — walk through creating a new pair.
- `/pair edit <id>` — edit an existing pair.
- `/repost-run <pair-id>` — run a single pair end-to-end (single post).
- `/repost-run all` — iterate over every enabled live-approved listen-for-future pair.
- `/repost-backfill <pair-id> [--max N --interval M --allow-publish --resume]` — multi-post historical walk, newest-first.
- `/repost-setup-cron <pair-id>` — install launchd plist (macOS) or cron entry (Linux) to tick a listen-for-future pair on a schedule.

## Skills

- `skills/repost-pair-setup/` — create / edit pairs.
- `skills/repost-pair-list/` — list pairs.
- `skills/repost-pair-show/` — inspect one pair.
- `skills/repost-run/` — single-post end-to-end flow.
- `skills/repost-backfill/` — multi-post historical walk.
- `skills/repost-listen-for-future-setup/` — install scheduler.
- `skills/repost-history/` — tail posted.jsonl.
- `skills/repost-dedup/` — fuzzy-match algorithm reference.
- `skills/repost-url-expand/` — shortener resolution.
- `skills/repost-notify/` — Telegram payload spec + non-negotiable rule.
- `skills/repost-learnings/` — per-pair institutional-memory file (read at
  start of every run, appended at the end of every run).

## State files

All state lives at `~/.repost-with-agent/`:

- `pairs.json` — array of pair configs (schemaVersion 4).
- `pairs/<id>/posted.jsonl` — append-only history of successful publishes.
- `pairs/<id>/audit.jsonl` — append-only audit events.
- `pairs/<id>/learnings.md` — per-pair institutional memory. The agent reads
  this at the start of every run and appends new quirks at the end. Quirks
  accumulate across cron ticks so the agent doesn't re-figure pagination
  caps / DOM changes / rate-limit signatures from scratch each time. Each
  entry has free-form prose plus optional structured sub-sections
  (`### Selectors`, `### Step playbook`, `### Quirks`) so the next run
  can follow a recipe verbatim.
- `pairs/<id>/backfill-state.json` — transient resume state for backfills.
- `pairs/<id>/logs/cron.log` — stdout+stderr from the launchd / cron tick.

Full schemas: [`docs/state-files.md`](docs/state-files.md).

## Pair config example

```json
{
  "schemaVersion": 4,
  "pairs": [
    {
      "id": "linkedin-to-x",
      "name": "LinkedIn to X",
      "enabled": true,
      "mode": "live-approved",
      "runMode": "listen-for-future",
      "source": {
        "platform": "linkedin",
        "url": "https://www.linkedin.com/in/<handle>/recent-activity/all/",
        "profileUrl": "https://www.linkedin.com/in/<handle>"
      },
      "destination": {
        "platform": "x",
        "accountHint": "@<handle>",
        "profileUrl": "https://x.com/<handle>"
      },
      "schedule": {
        "kind": "cron",
        "tz": "Europe/London",
        "expression": "0 */5 * * *",
        "everyHours": 5
      },
      "policy": {
        "maxItemsPerRun": 1,
        "minDelayBetweenPostsMinutes": 60,
        "blockOnUncertainDuplicate": true,
        "overlengthStrategy": "skip"
      }
    }
  ]
}
```

## Safety modes

- `mode: "preview-only"` — never publishes. Default for new pairs.
- `mode: "approval-required"` — agent asks per-post before publishing.
- `mode: "live-approved"` — agent publishes without prompting. Required for cron-driven ticks.

New pairs default to `mode: preview-only` + `enabled: false`. That's
intentional. Don't flip without explicit user authorization.

## Run modes

- `runMode: "listen-for-future"` — tail new posts on a schedule. Default.
- `runMode: "backfill"` — one-shot historical walk (newest-first).

## v3 → v4 migration

If you're upgrading from v3, run `bash scripts/install.sh` — it migrates
`pairs.json` from `schemaVersion: 3` to `4` and backs up the v3 file to
`~/.repost-with-agent/pairs.json.v3.bak`. The 11 entries in
`~/.repost-with-agent/pairs/linkedin-to-x/posted.jsonl` survive untouched.

Full migration walkthrough: [`docs/migration-v3-to-v4.md`](docs/migration-v3-to-v4.md).

## Why a second rewrite?

v3.0.0 (shipped 30 minutes earlier) was already a strip-and-rewrite that
removed Playwright + API SDKs. But v3 kept a CLI orchestrator with an
"agent-task contract" — the CLI emitted typed JSON tasks for an external
agent to consume.

Ethan voice 6024 + 6026 (2026-05-01) clarified that even the CLI is
unnecessary: the harness already has all the tools needed; the only thing
missing is the playbook. v4 ships only the playbook.

## Per-platform notes

- [`docs/destinations/linkedin.md`](docs/destinations/linkedin.md)
- [`docs/destinations/x.md`](docs/destinations/x.md)
- [`docs/destinations/bluesky.md`](docs/destinations/bluesky.md)
- [`docs/destinations/threads.md`](docs/destinations/threads.md)
- [`docs/destinations/facebook.md`](docs/destinations/facebook.md)

## Safety contract

- No stealth, no CAPTCHA bypass, no 2FA bypass, no anti-detection guidance.
- Browser automation only operates on the user's transparent, logged-in sessions.
- Refuse to scrape or post on behalf of an account the user is not the operator of.
- New pairs default to preview-only + disabled.
- Live publishes always require either `mode: live-approved` (for cron-driven
  ticks) or explicit per-post user authorization (`mode: approval-required`).
- Dedupe is re-checked between every publish; uncertain matches are skipped
  unless explicitly overridden.

## License

MIT. See [`LICENSE`](LICENSE).
