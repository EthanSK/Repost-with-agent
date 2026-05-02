# Changelog

## v4.0.0 — 2026-05-01 — Skill-only plugin (second rewrite)

**Major architectural change.** Repost-with-agent is now a **skill-only plugin**.
There is **no CLI**, **no MCP server**, **no platform SDKs**, **no Playwright**.
The plugin ships zero code that does the work — it ships instructions (skills)
and the running agent's existing toolkit (Read, Edit, Write, Bash, browser
MCP, plugin:telegram:telegram) does everything.

(Ethan voice 6024 + 6026, 2026-05-01: "The whole point of this is a plugin we
install into the existing agent harness... It's essentially just a skill for
the existing harness. This isn't fucking a CLI that uses a new chat... we
don't code anything in.")

### Stripped (v3 → v4)

- `src/` entirely — every TypeScript file (CLI orchestrator,
  `agent-task-contract.ts`, `agent-runner.ts`, `orchestrator.ts`,
  `backfill.ts`, `scheduling.ts`, `notify.ts`, `dedupe.ts`, `truncate.ts`,
  `url-expander.ts`, `policy.ts`, `runtime.ts`, `types.ts`, `config.ts`,
  `index.ts`).
- `tests/` — all 8 regression suites. None of them apply to skill-driven flow.
- `tsconfig.json`, `package-lock.json`, `node_modules/`, `dist/`, `.env.example`.
- The `repost-with-agent` CLI binary (no more `bin` entry in `package.json`).
- `templates/repost_with_agent_workspace/` (legacy v2/v3 workspace template).
- `examples/`, `site/`, `.github/` workflows, `PLAN.md`.
- `commands/preview.md` (functionality folded into `commands/run.md`).
- `scripts/agent-bridge-handler.sh`, `scripts/init_repost_with_agent_workspace.py`,
  `scripts/install-for-openclaw.sh` — the v3 installer rig.
- `docs/WORKFLOW.md`, `docs/scheduling.md`, `docs/safety.md`,
  `docs/setup-flow.md`, `docs/migration-v2-to-v3.md`, the v3 versions of
  `docs/architecture.md`, `docs/migration.md`, `docs/url-expander.md`,
  `docs/screenshots/`.
- The "agent-task contract" boundary entirely — no more typed JSON tasks
  written to `~/.repost-with-agent/agent-tasks/`. The agent reads the skill
  and acts directly.

### Added

- `.claude-plugin/marketplace.json` — directory-source marketplace manifest
  (mirrors agent-bridge's pattern).
- 10 `skills/<name>/SKILL.md` files:
  - `repost-pair-setup` — create / edit pairs.
  - `repost-pair-list` — list pairs.
  - `repost-pair-show` — inspect one pair.
  - `repost-run` — single-post end-to-end flow.
  - `repost-backfill` — multi-post historical walk.
  - `repost-listen-for-future-setup` — install launchd plist / cron entry.
  - `repost-history` — tail posted.jsonl.
  - `repost-dedup` — fuzzy-match algorithm reference.
  - `repost-url-expand` — shortener resolution.
  - `repost-notify` — Telegram-confirm payload + non-negotiable rule.
- 4 `commands/*.md` slash command wrappers: `/pair`, `/repost-run`,
  `/repost-backfill`, `/repost-setup-cron`.
- `scripts/install.sh` + `scripts/uninstall.sh` — idempotent JSON edits to
  `~/.claude/settings.json` + `~/.openclaw/openclaw.json`. Backs up pre-edit
  files. Validates post-edit JSON, restores backup on parse failure.
- `templates/pairs.json.template`, `posted.jsonl.template`,
  `audit.jsonl.template`.
- `docs/state-files.md` — formal schemas + audit-event taxonomy.
- `docs/architecture.md` — v4 architecture rationale (rewritten).
- `docs/migration-v3-to-v4.md` — second-rewrite changelog + rollback path.
- `docs/url-expander.md` — agent-facing reference (rewritten).
- `INSTRUCTIONS.md` — primer for the running agent.

### Changed

- `package.json` — bare metadata only. No `bin`, no `main`, no `scripts`, no
  dependencies, no devDependencies. Just name, version (4.0.0),
  description, license, keywords, repository, homepage.
- `.claude-plugin/plugin.json` — declares 10 skills + 4 commands. NO
  `mcpServers` section.
- `openclaw.plugin.json` — `runtime` block removed entirely.
  `skills_roots` + `commands_roots` only. NO `mcp` section.
- `pairs.json` schema — `schemaVersion` 3 → 4. Deprecated fields ignored
  (`policy.requirePreviewBeforeFirstLiveRun`, `policy.preferOfficialApi`,
  `dedupe.strategy`, `*.authRef`, `source.type`, `destination.type`).
  Added: `runMode` (default `"listen-for-future"`), `schedule.everyHours`
  (default 5), `policy.overlengthStrategy` (default `"skip"`).
- The Telegram-on-publish notifier is now enforced by skill bodies, not by
  a `notify.json` config file. Uses the running session's
  `plugin:telegram:telegram` plugin directly.
- Per-platform DOM hints in `docs/destinations/<platform>.md` rewritten as
  direct procedural prose for the running agent (no more "post-to-destination
  task" / "fetch-source task" vocabulary).
- README, CLAUDE.md, AGENTS.md fully rewritten for v4 architecture.

### Preserved

- `~/.repost-with-agent/pairs/<id>/posted.jsonl` history — UNTOUCHED. Schema
  identical between v3 and v4.
- `~/.repost-with-agent/pairs/<id>/audit.jsonl` — UNTOUCHED.
- `~/.repost-with-agent/pairs/<id>/learnings.md` — UNTOUCHED.
- The 11 entries in the legacy `linkedin-to-x` posted.jsonl survive
  unchanged.

### Migration

`scripts/install.sh` is idempotent. Running it on a fresh v4 clone:

1. Backs up `~/.claude/settings.json` and `~/.openclaw/openclaw.json` to
   `<file>.bak.<unix-ts>`.
2. Adds repost-with-agent as a directory-source marketplace + enabled plugin.
3. Ensures `~/.repost-with-agent/` exists with empty `pairs.json` if missing.
4. Validates JSON post-edit; restores backup on parse failure.

For v3 → v4 schema migration on `pairs.json`, see `docs/migration-v3-to-v4.md`.

### Non-negotiable rule (continued from v3)

> Telegram-confirm every successful publish. Silent publishes are a bug.
> (Ethan voice 5977 + 5978, 2026-05-01.)

In v4 this is enforced in the skill bodies (`repost-notify` is the primary
enforcement point; `repost-run` step 10 + `repost-backfill` step 6 explicitly
invoke it). The rule is restated verbatim in README, CLAUDE.md, AGENTS.md,
INSTRUCTIONS.md, openclaw.plugin.json, and every slash command body.

---

## v3.0.0 — 2026-05-02 — Strip-and-rewrite, agent-driven

**Major architectural change.** The CLI is now a thin orchestrator over JSON state; the agent (Claude Code via `chrome-devtools-mcp`, OpenClaw via its built-in browser tool) drives the user's logged-in browser to do the actual reposting. There is **no API path** and **no Playwright** in `src/`. (Ethan voice 6016 + 6018 + 6021, 2026-05-01.)

### Stripped (the v3 architectural sin to never reintroduce)

- `src/x-client.ts` (520 LOC X API).
- `src/linkedin-scraper.ts` (279 LOC Playwright).
- `src/facebook-client.ts` (Facebook Graph API).
- `src/adapters/{sources,destinations}/` (per-platform adapter classes).
- `src/legacy-commands.ts`, `src/tracker.ts` (legacy `linkedin-to-x` sync path).
- `playwright`, `dotenv` deps from `package.json`. The runtime now ships with `commander` only.
- The `auth`, `sync`, `list`, `start`, `migrate linkedin-to-x` CLI verbs (legacy / replaced by browser-driven flows + auto-migration).
- `docs/substack-investigation.md` (Substack dropped from v3 scope per Ethan voice 6021 — "not really social media").

### Added — agent-task contract

- `src/core/agent-task-contract.ts` — typed `AgentTask` / `AgentResult` union covering `fetch-source`, `post-to-destination`, `check-destination` across all platforms. Includes inbox file helpers (`writeAgentTask`, `readAgentTask`, `writeAgentResult`, `readAgentResult`) routing through `~/.repost-with-agent/agent-tasks/<correlation_id>.{task,result}.json`.
- `src/core/agent-runner.ts` — `runAgentTask(task, options)` dispatches via in-process handler callback (used by tests + inline-driven CLI flows) OR via filesystem inbox + stdout banner (decoupled invocation). The orchestrator is the only place that knows about agents; everywhere else just calls the runner.
- New `error-result` shape with `category` field (`needs-login` / `needs-config` / `rate-limit` / `platform-error` / `unknown`) so the orchestrator can route auth failures vs transient errors vs platform misconfig.

### Added — URL expander (Ethan voice 6018, 6021)

- `src/core/url-expander.ts` — follows shortener redirects to the final destination URL before publish.
  - Max 5 hops, 5-second timeout per request, fail-soft on any error (timeout / network / loop / hop-cap / missing Location).
  - HEAD first, fallback to GET on 405/501.
  - Loop detection (URL appears twice in chain).
  - Covers lnkd.in, t.co, bit.ly, buff.ly, goo.gl, tinyurl.com, ow.ly, rb.gy, is.gd, shorturl.at, tiny.cc, cutt.ly, youtu.be, fb.me, trib.al, plus any URL that issues a 30x.
- `expandUrlsInText(body)` substitutes every shortened URL in a block of text.
- New helper commands: `repost-with-agent urls expand <url>` and `repost-with-agent urls expand-text "<body>"`.
- Audit event `pair.publish.url_expanded` per substitution, with `{shortenedUrl, expandedUrl, hopCount}`.
- `tests/url-expander-regression.js` (new) — 12 sections covering single hop, multi-hop, MAX_HOPS cap, redirect loop, timeout fail-soft, network fail-soft, HEAD 405 → GET fallback, missing Location, expandUrlsInText substitution, isShortener helper, smoke test for every known shortener.

### Added — two run-modes (Ethan voice 6021)

- `pair.runMode` field on `PairRecord`:
  - `"backfill"` — walk back through historical posts. Run via `pair backfill <id>`. **Newest-first** ordering (was oldest-first in v2).
  - `"listen-for-future"` (default for migrated v2 pairs) — continuous tail. Host scheduler invokes `pair scheduled-run <id>` at the configured cadence. Always preview-only unless `--allow-publish` AND `pair.mode=live-approved`.
- `pair create --run-mode <mode>` and `pair edit --run-mode <mode>` flags.
- `orderNewestFirst` (replaces `orderOldestFirst`) — sorts by `publishedAt` descending, falls back to source-order ascending.

### Added — generic platform support

- `pair.source.platform` / `pair.destination.platform` — free-form string labels (e.g. `"linkedin"`, `"x"`, `"bluesky"`, `"threads"`, `"facebook"`). Replaces v2's `type` field (which was an adapter id).
- `pair create --source-platform <p> --destination-platform <p>` flags (replaces v2's `--source-type` / `--destination-type`).
- Platforms supported in v3.0.0: **LinkedIn, X, Bluesky, Threads, Facebook**.
- Default per-platform char caps in `DEFAULT_PLATFORM_MAX_LENGTH`: X=280, Bluesky=300, Threads=500, Facebook=63206, LinkedIn=3000. Override via `--overlength-strategy` on `pair post` / `pair backfill`.

### Added — overlength enforcement on `pair post`

- `pair post <id> --approve --overlength-strategy {skip|truncate}` — same semantics as `pair backfill`'s strategy. `skip` (default) refuses; `truncate` smart-shortens.
- New audit events: `pair.publish.overlength-blocked`, `pair.publish.truncated`.
- New scheduled-run outcome: `overlength-blocked`.

### Added — v2 → v3 pair migration

- One-shot migration on first read of a v2-shaped `pairs.json`:
  - Backs up the original to `~/.repost-with-agent/pairs.json.v2.bak`.
  - Translates `type` → `platform` for known v2 adapter ids (`linkedin-profile-activity` → `linkedin`, `x-account` → `x`, `facebook-page` → `facebook`, `bluesky-account` → `bluesky`, `threads-account` → `threads`).
  - Sets `runMode: "listen-for-future"` (preserves v2's only-mode-it-had semantics).
  - Stamps `schemaVersion: 3`.
- Verified locally on Ethan's existing `linkedin-to-x` pair: all 11 entries in `posted.jsonl` preserved untouched; pair loads cleanly; `pair show` / `pair history` work.
- See `docs/migration-v2-to-v3.md` for the full walkthrough.

### Added — agent-task-contract regression tests

- `tests/agent-task-contract-regression.js` (new) — 9 sections covering correlation-id format, inbox round-trip, error result type guard, summarizeTask formatting, in-process handler dispatch, runAgentTaskExpect type-mismatch throw, full preview/publish path with mock agent, agent-error-result-halts-publish.

### Changed

- `src/core/orchestrator.ts:previewPair()` and `publishNextForPair()` now take `PreviewOptions` / `PublishPairOptions` instead of source/destination adapter instances. The agent task handler is supplied via `options.agent.handler` for in-process tests OR omitted to use the inbox path.
- `src/core/backfill.ts:runBackfill()` similarly takes only `BackfillOptions` (no adapter args). The CLI no longer constructs / registers adapters.
- `src/core/scheduling.ts:runScheduled()` drops adapter args; passes through to `publishNextForPair`.
- `src/index.ts` simplified — removed `--source-type` / `--destination-type` flags (replaced with `--source-platform` / `--destination-platform`), removed legacy `auth | sync | list | start | migrate` verbs, added `--run-mode` flag on `pair create` / `pair edit`, added `--overlength-strategy` flag on `pair post`, added `urls expand | expand-text` helper subcommands.
- `tests/backfill-regression.js`, `tests/overlength-regression.js` rewritten to drive `runBackfill` via in-process agent task handler. All assertions preserved.
- `tests/dedupe-regression.js`, `tests/scheduling-regression.js`, `tests/notify-regression.js`, `tests/truncate-regression.js` unchanged (they exercise pure functions that didn't change).
- README / CLAUDE.md / AGENTS.md / openclaw.plugin.json / both `skills/*/SKILL.md` / all `commands/*.md` rewritten to reflect the v3 architecture and to describe the agent-task contract.
- `docs/architecture.md`, `docs/WORKFLOW.md`, `docs/setup-flow.md`, `docs/safety.md`, `docs/scheduling.md`, `docs/migration.md` rewritten / updated for v3.
- `docs/url-expander.md` (new), `docs/migration-v2-to-v3.md` (new), `docs/destinations/{linkedin,x,bluesky,threads,facebook}.md` (new) added.
- `examples/pairs.example.json` rewritten to v3 shape (`platform` + `runMode` + `schemaVersion: 3`).
- `.env.example` cut down to just the data-dir override and Telegram-notify fallback. v2's X / LinkedIn / Facebook / Playwright env vars are gone.
- `scripts/install-for-openclaw.sh` updated to reflect v3 (no X auth flow / Playwright profile / browser-login walkthrough; just notify + pair create + schedule).
- Bumped `VERSION` to `3.0.0` in both `package.json` and `src/index.ts`.

### Removed

- All v2 API SDKs and Playwright. **Do not reintroduce.** The architectural sin to avoid.
- The `linkedin-to-x` legacy bin alias from `package.json`.
- The `pair migrate linkedin-to-x` command (auto-migration on read replaces it).

### Migration checklist for v2 users

1. Pull v3.0.0.
2. `npm install` (Playwright + dotenv are removed; commander only).
3. `npm run build`.
4. Run any `pair list` or `pair show` command — auto-migration runs once. Backup at `~/.repost-with-agent/pairs.json.v2.bak`.
5. Log into both source AND destination platforms inside the agent's persistent browser profile (chrome-devtools-mcp's profile or whichever your harness drives). v2's X OAuth tokens are now ignored.
6. Verify `pair history <id>` still shows existing `posted.jsonl` entries.
7. Verify `notify status` reports `source: file` (or `env`).
8. Re-create any `--source-type substack-publication` pairs as a different platform — Substack is dropped from v3 scope.
9. See `docs/migration-v2-to-v3.md`.

### Test results

All 8 regression suites green: `dedupe`, `scheduling`, `backfill`, `notify`, `truncate`, `overlength`, `url-expander`, `agent-task-contract`. No live network or browser interactions.

---

## v2.6.0 — 2026-05-02

### Fixed — LinkedIn pagination cap

- `linkedin-profile-activity` source adapter no longer caps at ~10 items regardless of `--pages N`. Previously `fetchPage` set `hasMore = (allItems.length > start + slice.length)` which evaluated false on page 1 when the slice exactly equaled the loaded count, so the backfill caller (`fetchAllPages`) bailed before ever requesting page 2. The fix bumps the per-call scroll budget to `1 + ⌈totalNeeded / pageSize⌉ * 4` (so `--pages 2 --max 20` triggers ~9 scrolls instead of 6) and reports `hasMore = (slice.length === pageSize)` — i.e. trust the caller's `--pages N` request whenever we filled a full slice. Live `pair backfill linkedin-to-x --dry-run --pages 2 --max 20` now surfaces 20 candidates instead of 10. Fix in `src/adapters/sources/linkedin.ts`.

### Added — Overlength draft strategy

- New optional `maxLength` field on `DestinationAdapter`. Adapters that have a meaningful per-post char cap (X = 280 classic) declare it; adapters that handle threading internally (X Premium auto-thread) MAY omit. See `src/adapters/destination.ts`.
- `pair backfill <id> --overlength-strategy {skip|truncate}` controls what happens at plan time when a draft exceeds `destination.maxLength`:
  - `skip` (default; safer): the candidate is dropped from the publish loop. Plan + audit record `skip-too-long` decision.
  - `truncate`: the draft is smart-shortened with the new `truncate(draft, maxLength)` helper (sentence-boundary → word-boundary → hard-cut, then ellipsis). The truncated draft is what the live publish actually sends; trailing whitespace + leftover punctuation before the ellipsis is stripped.
- New audit events:
  - `pair.backfill.skipped_overlength` — emitted at plan time per skipped candidate, with `pairId`, `sourceItemId`, `draftChars`, `destinationMaxLength`, `strategy`.
  - `pair.backfill.truncated` — emitted at plan time per truncated candidate, with `originalDraftChars` + `truncatedDraftChars`.
  - `pair.backfill.publish.end` for truncated items now records `truncated: true`, `originalDraftChars`, `finalDraftChars`.
  - `pair.backfill.start` and `pair.backfill.plan` carry the chosen `overlengthStrategy` + `destinationMaxLength` for cross-state debugging.
- `BackfillResult.totals` gains `skippedOverlength` + `truncated` counters. CLI text + JSON outputs updated.
- New regression suites:
  - `tests/truncate-regression.js` — 11 sections covering empty input, exact-length match, sub-cap no-op, sentence-boundary cut, word-boundary fallback, hard-cut for single long token, trailing-punctuation strip, output-never-exceeds-cap across multiple cap sizes, `originalChars` tracking, pathological `maxLength <= 1`, multi-sentence cut.
  - `tests/overlength-regression.js` — 5 sections covering: skip-strategy filters at plan time + emits `skipped_overlength` audit; truncate-strategy publishes ≤maxLength output with `truncated: true` flag in `publish.end` audit; no-`maxLength` adapters bypass the strategy; pure-function `buildBackfillPlan` skip + truncate decisions.

### Changed

- Bumped `VERSION` to `2.6.0` in both `package.json` and `src/index.ts`.

## v2.5.0 — 2026-05-01

### Added — Backfill mode

- New `pair backfill <id>` CLI command. Walks back through historical source posts (paginated), cross-checks both `posted.jsonl` AND the destination platform itself for already-posted items, and publishes anything missing on a staggered schedule.
- Default policy: 2 pages, max 20 publishes, 10-minute interval between posts, oldest-first ordering, plan-only unless `--allow-publish` is passed (which requires `pair.mode=live-approved`).
- Source-adapter pagination: new optional `fetchPage(pair, { page, pageSize, cursor })` method. Adapters that don't implement it fall back to single-page `fetchCandidates()`. The LinkedIn adapter scrolls proportionally to the requested page so deeper pages surface more posts.
- Destination-side dedupe: new optional `findExistingPost(draft, pair)` method on `DestinationAdapter`. The X adapter implements it via the `/2/users/:id/tweets` endpoint with fuzzy normalized matching (whitespace-collapse, lowercase, trailing-punctuation strip, ≥80-char prefix overlap). Lookup failures degrade gracefully — they're audit-logged but never block a publish.
- Live progress: one tail-friendly stdout line per state transition (`[backfill] start`, `... fetched ... item(s)`, `... plan: N candidate(s) ...`, `... #K publish.start ...`, `... complete ...`).
- Audit events: `pair.backfill.{start, plan, skip.local, skip.destination, skip.already-in-run, wait, publish.start, publish.end, complete, error}`. Each carries the full context (item id, source URL, destination check result, scheduled-at, posted-at, etc.).
- Idempotent restart: a `~/.repost-with-agent/pairs/<id>/backfill-state.json` file records every publish in the current run. Killing and restarting the backfill picks up where it left off — items already in `posted.jsonl` are filtered at plan time, items recorded in the resume state are skipped with `skip-already-published-in-run`. The state file is removed on clean completion.
- Telegram-on-publish guarantee from the project's non-negotiable notify rule is wired into the backfill publish-success branch (same pattern as `publishNextForPair`).
- New regression suite `tests/backfill-regression.js` (12 assertions across 6 async test cases): plan ordering (oldest-first), pagination boundary, local-dedupe filter, mocked destination-dedupe filter, cap enforcement, idempotent restart, interval scheduling math, auth-failure halts the run.

### Added — Telegram-on-publish notifier (parallel landing)

- New `repost-with-agent notify { configure | status | test }` CLI subcommand for setting up a `~/.repost-with-agent/notify.json` file (mode `0600`) or wiring the `REPOST_TELEGRAM_BOT_TOKEN` + `REPOST_TELEGRAM_CHAT_ID` env vars.
- `notifyPublishSuccess()` is called from every publish path right after destination confirmation + `posted.jsonl` write. Failures are logged + audit-recorded but never roll back the publish.
- New `tests/notify-regression.js`.

### Changed

- Bumped `VERSION` to `2.5.0` in both `package.json` and `src/index.ts`.

## v2.3.0 — 2026-05-01

- Deterministic per-tick `pair scheduled-run <id>` runner with min-delay enforcement.
- `pair schedule <id>` renders launchd plist + crontab line + OpenClaw cron command + direct shell invocation.
- `pair edit`, `pair unschedule` CLI commands.

## v2.2.0 — 2026-04-30

- First end-to-end live `pair post --approve` test — published to https://x.com/REEEthan_YT/status/2050303942857310541.

## Earlier

- Pair-based architecture, source/destination adapters, dedupe layer, audit log, Playwright LinkedIn scrape.
