# CLAUDE.md — Repost-with-agent (v4.3.0)

Guidance for any Claude Code / Claude Agent / OpenClaw session operating on
this repo. Read this BEFORE you touch state, run a publish, or hand off to a
scheduled tick.

## v4.3.0 architecture in one paragraph

Repost-with-agent v4 is a **skill-only plugin**. There is no CLI, no MCP
server, no platform SDK. **You** (the running agent) do all the work using
your native toolkit (Read, Edit, Write, Bash, browser MCP,
plugin:telegram:telegram). The skills under `skills/<name>/SKILL.md` are
step-by-step procedures you read and execute directly. The slash commands
under `commands/*.md` are thin wrappers that load the matching skill.

Supported platforms: **LinkedIn, X, Bluesky, Threads, Facebook**. Platform
labels are free-form strings in pair config; you read them and pick the right
URL templates and DOM selectors at runtime via `docs/destinations/<platform>.md`.

(Ethan voice 6024 + 6026, 2026-05-01: "essentially just a skill for the
existing harness... we don't code anything in.")

## The non-negotiable rule — Telegram-confirm every successful publish

> **Telegram-confirm every successful publish — non-negotiable.** Every
> successful post from this plugin MUST trigger a Telegram message to Ethan
> confirming the source URL and the destination URL. If you trigger a publish
> through any non-skill path you MUST also fire a Telegram confirmation.
> Silent publishes are a bug. (Ethan voice 5977 + 5978, 2026-05-01.)

Defense in depth — the rule is restated in:

- `skills/repost-notify/SKILL.md` (the primary enforcement point)
- `skills/repost-run/SKILL.md` step 10 (single-post flow)
- `skills/repost-backfill/SKILL.md` step 6 (multi-post flow)
- All four `commands/*.md` slash command bodies
- `README.md`, `INSTRUCTIONS.md`, `AGENTS.md`, `openclaw.plugin.json`, this file

## Required harness toolkit

Your session must have:

- **Read, Edit, Write, Bash** — built-in.
- **A browser MCP** — `chrome-devtools-mcp` (Claude Code), OpenClaw's built-in
  browser tool, or `claude-in-chrome`.
- **`plugin:telegram:telegram`** — for the publish-confirmation pings.

If any is missing, the relevant skill surfaces the missing dependency and
stops. There's no fallback.

## State files

All state lives at `~/.repost-with-agent/`. You read/write via native Read,
Edit, Write tools.

- `pairs.json` — array of pair configs (schemaVersion 4).
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
- `pairs/<id>/backfill-state.json` — transient backfill resume state.
- `pairs/<id>/logs/cron.log` — stdout+stderr from the launchd / cron tick.

Full schemas + audit-event taxonomy: `docs/state-files.md`.

## Two run-modes

- **`listen-for-future`**: tail new posts on a schedule (launchd / cron).
  Default. Each tick spawns a fresh subagent which runs `skills/repost-run/SKILL.md`.
- **`backfill`**: one-shot walk back through historical source posts,
  newest-first (Ethan voice 6021). Use `skills/repost-backfill/SKILL.md`.
  Default 10 max, 10-minute interval.

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

## Two-layer dedupe (v4.3.0+)

Every publish must clear BOTH layers:

- **Layer 1 — strings.** Local exact `sourceItemId` match against
  `posted.jsonl` plus remote fuzzy-string match (normalize whitespace +
  lowercase + strip URLs + ≥80-char prefix overlap) against the
  destination's recent posts. Cheap, catches verbatim re-posts. See
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

Layer 2 is enabled by default (`pair.policy.semanticDedupeEnabled: true`)
and can be turned off per-pair. Lean conservative on the threshold —
when on the fence, skip.

## Audit events to grep for

- `pair.publish.success` — destination confirmed the post.
- `pair.publish.notify.success` — Telegram delivered immediately after.
- `pair.publish.notify.failure` — Telegram failed; publish still up. Tell Ethan
  directly via Telegram so the missed ping is replaced; investigate the error.
- `pair.publish.notify_skipped_unconfigured` — silent publish. **Treat as a
  project bug.** Fix immediately.
- `pair.publish.url_expanded` — one URL was successfully expanded.
- `pair.publish.semantic_duplicate` — Layer 2 dedupe match; candidate skipped pre-publish. Includes `candidateExcerpt`, `matchedExistingUrl`, `matchedExistingExcerpt`, `agentReasoning`, `windowSize`.
- `pair.dedupe.uncertain` — destination scrape failed; candidates skipped.

## Cron / launchd context

The scheduler entry installed by `skills/repost-listen-for-future-setup/SKILL.md`
shells out to:

```bash
/usr/local/bin/claude --print --no-banner "/repost-run <pair-id>"
```

This launches a fresh, ephemeral Claude Code session, which loads this plugin,
runs the slash command (which loads `skills/repost-run/SKILL.md`), then exits.
There is no daemon, no long-running process, no shared state in memory between
ticks.

## Project rules in one paragraph

- New pairs default to `mode: "preview-only"` and `enabled: false`. Intentional.
- Live publishes always need either `mode: "live-approved"` (for cron-driven
  ticks) or explicit per-post user authorization (`mode: "approval-required"`).
  `preview-only` always refuses.
- Dedupe is re-checked at every publish — both layers (Layer 1 string
  match: local `posted.jsonl` + remote fuzzy-match with normalize +
  ≥80-char prefix overlap; Layer 2 agent semantic check over the
  destination's last 30 posts) must clear.
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
`schedule.everyHours` (default 5) are added. The v3 file is backed up to
`~/.repost-with-agent/pairs.json.v3.bak`.

The 11 entries in `~/.repost-with-agent/pairs/linkedin-to-x/posted.jsonl`
survive untouched. See `docs/migration-v3-to-v4.md` for the full walkthrough.

## What to do if you find a `pair.publish.notify_skipped_unconfigured` audit event

1. Tell Ethan directly via Telegram (so the missed ping is replaced).
2. Verify `plugin:telegram:telegram` is installed + enabled in this harness.
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
