# CLAUDE.md — Repost-with-agent (v4.5.7)

Guidance for any Claude Code / Claude Agent / OpenClaw session operating on
this repo. Read this BEFORE you touch state, run a publish, or hand off to a
scheduled tick.

## v4.5.7 architecture in one paragraph

Repost-with-agent v4 is a **skill-only plugin**. There is no CLI, no MCP
server, no platform SDK. **You** (the running agent) do all the work using
your native toolkit: Read, Edit, Write, Bash, current-harness browser
automation, and configured current-harness user-message delivery. The skills under
`skills/<name>/SKILL.md` are step-by-step procedures you read and execute
directly. The slash commands under `commands/*.md` are thin wrappers that load
the matching skill.

The architecture is generic: it can work with any website the current harness
can safely operate through a logged-in browser. This repo ships documented and
validated example surfaces for **LinkedIn, X, Bluesky, Threads, and Facebook**;
other websites need pair-specific validation, destination dedupe, account
identity checks, and `learnings.md`/custom-rule updates rather than an
assumption that the existing examples fully apply.

(Ethan voice 6024 + 6026, 2026-05-01: "essentially just a skill for the
existing harness... we don't code anything in.")

## The non-negotiable rule — Telegram-confirm every successful publish

> **Telegram-confirm every successful publish — non-negotiable.** Every
> successful post from this plugin MUST trigger a Telegram message to Ethan
> confirming the source URL and the destination URL. If you trigger a publish
> through any non-skill path you MUST also fire a Telegram confirmation.
> Silent publishes are a bug. (Ethan voice 5977 + 5978, 2026-05-01.)

## The non-negotiable rule — preserve exact post wording

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

Defense in depth — the exact-wording rule is restated in:

- `skills/repost-run/SKILL.md` step 7 (compose/length gate)
- `skills/repost-backfill/SKILL.md` and `skills/repost-source-fanout/SKILL.md`
- `skills/repost-pair-setup/SKILL.md` and `templates/pairs.json.template`
- All four `commands/*.md` slash command bodies
- Destination docs, `README.md`, `INSTRUCTIONS.md`, `AGENTS.md`, `openclaw.plugin.json`, this file

## Required harness toolkit

Your session must have:

- **Read, Edit, Write, Bash** — built-in.
- **Native browser automation in the current harness** — `chrome-devtools-mcp`
  when this is truly a Claude Code run, OpenClaw's built-in browser when this
  is an OpenClaw run, or another explicit browser adapter. Do not route an
  OpenClaw-owned Repost-with-agent run through Claude Code unless Ethan asks.
- **User-message delivery in the current harness** — read `notification.delivery`
  from `~/.repost-with-agent/pairs.json` and map it to the harness's configured
  message tool. Used for the publish-confirmation pings.


**Notification routing rule:** user-visible Repost notifications are not inherently Telegram-specific. Store the route in `~/.repost-with-agent/pairs.json` under `notification.delivery` (for example `channel`, `accountId`, `target`, optional `threadId`) using the current harness/chat metadata during setup. Scheduled runs must read that route and pass it explicitly to the harness message tool; never rely on a default account/bot, and never paste raw JSON/tool output into user-facing messages.

If any is missing, the relevant skill surfaces the missing dependency and
stops. There's no fallback.

## State files

All state lives at `~/.repost-with-agent/`. You read/write via native Read,
Edit, Write tools.

- `pairs.json` — array of pair configs (schemaVersion 4), including optional `customRules`.
- `global-posted.jsonl` — append-only cross-pair publish/duplicate proof ledger.
- `considered.jsonl` — append-only custom-rule / not-post-worthy decisions.
- `pairs/<id>/posted.jsonl` — append-only NDJSON history. Append via `>>` in
  Bash. NEVER rewrite existing lines.
- `pairs/<id>/audit.jsonl` — append-only NDJSON audit events.
- `pairs/<id>/learnings.md` — per-pair institutional memory. Read at the
  start of every run, appended at the end. Quirks accumulate across cron
  ticks so you don't re-figure them each time. Each entry has free-form
  prose plus optional `### Selectors`, `### Step playbook`, and
  `### Quirks` sub-sections — try those verbatim FIRST, fall back to
  `docs/destinations/<platform>.md` only when learnings.md is silent.
  Full lifecycle: `skills/repost-learnings/SKILL.md`.
- `pairs/<id>/backfill-state.json` — transient destination-specific backfill resume state.
- `source-fanouts/<source-platform>/<safe-source-item-id>.json` — source-item fanout manifest for scheduled/source backfills.
- `pairs/<id>/logs/cron.log` — stdout/stderr from fallback launchd/crontab ticks when that scheduler path is used.

Full schemas + audit-event taxonomy: `docs/state-files.md`.

## Two run-modes

- **`listen-for-future`**: tail new posts on a current-harness scheduler (OpenClaw cron preferred for OpenClaw workflows). Default is one daily all-enabled sweep, but users may configure per-pair jobs, subset jobs, preview-only jobs, or custom cadences.
  Default. Each tick spawns a fresh subagent which runs `skills/repost-run/SKILL.md`.
- **`backfill`**: one-shot walk back through historical source posts,
  newest-first (Ethan voice 6021). Use `skills/repost-backfill/SKILL.md`.
  Source-level/scheduled backfill slots also load
  `skills/repost-source-fanout/SKILL.md` and process one source item across all
  enabled destinations before moving on. Default 10 max, 10-minute interval.

## URL expansion

Every URL in a draft body is followed up to 5 hops with a 5-second timeout
per hop using `curl -sIL --max-time 5 --max-redirs 5 -o /dev/null -w '%{url_effective}'`
in Bash. Shorteners covered: `lnkd.in`, `t.co`, `bit.ly`, `buff.ly`, `goo.gl`,
`tinyurl.com`, `ow.ly`, `is.gd`, `rebrand.ly`, `tr.im`, `shorturl.at`, `cutt.ly`,
`rb.gy`. Failure is fail-soft — original URL kept.

Do **not** append the source platform's canonical URL to the public destination
draft. The destination post should read like a fresh native post; keep the
source canonical URL only in `posted.jsonl`, audit events, and Telegram
confirmation. If the source body contains `lnkd.in` / LinkedIn safety wrapper
links, resolve them to the underlying non-LinkedIn URL before posting to X.

See `skills/repost-url-expand/SKILL.md` and `docs/url-expander.md`.

## Custom rules + global/two-layer dedupe (v4.5.0+)

Every publish first applies user custom rules, then must clear the global ledger and BOTH layers:

- **Custom rules.** Immediately after source scrape, read top-level/pair
  `customRules` from `~/.repost-with-agent/pairs.json` and
  `~/.repost-with-agent/considered.jsonl` via
  `skills/repost-custom-rules/SKILL.md`. A custom-rule skip appends considered
  + per-pair audit state only. Do NOT append to `posted.jsonl` or
  `global-posted.jsonl` because no destination proof exists.

- **Global cross-pair ledger.** Read
  `~/.repost-with-agent/global-posted.jsonl`, resolve/inherit the candidate
  `contentKey`, and skip if any pair has already got that content to this
  destination platform/account. This is what prevents LinkedIn→X→Bluesky and
  direct X→Bluesky from double-posting. See
  `skills/repost-global-dedupe/SKILL.md`.
- **Layer 1 — strings.** Local exact `sourceItemId` match against
  `posted.jsonl`, global ledger check, plus remote fuzzy-string match
  (normalize whitespace + lowercase + strip URLs + ≥80-char prefix overlap)
  against the destination's recent posts. Cheap, catches verbatim re-posts. See
  `skills/repost-dedup/SKILL.md`.
- **Layer 2 — agent semantic check.** After Layer 1 clears, you (the
  agent) read the candidate draft + the destination's most recent 30
  posts (`pair.policy.semanticDedupeWindowSize`, default 30) and decide
  with your own reasoning whether the candidate is "essentially the
  same announcement / opinion / claim, different words." Catches
  paraphrased duplicates. See `skills/repost-dedup-semantic/SKILL.md`.

Ethan voice 6106 (2026-05-01): *"It should make sure the agent actually
semantically looks and processes the content of the message and checks
the target destination and sees if there's a post with similar wording
already there... that'll be embarrassing."*

Global dedupe is enabled by default (`pair.policy.globalDedupeEnabled: true`)
and Layer 2 is enabled by default (`pair.policy.semanticDedupeEnabled: true`).
Turn either off only with explicit per-pair policy. Lean conservative on the
threshold — when on the fence, skip.

## Audit events to grep for

- `pair.publish.success` — destination confirmed the post.
- `pair.publish.notify.success` — Telegram delivered immediately after.
- `pair.publish.notify.failure` — Telegram failed; publish still up. Tell Ethan
  directly via Telegram so the missed ping is replaced; investigate the error.
- `pair.publish.notify_skipped_unconfigured` — silent publish. **Treat as a
  project bug.** Fix immediately.
- `pair.publish.url_expanded` — one URL was successfully expanded.
- `pair.custom_rule.skipped` — user custom skip rule matched before dedupe/publish; considered state appended, no publish ledger append.
- `pair.publish.semantic_duplicate` — Layer 2 dedupe match; candidate skipped pre-publish. Includes `candidateExcerpt`, `matchedExistingUrl`, `matchedExistingExcerpt`, `agentReasoning`, `windowSize`.
- `pair.dedupe.global_duplicate` — global ledger found this content already on this destination from another pair/path.
- `source.fanout.start` / `source.fanout.destination` / `source.fanout.complete` / `source.fanout.blocked` / `source.fanout.partial` — source-item fanout lifecycle and resume proof.
- `pair.dedupe.uncertain` — destination scrape failed; candidates skipped.

## Scheduled-run context

The scheduler entry installed by `skills/repost-listen-for-future-setup/SKILL.md`
should invoke the same harness the user chose for the workflow. If the current
harness is OpenClaw, use OpenClaw scheduling/session tools; do not route the
run through Claude Code. A Claude Code invocation is appropriate only when the
current workflow is intentionally Claude Code-based. The fresh scheduled agent
loads this plugin, runs the slash command (which loads `skills/repost-run/SKILL.md`
for normal sweeps or `skills/repost-source-fanout/SKILL.md` for source backfill slots),
then exits.
There is no daemon, no long-running process, no shared state in memory between
ticks.

## Project rules in one paragraph

- New pairs default to `mode: "preview-only"` and `enabled: false`. Intentional.
- Scheduling is flexible by design: the starter path is one daily all-enabled-pairs sweep, but source-item fanout backfill jobs, per-pair cron jobs, subset jobs, preview/dry jobs, manual-only pairs, and custom current-harness cadences are valid user-owned configurations.
- **Source-level backfill slots are source-item fanouts.** For a source such as LinkedIn, a scheduled/backfill slot selects one source item, enumerates every enabled destination pair for that source, and records each destination as posted/already-posted/skipped/blocked/partial in a fanout manifest. Do not treat one destination success as source-item completion unless the user explicitly requested a destination-specific pair job.
- **Exact text fidelity is mandatory.** No content rewording, compaction,
  paraphrase, grammar cleanup, tone adjustment, or editorial improvement is ever
  allowed in a public destination post. If the exact cleaned source text cannot
  fit a destination, skip/block and notify Ethan rather than changing the words.
- Live publishes always need either `mode: "live-approved"` (for scheduled
  ticks) or explicit per-post user authorization (`mode: "approval-required"`).
  `preview-only` always refuses.
- Custom rules are checked before dedupe/publish. A custom-rule skip appends
  `considered.jsonl` + pair audit only; it never appends publish/global ledgers.
- Dedupe is re-checked at every publish — global ledger plus both layers (Layer
  1 string match: local `posted.jsonl` + remote fuzzy-match with normalize +
  ≥80-char prefix overlap; Layer 2 agent semantic check over the destination's
  last 30 posts) must clear.
- Uncertain matches are skipped unless `policy.blockOnUncertainDuplicate` is
  `false`. Layer 2 can be turned off per-pair via
  `policy.semanticDedupeEnabled: false`.
- No stealth, no CAPTCHA / 2FA bypass, no hidden posting. Browser automation
  is only ever for transparent user-controlled login sessions.
- You CANNOT log in for the user. If the session is expired, append
  `pair.publish.failed` audit with `category: "needs-login"` and stop.
- `posted.jsonl` and `audit.jsonl` are append-only. Use `>>` in Bash.

## v3 → v4 migration

v3 was a CLI orchestrator with an "agent-task contract"; v4 deletes the CLI
and ships only skills + commands. The `pairs.json` schema bumps from 3 to 4 —
deprecated fields (`policy.requirePreviewBeforeFirstLiveRun`,
`policy.preferOfficialApi`, `dedupe.strategy`, `*.authRef`, `source.type`,
`destination.type`) are dropped; `runMode` (default `"listen-for-future"`) and
`schedule.everyHours` (default 24 / daily) are added. The v3 file is backed up to
`~/.repost-with-agent/pairs.json.v3.bak`.

The 11 entries in `~/.repost-with-agent/pairs/linkedin-to-x/posted.jsonl`
survive untouched. See `docs/migration-v3-to-v4.md` for the full walkthrough.

## What to do if you find a `pair.publish.notify_skipped_unconfigured` audit event

1. Tell Ethan directly via Telegram (so the missed ping is replaced).
2. Verify `notification.delivery` is configured and the current harness message-delivery tool is installed + enabled in this harness.
3. Re-run the affected publish flow once Telegram is wired up.
4. File the gap in this file with date + audit-event line so future sessions
   see it.

## See also

- `INSTRUCTIONS.md` — the agent-facing primer for this repo.
- `README.md` — user-facing overview.
- `AGENTS.md` — multi-harness agent guidance.
- `docs/architecture.md` — full architectural rationale.
- `docs/state-files.md` — formal schemas + audit-event taxonomy.
- `docs/migration-v3-to-v4.md` — second-rewrite changelog.
- `docs/destinations/<platform>.md` — per-platform DOM hints.
