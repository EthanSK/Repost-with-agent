# INSTRUCTIONS for the running agent (Claude Code, OpenClaw, etc.)

You are operating in a session that has Repost-with-agent v4 installed. This
file tells you the project's intent + the load-bearing invariants. Read it
before you touch state, run a publish, or hand off to a scheduled tick.

## v4 architecture in one paragraph

Repost-with-agent v4 is **instructions + JSON state**, with no posting
framework on disk. There is no CLI, no MCP server, no platform SDK. **You**
(the running agent) do all the work using your native toolkit: Read, Edit,
Write, Bash, your browser MCP (chrome-devtools-mcp / OpenClaw built-in /
claude-in-chrome), and `plugin:telegram:telegram`. The skills under
`skills/<name>/SKILL.md` are step-by-step procedures you execute directly. The
slash commands under `commands/*.md` are thin wrappers that load the matching
skill.

The agent maintains a per-pair `learnings.md` so it doesn't re-figure quirks
every run — pagination caps, DOM changes, rate-limit signatures, and
account-specific gotchas accumulate across cron ticks instead of being
rediscovered from scratch each time. v4.2.0 adds a structured entry shape:
each entry can include optional `### Selectors`, `### Step playbook`, and
`### Quirks` sub-sections so the next run can grep + skim for actionable
mechanics instead of re-reading prose. **Read learnings.md FIRST; fall
back to `docs/destinations/<platform>.md` only when learnings.md is silent
or a cached selector misses.** Read `skills/repost-learnings/SKILL.md` for
the full lifecycle + good/bad-entry guidance.

## The non-negotiable rule

> **Telegram-confirm every successful publish — non-negotiable.** Every
> successful post from this plugin MUST trigger a Telegram message to Ethan
> confirming the source and destination URL. The plugin enforces this in the
> `repost-notify` skill (and in the publish flow steps of `repost-run` and
> `repost-backfill`). If you trigger a publish through any non-skill path
> (manual one-off via the browser MCP outside the skill flow, etc.), you MUST
> also fire a Telegram confirmation. Silent publishes are a bug. (Ethan voice
> 5977 + 5978, 2026-05-01.)

## Where things live

- **Pair configs**: `~/.repost-with-agent/pairs.json` (schemaVersion 4).
- **Per-pair history**: `~/.repost-with-agent/pairs/<id>/posted.jsonl` (NDJSON, append-only).
- **Per-pair audit**: `~/.repost-with-agent/pairs/<id>/audit.jsonl` (NDJSON, append-only).
- **Per-pair learnings**: `~/.repost-with-agent/pairs/<id>/learnings.md` (free-form Markdown prose + optional `### Selectors` / `### Step playbook` / `### Quirks` sub-sections per entry).
- **Backfill resume state**: `~/.repost-with-agent/pairs/<id>/backfill-state.json` (transient).
- **Cron / launchd logs**: `~/.repost-with-agent/pairs/<id>/logs/cron.log`.
- **Skill bodies**: `skills/<name>/SKILL.md`.
- **Slash command wrappers**: `commands/*.md`.
- **Per-platform DOM hints**: `docs/destinations/<platform>.md`.
- **State-file schemas**: `docs/state-files.md`.

## Project rules

1. **Telegram-confirm every successful publish.** Non-negotiable. See above.
2. **New pairs default to `mode: "preview-only"` and `enabled: false`.** Don't
   flip without explicit, current-conversation user authorization.
3. **Live publishes need either `mode: "live-approved"` (for cron-driven ticks)
   or explicit per-post authorization.** `preview-only` always refuses to
   publish.
4. **Dedupe runs in two layers, both must clear.**
   - **Layer 1** (`skills/repost-dedup/SKILL.md`) — local exact match
     against `posted.jsonl` plus remote fuzzy-string match against the
     destination feed. Cheap, catches verbatim re-posts.
   - **Layer 2** (`skills/repost-dedup-semantic/SKILL.md`) — agent
     reasons over the candidate draft and the destination's most recent
     30 posts (override per-pair via `policy.semanticDedupeWindowSize`)
     to catch paraphrased duplicates ("same announcement, different
     words"). Lean conservative — when on the fence, skip. (Ethan voice
     6106, 2026-05-01: *"that'll be embarrassing."*) Enabled by default,
     opt out per-pair via `policy.semanticDedupeEnabled: false`.
   - Uncertain matches are skipped unless
     `policy.blockOnUncertainDuplicate` is `false`.
5. **No stealth, no CAPTCHA bypass, no 2FA bypass.** Browser automation only
   operates on user-controlled, transparent login sessions.
6. **You CANNOT log in for the user.** If a session is expired, append
   `pair.publish.failed` audit with `category: "needs-login"` and stop.
7. **Append, don't rewrite.** `posted.jsonl` and `audit.jsonl` are append-only.
   Use `>>` in Bash.
8. **Use the browser MCP, not Playwright.** The plugin has zero Playwright /
   API-SDK dependencies. The browser MCP your harness provides is the only
   browser path.

## Failure categories

When a step fails, append `pair.publish.failed` (or the matching `pair.fetch.failed`,
`pair.dedupe.uncertain`, etc.) to `audit.jsonl` with one of these categories:

- `needs-login` — destination or source session expired.
- `needs-config` — Telegram unconfigured, pair missing required field, etc.
- `rate-limit` — destination rejected with 429 / rate-limit modal.
- `platform-error` — other destination platform error.
- `unknown` — anything else.

## Audit-event taxonomy

See `docs/state-files.md` for the full table. Key events:

- `pair.publish.success` — destination confirmed the post.
- `pair.publish.notify.success` — Telegram-confirm delivered.
- `pair.publish.notify.failure` — Telegram-confirm failed (post still up).
- `pair.publish.notify_skipped_unconfigured` — silent publish. **Treat as a
  project bug.** Tell the user immediately.
- `pair.publish.url_expanded` — one URL was successfully expanded.
- `pair.publish.semantic_duplicate` — Layer 2 semantic dedupe match. Candidate skipped pre-publish; includes `candidateExcerpt`, `matchedExistingUrl`, `matchedExistingExcerpt`, `agentReasoning`, `windowSize`.
- `pair.dedupe.uncertain` — destination scrape failed; treat candidates conservatively.

## Cross-machine context

If you're a Claude Code session running on Ethan's MacBook Pro, and Ethan
asks you to mirror state with the Mac Mini's session, use `bridge_send_message`
to delegate (the Mac Mini's session has GUI keychain access and HTTPS git
auth that you don't have over SSH). Don't use `agent-bridge run` — it's a
plain shell utility, not an agent invocation.

## Where to start

If the user just installed the plugin and runs `/pair list`:

1. Read `~/.repost-with-agent/pairs.json`.
2. If empty, tell them to run `/pair create` first.
3. Otherwise, summarize each pair (see `skills/repost-pair-list/SKILL.md`).

If the user runs `/repost-run <id>`:

1. Read `skills/repost-run/SKILL.md` and follow it step by step.
2. Step 1.5 — read `~/.repost-with-agent/pairs/<id>/learnings.md` for prior
   quirks before scraping. Try the most-recent entry's `### Selectors` and
   `### Step playbook` sub-sections verbatim FIRST; fall back to
   `docs/destinations/<platform>.md` only when learnings.md is silent.
3. Telegram-confirm at the end. Non-negotiable.
4. Final step — append any newly-discovered quirks to `learnings.md` using
   the structured shape (prose + optional `### Selectors` / `### Step
   playbook` / `### Quirks`).

If the cron job spawned you fresh with `/repost-run all`:

1. Read `~/.repost-with-agent/pairs.json`.
2. For each pair where `enabled === true && mode === "live-approved" && runMode === "listen-for-future"`, run `skills/repost-run/SKILL.md` end-to-end.
3. Sleep 30–60s between pairs to avoid rate-limit thrashing.
4. Exit cleanly.

## See also

- [`README.md`](README.md) — user-facing overview.
- [`docs/architecture.md`](docs/architecture.md) — full architectural rationale.
- [`docs/state-files.md`](docs/state-files.md) — formal state-file schemas.
- [`docs/migration-v3-to-v4.md`](docs/migration-v3-to-v4.md) — second-rewrite changelog.
- [`CLAUDE.md`](CLAUDE.md) — Claude Code-specific guidance (mirrors this file).
- [`AGENTS.md`](AGENTS.md) — multi-harness agent guidance (mirrors this file).
