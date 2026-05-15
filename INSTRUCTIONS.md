# INSTRUCTIONS for the running agent (Claude Code, OpenClaw, etc.)

You are operating in a session that has Repost-with-agent v4 installed. This
file tells you the project's intent + the load-bearing invariants. Read it
before you touch state, run a publish, or hand off to a scheduled tick.

## v4 architecture in one paragraph

Repost-with-agent v4 is **instructions + JSON state**, with no posting
framework on disk. There is no CLI, no MCP server, no platform SDK. **You**
(the running agent) do all the work using your native toolkit: Read, Edit,
Write, Bash, your current harness's browser automation (OpenClaw built-in
browser, `chrome-devtools-mcp` when the current harness is Claude Code, or
another explicit browser adapter), and the current harness's Telegram/message
delivery tool (OpenClaw `message` tool / Telegram channel, Claude Code
`plugin:telegram:telegram`, or equivalent). The skills under
`skills/<name>/SKILL.md` are step-by-step procedures you execute directly. The
slash commands under `commands/*.md` are thin wrappers that load the matching
skill. For OpenClaw, Repost-with-agent MUST use OpenClaw's own browser/profile
(`profile: openclaw`, CDP port `18800`) — not Ethan's personal browser/profile,
Chrome relay, or `profile="user"`, unless Ethan explicitly overrides this for a
specific run.

The agent maintains a per-pair `learnings.md` so it doesn't re-figure quirks
every run — pagination caps, DOM changes, rate-limit signatures, and
account-specific gotchas accumulate across scheduled ticks instead of being
rediscovered from scratch each time. v4.2.0 adds a structured entry shape:
each entry can include optional `### Selectors`, `### Step playbook`, and
`### Quirks` sub-sections so the next run can grep + skim for actionable
mechanics instead of re-reading prose. **Read learnings.md FIRST; fall
back to `docs/destinations/<platform>.md` only when learnings.md is silent
or a cached selector misses.** Read `skills/repost-learnings/SKILL.md` for
the full lifecycle + good/bad-entry guidance.

## The non-negotiable rule

> **Confirm every successful publish — non-negotiable.** Every
> successful post from this plugin MUST trigger a Telegram message to Ethan
> confirming the source URL and destination post URL. The plugin enforces this in the
> `repost-notify` skill (and in the publish flow steps of `repost-run` and
> `repost-backfill`). If you trigger a publish through any non-skill path
> (manual one-off via current-harness browser automation outside the skill flow, etc.), you MUST
> also fire a publish confirmation. Silent publishes are a bug. (Ethan voice
> 5977 + 5978, 2026-05-01.)

> **Never reword Ethan's posts — non-negotiable.** Public destination post text
> must preserve the original source post wording exactly. Do not summarize,
> compact, paraphrase, improve, sanitize, normalize tone, fix grammar, or remove
> phrasing because it seems awkward, harsh, redundant, off-brand, or inefficient.
> The wording may be intentional and nuanced. Allowed public-text changes are
> limited to removing source-platform UI artifacts outside the real post body
> (for example reaction counts or `...more`) and replacing forbidden
> source-platform wrapper links (`lnkd.in`, LinkedIn activity URLs, source
> permalinks) with their verified non-source target. If exact text will not fit
> a destination, block/skip that destination and tell Ethan; do not publish a
> rewritten version. (Ethan voice, 2026-05-15.)


**Notification routing rule:** user-visible Repost notifications are not inherently Telegram-specific. Store the route in `~/.repost-with-agent/pairs.json` under `notification.delivery` (for example `channel`, `accountId`, `target`, optional `threadId`) using the current harness/chat metadata during setup. Scheduled runs must read that route and pass it explicitly to the harness message tool; never rely on a default account/bot, and never paste raw JSON/tool output into user-facing messages.

## Where things live

- **Pair configs**: `~/.repost-with-agent/pairs.json` (schemaVersion 4), including optional `customRules`.
- **Global cross-pair ledger**: `~/.repost-with-agent/global-posted.jsonl` (NDJSON, append-only).
- **Custom-rule considered state**: `~/.repost-with-agent/considered.jsonl` (NDJSON, append-only).
- **Per-pair history**: `~/.repost-with-agent/pairs/<id>/posted.jsonl` (NDJSON, append-only).
- **Per-pair audit**: `~/.repost-with-agent/pairs/<id>/audit.jsonl` (NDJSON, append-only).
- **Per-pair learnings**: `~/.repost-with-agent/pairs/<id>/learnings.md` (free-form Markdown prose + optional `### Selectors` / `### Step playbook` / `### Quirks` sub-sections per entry).
- **Destination-specific backfill resume state**: `~/.repost-with-agent/pairs/<id>/backfill-state.json` (transient).
- **Source fanout manifests**: `~/.repost-with-agent/source-fanouts/<source-platform>/<safe-source-item-id>.json` (one source item across enabled destinations).
- **Scheduler logs**: `~/.repost-with-agent/pairs/<id>/logs/cron.log` is only for fallback launchd/crontab paths; OpenClaw cron keeps job/run state in OpenClaw.
- **Skill bodies**: `skills/<name>/SKILL.md`.
- **Slash command wrappers**: `commands/*.md`.
- **Per-platform DOM hints**: `docs/destinations/<platform>.md`.
- **State-file schemas**: `docs/state-files.md`.

## Project rules

1. **Confirm every successful publish.** Non-negotiable. See above.
2. **New pairs default to `mode: "preview-only"` and `enabled: false`.** Don't
   flip without explicit, current-conversation user authorization.
3. **Source-level backfill slots are source-item fanouts.** For a source such as LinkedIn, a scheduled/backfill slot selects one source item and fans it out to every enabled destination pair for that source. It writes/updates a fanout manifest and is `partial` unless every enabled destination is posted, already-posted/caught-up, skipped by rule/policy, or explicitly blocked with reason. Do not treat a single destination success as source completion unless the user explicitly requested a destination-specific pair job.
4. **Exact text fidelity is mandatory.** No content rewording, compaction,
   paraphrase, grammar cleanup, tone adjustment, or editorial improvement is
   ever allowed in a public destination post. If the exact cleaned source text
   cannot fit a destination, skip/block and notify Ethan rather than changing
   the words.
5. **Live publishes need either `mode: "live-approved"` (for scheduled live ticks)
   or explicit per-post authorization.** `preview-only` always refuses to
   publish.
   Scheduling itself is flexible: the starter path is one daily all-enabled sweep, but source-item fanout backfill jobs, per-pair jobs, subset jobs, preview/dry jobs, manual-only pairs, and custom current-harness cadences are valid user-owned configurations.
6. **Custom user rules run before dedupe.** After source scrape, apply
   top-level/pair `customRules` and `considered.jsonl` using
   `skills/repost-custom-rules/SKILL.md`. Skip matching not-post-worthy
   candidates without touching `posted.jsonl` or `global-posted.jsonl`.
7. **Dedupe is global before it is per-pair.** Every publish-capable path must
   read `~/.repost-with-agent/global-posted.jsonl` via
   `skills/repost-global-dedupe/SKILL.md` before composing. Resolve a
   cross-pair `contentKey`, inherit lineage when the current source is a post
   created by another pair (e.g. LinkedIn→X then X→Bluesky), and skip if that
   `contentKey` already reached this destination from any pair. Pairs must look
   globally; per-pair files are not enough. Default enabled via
   `policy.globalDedupeEnabled: true`.
8. **Dedupe runs in two layers, both must clear.**
   - **Layer 1** (`skills/repost-dedup/SKILL.md`) — local exact match
     against `posted.jsonl`, global cross-pair ledger match, plus remote
     fuzzy-string match against the destination feed. Cheap, catches verbatim
     re-posts and already-routed cross-pair duplicates.
   - **Layer 2** (`skills/repost-dedup-semantic/SKILL.md`) — agent
     reasons over the candidate draft and the destination's most recent
     30 posts (override per-pair via `policy.semanticDedupeWindowSize`)
     to catch paraphrased duplicates ("same announcement, different
     words"). Lean conservative — when on the fence, skip. (Ethan voice
     6106, 2026-05-01: *"that'll be embarrassing."*) Enabled by default,
     opt out per-pair via `policy.semanticDedupeEnabled: false`.
   - Uncertain matches are skipped unless
     `policy.blockOnUncertainDuplicate` is `false`.
9. **No stealth, no CAPTCHA bypass, no 2FA bypass.** Browser automation only
   operates on user-controlled, transparent login sessions.
10. **OpenClaw browser only for OpenClaw runs.** Use the OpenClaw browser/profile
   (`profile: openclaw`, CDP port `18800`) for all Repost-with-agent OpenClaw
   work. Do not touch Ethan's personal browser/profile unless he explicitly says
   to for that run.
11. **You CANNOT log in for the user.** If a session is expired, append
   `pair.publish.failed` audit with `category: "needs-login"` and stop.
12. **Append, don't rewrite.** `posted.jsonl`, `audit.jsonl`,
   `global-posted.jsonl`, and `considered.jsonl` are append-only. Use `>>` in Bash.
13. **Destination posts are native posts, not source receipts.** Expand any URLs
   in the source body to their final non-source-platform URL where possible
   (for example `lnkd.in` → the underlying article/video), but do **not** append
   the source platform permalink to the public destination draft. Keep source
   canonical URLs in `posted.jsonl`, audit, and publish confirmation only.
14. **Use the current harness browser, not Playwright or another agent by default.**
   The plugin has zero Playwright / API-SDK dependencies. The browser automation
   your current harness provides is the only browser path unless Ethan explicitly
   asks for a different harness.

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
- `pair.custom_rule.skipped` — Candidate matched a user custom skip rule before dedupe/publish.
- `pair.publish.semantic_duplicate` — Layer 2 semantic dedupe match. Candidate skipped pre-publish; includes `candidateExcerpt`, `matchedExistingUrl`, `matchedExistingExcerpt`, `agentReasoning`, `windowSize`.
- `pair.dedupe.uncertain` — destination scrape failed; treat candidates conservatively.
- `pair.dedupe.global_duplicate` — global ledger found the same `contentKey` already posted/caught-up for this destination; skip.
- `source.fanout.start` / `source.fanout.destination` / `source.fanout.complete` / `source.fanout.blocked` / `source.fanout.partial` — source-item fanout lifecycle and resume proof.

## Cross-machine context

If you're a remote session and Ethan asks you to mirror state with the Mac
Mini's session, use `bridge_send_message` to coordinate. Do not delegate a
Repost-with-agent run to Claude Code just because Claude Code is available; use
the current harness unless Ethan explicitly requests another one. Don't use
`agent-bridge run` — it's a plain shell utility, not an agent invocation.

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

If the scheduler spawned you fresh with `/repost-run all` or another Repost-with-agent scheduled prompt:

1. Read `~/.repost-with-agent/pairs.json`.
2. Resolve the requested scope literally: default `all` means enabled `listen-for-future` pairs; custom jobs may name one pair or an explicit subset. If the scheduled prompt is a source-level backfill slot, load `skills/repost-source-fanout/SKILL.md` and process exactly one source item across all enabled destinations before selecting another item.
3. Live jobs publish only pairs where `mode === "live-approved"`; preview/dry jobs never publish, even if a pair is live-approved.
4. Sleep 30–60s between pairs to avoid rate-limit thrashing.
5. Exit cleanly.

## See also

- [`README.md`](README.md) — user-facing overview.
- [`docs/architecture.md`](docs/architecture.md) — full architectural rationale.
- [`docs/state-files.md`](docs/state-files.md) — formal state-file schemas.
- [`docs/source-fanout.md`](docs/source-fanout.md) — source-item fanout contract for scheduled/backfill slots.
- [`docs/migration-v3-to-v4.md`](docs/migration-v3-to-v4.md) — second-rewrite changelog.
- [`CLAUDE.md`](CLAUDE.md) — Claude Code-specific guidance (mirrors this file).
- [`AGENTS.md`](AGENTS.md) — multi-harness agent guidance (mirrors this file).
