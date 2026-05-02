# Changelog

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
