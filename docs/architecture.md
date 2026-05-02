# Architecture — Repost-with-agent v3.0.0

## TL;DR

Repost-with-agent is **instructions + JSON state**, not a posting framework.

- The CLI is a thin orchestrator that emits typed `AgentTask` JSON and consumes typed `AgentResult` JSON.
- The agent (Claude Code via `chrome-devtools-mcp`, OpenClaw via its built-in browser tool, etc.) drives the user's logged-in browser to do the actual scraping and posting.
- There is **no API path** (no `@atproto/api`, no Threads Graph, no twitter SDK, no facebook-nodejs-business-sdk) and **no Playwright** in `src/`.
- Platform names (`linkedin`, `x`, `bluesky`, `threads`, `facebook`) are free-form string labels in pair config. The agent reads them at task-execution time and picks the right URL templates and DOM selectors.

This is a deliberate architectural choice (Ethan voice 6016, 2026-05-01) — the v2 codebase had 800+ LOC of platform-specific API + Playwright code that was a maintenance burden, broke whenever a platform shipped a redesign, and introduced a parallel browser stack on a machine that already had `chrome-devtools-mcp` available.

## Why not Playwright?

The agent already has its own browser MCP. Driving a *second* browser stack from `src/` means:

- A separate persistent profile dir → the user has to log in twice.
- `npm install` ships a 200 MB Playwright bundle.
- Every platform redesign breaks two stacks instead of one.
- The agent's MCP is more tolerant (DOM-aware, retries, screenshots, etc.) than a hand-rolled Playwright loop.

By delegating to the agent's MCP, the same login the user maintains for ad-hoc browsing IS the login the reposting tool uses.

## Why not platform APIs?

API SDKs imply auth, rate limits, char-limit nuance per tier (X 280 / 25k, etc.), and "preferred official path" forks. Each one is a separate runtime dependency and a separate failure mode.

Browser-driven posting:

- Always uses the user's actual logged-in tier (Premium / Verified / etc.) — no API tier mismatch.
- Same UX as if the user posted manually.
- No API key / OAuth flow / refresh-token plumbing.
- Same code path for every platform.

The trade-off is speed (a browser post is ~5–15 seconds; an API call is ~1) — acceptable for cross-posting at scale of ones-of-posts-per-day.

## The agent-task contract

Defined in `src/core/agent-task-contract.ts`. Three task kinds + four result kinds, all sharing a `correlation_id`:

```typescript
type AgentTask =
  | { kind: "fetch-source",       platform, source_url, max_items, page?, cursor?, correlation_id, pair_id }
  | { kind: "post-to-destination", platform, destination_account, draft_text, source_url?, correlation_id, pair_id }
  | { kind: "check-destination",   platform, destination_account, candidate_text, correlation_id, pair_id };

type AgentResult =
  | { kind: "fetch-source-result",        correlation_id, items, hasMore?, nextCursor?, auth_message? }
  | { kind: "post-to-destination-result", correlation_id, posted_url, posted_id?, posted_at }
  | { kind: "check-destination-result",   correlation_id, exists, url?, posted_id?, postedAt?, reason? }
  | { kind: "error-result",               correlation_id, error, category? };
```

The `correlation_id` lets the orchestrator route many concurrent tasks without ambiguity.

## Two delivery modes

The same orchestrator code can hand a task to the agent two ways:

1. **In-process handler.** The caller (test or inline-driven CLI) supplies a `taskHandler: (task) => Promise<result>` callback. No filesystem I/O. Used by every regression test.

2. **Inbox-style.** The CLI writes the task to `~/.repost-with-agent/agent-tasks/<correlation_id>.task.json`, prints a stdout banner, and polls for `<correlation_id>.result.json`. The agent's `repost-run` skill is responsible for picking up the task and writing the result.

The runner picks based on whether `options.handler` is passed. See `src/core/agent-runner.ts`.

## Module map

```
src/
  config.ts              # Data-dir + agent-tasks dir resolution. No more Playwright/X env.
  index.ts               # CLI entry. commander-based subcommands.
  core/
    agent-task-contract.ts  # AgentTask/AgentResult types + inbox file helpers.
    agent-runner.ts         # In-process or inbox-poll task dispatch.
    backfill.ts             # runBackfill — newest-first walk-back; per-candidate fetch/check/post tasks.
    dedupe.ts               # contentHash, decidePreviewStatus, summarizeText. Pure functions.
    notify.ts               # notifyPublishSuccess + Telegram bot HTTP. Non-negotiable.
    orchestrator.ts         # previewPair, publishNextForPair, buildDraftForItem (with URL expansion).
    policy.ts               # DEFAULT_POLICY + normalizePolicy.
    runtime.ts              # pairs.json, posted.jsonl, audit.jsonl, learnings.md helpers + v2→v3 migration.
    scheduling.ts           # runScheduled + launchd plist / crontab line / openclaw cron renderers.
    truncate.ts             # Smart-shorten helper. Pure function.
    types.ts                # PairRecord, PairEndpoint, SourceItem, DraftPost, AuditEvent.
    url-expander.ts         # Follow shortener redirects. 5-hop, 5-second, fail-soft.
```

## Per-pair state on disk

```
~/.repost-with-agent/
  pairs.json                  # The full PairRecord[] store.
  pairs.json.v2.bak           # One-shot v2 → v3 backup (only if migration ran).
  notify.json                 # Telegram bot token + chat id (mode 0600).
  agent-tasks/                # Inbox-style task delivery.
    <correlation_id>.task.json
    <correlation_id>.result.json
  pairs/<id>/
    state.json                # Free-form per-pair state (rare).
    audit.jsonl               # NDJSON audit events.
    findings.jsonl            # NDJSON agent findings (rare).
    drafts.jsonl              # NDJSON draft history (rare).
    posted.jsonl              # NDJSON posted history — the source of truth for dedupe.
    backfill-state.json       # Resume state during a multi-tick backfill.
    learnings.md              # Free-form notes the agent loads each run.
    logs/                     # launchd stdout/stderr.
```

## How a `pair preview <id>` runs end-to-end

1. CLI loads pair from `pairs.json`.
2. Orchestrator generates a `correlation_id` and emits a `fetch-source` task.
3. The agent (you) reads the task, navigates the user's logged-in browser to `pair.source.url`, scrapes posts, writes a `fetch-source-result`.
4. Orchestrator passes the items through `decidePreviewStatus()` (dedupe vs `posted.jsonl`) and `buildDraftForItem()` (URL expansion + canonical-URL append).
5. CLI prints the draft + decision per item.

No live posting; no Telegram notify; the audit log records `pair.preview` with the candidate count.

## How a `pair post <id> --approve` runs end-to-end

1. CLI loads pair, emits `fetch-source` task, agent fulfils it (same as preview).
2. Orchestrator runs full preview path; checks `pair.mode != preview-only` and `--approve` flag.
3. Re-runs `decidePreviewStatus` against fresh `posted.jsonl` (race-safe).
4. Enforces `--overlength-strategy` against the platform's default char cap (X=280, Bluesky=300, Threads=500, Facebook=63206, LinkedIn=3000).
5. Audit-logs each URL expansion that happened in step 1's draft build.
6. Emits `post-to-destination` task with the final `draft_text`.
7. Agent navigates to compose page, fills text, clicks submit, returns `posted_url` + `posted_at`.
8. CLI appends to `posted.jsonl`, audit-logs `pair.publish.success`, fires `notifyPublishSuccess()` (Telegram).
9. Notify outcome is itself audit-logged: `notify.publish.success` or `notify.publish.failure` + `pair.publish.notify_failed`, or `pair.publish.notify_skipped_unconfigured` if notify is unwired.

## How a `pair backfill <id> --allow-publish` runs end-to-end

1. `fetchAllPages` emits N `fetch-source` tasks with `page` and `cursor`.
2. Plan builder dedupes across pages, orders **newest-first** (Ethan voice 6021), filters local matches, applies overlength strategy.
3. For each candidate not skipped at plan time:
   a. Emit `check-destination` task — agent scrapes destination, fuzzy-matches.
   b. If `exists`, log `pair.backfill.skip.destination`, append a `posted.jsonl` entry with `importedFrom: "backfill-destination-dedupe"`, continue.
   c. Wait until `scheduledAt` (interval-paced).
   d. Emit `post-to-destination` task — agent posts, returns URL.
   e. Append to `posted.jsonl`, fire Telegram notify, write resume state.

The resume state file lets a killed backfill restart from where it left off without double-posting.

## How `pair scheduled-run <id>` runs (the listen-for-future path)

The host scheduler (OpenClaw cron / launchd / system cron) invokes this command at the configured cadence. The runner:

1. Checks `pair.enabled`.
2. If `--allow-publish` AND `pair.mode === "live-approved"` AND min-delay window is open: delegates to `publishNextForPair` (preview→post→notify).
3. Otherwise: runs preview-only and reports the candidate without acting.

Every tick writes `pair.scheduled.start` + `pair.scheduled.end` audit events with the outcome taxonomy: `preview-only | no-candidate | duplicate | uncertain-blocked | min-delay | blocked-mode | needs-approval | auth-failed | publish-failed | overlength-blocked | published`.

## URL expansion

Before any draft is shown to the agent (preview, post, backfill), `expandUrlsInText()` is called over the body. Every URL is followed through redirects:

- Max 5 hops.
- 5-second timeout per request.
- HEAD first, fall back to GET on 405/501.
- Loop detection (URL appears twice in chain).
- Fail-soft: on timeout, network error, or hop-limit, the original URL is preserved.

Each successful expansion fires a `pair.publish.url_expanded` audit event with `{shortenedUrl, expandedUrl, hopCount}`. See `docs/url-expander.md`.

## Telegram-on-publish

Non-negotiable rule (Ethan voice 5977/5978). Every successful publish path calls `notifyPublishSuccess()` AFTER the agent confirms AND AFTER `posted.jsonl` is appended. Failures never roll back the publish. See `src/core/notify.ts`.

## Why not API SDKs back?

The v3 architectural sin to avoid is reintroducing per-platform API code. The whole point of v3 is that the agent's browser MCP IS the platform integration. If a future platform requires an API (e.g. some destination only allows OAuth-app posting, not browser posting), implement it as an `agent-task` skill — the agent does the API call out-of-band — not as a TypeScript SDK linked into `src/`.
