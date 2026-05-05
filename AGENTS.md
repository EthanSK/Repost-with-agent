# AGENTS.md — Repost-with-agent (v4.4.0)

Guidance for any AI agent (Codex, Claude Agent, Claude Code, OpenClaw, Gemini,
Cursor, etc.) operating on this repo. This file mirrors `CLAUDE.md` so a
single read is enough regardless of which agent harness you're driving from.

## v4.4.0 in one paragraph

Repost-with-agent v4 is a **skill-only plugin**. There is no CLI, no MCP
server, no platform SDK. **You** (the running agent) do all the work using
your native toolkit: Read, Edit, Write, Bash, current-harness browser
automation, and configured current-harness user-message delivery. The skills under
`skills/<name>/SKILL.md` are step-by-step procedures you read and execute
directly. The slash commands under `commands/*.md` are thin wrappers that load
the matching skill.

Supported platforms: **LinkedIn, X, Bluesky, Threads, Facebook**. Platform
labels are free-form strings in pair config; you read them and pick the right
URL templates and DOM selectors at runtime via `docs/destinations/<platform>.md`.

## The non-negotiable rule — Telegram-confirm every successful publish

> **Telegram-confirm every successful publish — non-negotiable.** Every
> successful post from this plugin MUST trigger a Telegram message to Ethan
> confirming the source URL and the destination URL. If you trigger a publish
> through any non-skill path you MUST also fire a Telegram confirmation.
> Silent publishes are a bug. (Ethan voice 5977 + 5978, 2026-05-01.)

## Required harness toolkit

Your session must have:

- **Read, Edit, Write, Bash** — built-in.
- **Native browser automation in the current harness** — for example OpenClaw's
  built-in browser, `chrome-devtools-mcp` when the current harness is Claude
  Code, or another explicit browser adapter.
- **User-message delivery in the current harness** — read `notification.delivery`
  from `~/.repost-with-agent/pairs.json` and map it to the harness's configured
  message tool. Used for the publish-confirmation pings.

If any is missing, the relevant skill surfaces the missing dependency and
stops. There's no fallback. Do **not** hand a Repost-with-agent run to Claude
Code merely because Claude Code is listed as a supported harness; the current
agent owns the run unless Ethan explicitly asks for a different harness.

## State files

| Path | Purpose |
| --- | --- |
| `~/.repost-with-agent/pairs.json` | Array of pair configs (schemaVersion 4) |
| `~/.repost-with-agent/pairs/<id>/posted.jsonl` | Append-only NDJSON history |
| `~/.repost-with-agent/pairs/<id>/audit.jsonl` | Append-only NDJSON audit |
| `~/.repost-with-agent/pairs/<id>/learnings.md` | Per-pair institutional memory (free-form prose + optional `### Selectors` / `### Step playbook` / `### Quirks` sub-sections; try cached selectors FIRST, fall back to `docs/destinations/<platform>.md`) |
| `~/.repost-with-agent/pairs/<id>/backfill-state.json` | Transient backfill resume |
| `~/.repost-with-agent/pairs/<id>/logs/cron.log` | Fallback launchd/crontab tick logs when that scheduler path is used |

Append-only files: NEVER rewrite existing lines. Use `>>` in Bash.

## Skills

| Skill | Use when |
| --- | --- |
| `repost-pair-setup` | User wants to create / edit a pair |
| `repost-pair-list` | User wants a list of all pairs |
| `repost-pair-show` | User wants full details + history for one pair |
| `repost-run` | User runs a single pair end-to-end (single post) |
| `repost-backfill` | User wants a multi-post historical walk |
| `repost-listen-for-future-setup` | User wants to install scheduler |
| `repost-history` | User wants to tail posted.jsonl |
| `repost-dedup` | Reference for Layer 1 fuzzy-match algorithm (exact + string match) |
| `repost-dedup-semantic` | Reference for Layer 2 semantic-similarity check (agent reasoning over candidate vs. recent destination posts; default 30-post window) |
| `repost-url-expand` | Reference for shortener resolution |
| `repost-notify` | The Telegram-confirm payload + non-negotiable rule |
| `repost-learnings` | Per-pair institutional-memory file lifecycle (read at start of every run, appended at the end) |

## Slash commands

- `/pair list|show|create|edit`
- `/repost-run <pair-id|all>`
- `/repost-backfill <pair-id> [--max --interval --allow-publish --resume]`
- `/repost-setup-cron <pair-id>`

## Pre-flight before flipping a pair to live

1. `pair.enabled === true`
2. `pair.mode === "live-approved"` (or `"approval-required"`)
3. `pair.runMode === "listen-for-future"` (for scheduled ticks) or `"backfill"` (one-shot)
4. User logged into source + destination platforms in current harness browser profile
5. At least one preview run has succeeded (audit shows `pair.publish.success` or `pair.preview.success`)
6. Telegram is configured (run `repost-notify` test once)

## What to do on a `pair.publish.notify_skipped_unconfigured` audit event

1. Tell Ethan via Telegram (so the missed ping is replaced).
2. Verify `notification.delivery` is configured and the current harness message-delivery tool is installed + enabled.
3. Re-run the affected publish flow once Telegram is wired up.

## Other project rules in one paragraph

- New pairs default to `mode: "preview-only"` + `enabled: false` — intentional.
- Live publishes need `mode: "live-approved"` (scheduled ticks) or explicit per-post
  authorization (`mode: "approval-required"`).
- **Global + two-layer dedupe — everything must clear.** First run
  `repost-global-dedupe`: read `~/.repost-with-agent/global-posted.jsonl`,
  resolve/inherit the cross-pair `contentKey`, and skip if any pair has already
  got that content to this destination platform/account. Then run Layer 1
  (`repost-dedup`: local exact + remote fuzzy string match) and Layer 2
  (`repost-dedup-semantic`, v4.3.0+: agent semantic judgment over the
  candidate vs. the destination's recent posts). Lean conservative: when on the
  fence, skip — Ethan would rather miss a post than ship an embarrassing
  duplicate. Global dedupe and Layer 2 are enabled by default; opt out only via
  explicit per-pair policy fields.
- No stealth, no CAPTCHA / 2FA bypass, no hidden posting.
- You CANNOT log in for the user. `category: "needs-login"` on session expiry.
- `posted.jsonl` / `audit.jsonl` / `global-posted.jsonl` are append-only.

## See also

- `INSTRUCTIONS.md`, `README.md`, `CLAUDE.md`
- `docs/architecture.md`, `docs/state-files.md`, `docs/migration-v3-to-v4.md`
- `docs/url-expander.md`, `docs/destinations/<platform>.md`
- `skills/<name>/SKILL.md` for each skill body


**Notification routing rule:** user-visible Repost notifications are not inherently Telegram-specific. Store the route in `~/.repost-with-agent/pairs.json` under `notification.delivery` (for example `channel`, `accountId`, `target`, optional `threadId`) using the current harness/chat metadata during setup. Scheduled runs must read that route and pass it explicitly to the harness message tool; never rely on a default account/bot, and never paste raw JSON/tool output into user-facing messages.
