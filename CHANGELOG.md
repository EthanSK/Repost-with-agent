# Changelog

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
