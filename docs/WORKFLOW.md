# Repost-with-agent — end-to-end workflow (v3.0.0)

This is the definitive walkthrough of how Repost-with-agent actually runs in v3.0.0, from one-time setup to a live `pair post --approve`. It complements [architecture.md](architecture.md) (the layer model) and [setup-flow.md](setup-flow.md) (the conversational pair-creation script).

## Mental model in one sentence

Repost-with-agent saves named **pairs** of `(source platform → destination platform, policy, schedule, run-mode)`. The CLI is a thin orchestrator over JSON state; the **agent** drives the user's logged-in browser via its own browser MCP to do the actual reposting. Every preview is read-only. Every publish requires `--approve` plus a non-`preview-only` mode plus a clean dedupe re-check.

## Non-negotiable rule — Telegram-confirm every successful publish

> Every successful post from this tool MUST trigger a Telegram message to Ethan confirming what was posted, the source URL, and the destination URL. The CLI does this automatically via the configured `notify.telegram` channel. If you are an agent operating on this repo and you trigger a publish through any non-CLI path you MUST also fire a Telegram confirmation. Silent publishes are a bug. (Ethan voice 5977 + 5978, 2026-05-01.)

```bash
repost-with-agent notify configure --bot-token <T> --chat-id <C> --test
```

## One-time setup

### Prereqs

- Node 18+
- An agent harness with a working browser MCP:
  - **Claude Code**: `chrome-devtools-mcp` or `claude-in-chrome` plugin connected.
  - **OpenClaw**: built-in browser tool enabled.
- The user logged into source AND destination platforms inside the agent's persistent browser profile. The agent CANNOT log in for the user.

### Install

```bash
git clone https://github.com/EthanSK/Repost-with-agent.git
cd Repost-with-agent
./scripts/install-for-openclaw.sh    # works for Claude Code too
```

The script: runs `npm install` (commander only — no Playwright, no API SDKs), builds the TypeScript, smoke-tests `repost-with-agent --version`, ensures `~/.repost-with-agent/` exists, prints the OpenClaw plugin manifest path.

### Wire up Telegram notify (do this first)

```bash
repost-with-agent notify configure --bot-token <TELEGRAM_BOT_TOKEN> --chat-id <CHAT_ID> --test
repost-with-agent notify status     # MUST report `Resolved source: file` (or `env`)
```

If the test message doesn't land, fix this BEFORE flipping any pair to live.

## Creating a pair

```bash
repost-with-agent pair create \
  --source-platform linkedin \
  --source-url "https://www.linkedin.com/in/<you>/recent-activity/all/" \
  --destination-platform x \
  --destination-account "@<your-handle>" \
  --run-mode listen-for-future \
  --mode preview-only
```

Pair lands in `~/.repost-with-agent/pairs.json` with `enabled: false`, `mode: preview-only`. This is intentional. Don't flip without explicit user authorization.

Supported `--source-platform` and `--destination-platform` values: `linkedin`, `x`, `bluesky`, `threads`, `facebook`. The fields are free-form strings, so adding a new platform later is a matter of writing `docs/destinations/<platform>.md` and teaching the agent the URL templates.

## Preview a pair

```bash
repost-with-agent pair preview <id>
```

What happens:

1. CLI loads `pair`. Resolves the source platform.
2. Orchestrator generates a `correlation_id` and emits a stdout banner:
   ```
   [agent-task fetch-source] platform=linkedin source_url=https://... max_items=1 correlation_id=fetch-<id>-<hex>
   [agent-task] task_file=~/.repost-with-agent/agent-tasks/<correlation_id>.task.json
                result_file=~/.repost-with-agent/agent-tasks/<correlation_id>.result.json
   [agent-task] waiting up to 300000ms for result...
   ```
3. The agent (you) reads the task file, navigates the user's logged-in browser to the LinkedIn `/recent-activity/all/` URL, scrolls to load N posts, scrapes post text + canonical URL, writes:
   ```json
   {
     "kind": "fetch-source-result",
     "correlation_id": "fetch-<id>-<hex>",
     "items": [
       { "sourceItemId": "urn:li:activity:7000", "canonicalUrl": "https://www.linkedin.com/feed/update/urn:li:activity:7000/", "text": "Sample post body...", "publishedAt": "2026-05-01T12:00:00.000Z" }
     ],
     "auth_message": "linkedin: logged in as <user>"
   }
   ```
4. CLI consumes the result, runs `decidePreviewStatus` (against `posted.jsonl`), and `buildDraftForItem` (URL expansion + canonical-URL append).
5. Output:
   ```
   1. NEW - No exact prior match found in pair history.
      Source: https://www.linkedin.com/feed/update/urn:li:activity:7000/
      Text: Sample post body...
      Draft: Sample post body...

      https://www.linkedin.com/feed/update/urn:li:activity:7000/
      Warnings: (none)
   ```

If the agent returns `kind: "error-result"`, the orchestrator logs `pair.preview.fetch_failed` and the preview returns no items.

## Live publish a pair

```bash
repost-with-agent pair edit <id> --mode live-approved --enable
repost-with-agent pair post <id> --approve
```

What happens (in addition to the preview steps):

1. Re-checks `pair.mode != preview-only` and `--approve` flag.
2. Re-runs `decidePreviewStatus` against fresh `posted.jsonl` (race-safe).
3. Applies `--overlength-strategy` (default `skip`; pass `--overlength-strategy truncate` to opt in to smart truncation).
4. Audit-logs each URL expansion with `pair.publish.url_expanded`.
5. Emits a `post-to-destination` task:
   ```
   [agent-task post-to-destination] platform=x destination_account=@<handle> draft_chars=NNN correlation_id=post-<id>-<hex>
   ```
6. Agent navigates to the destination's compose page (`https://x.com/compose/post`), fills `draft_text` exactly, clicks Post, waits for the success indicator, returns:
   ```json
   {
     "kind": "post-to-destination-result",
     "correlation_id": "post-<id>-<hex>",
     "posted_url": "https://x.com/<handle>/status/12345",
     "posted_id": "12345",
     "posted_at": "2026-05-02T12:00:00.000Z"
   }
   ```
7. CLI appends a `posted.jsonl` entry, writes `pair.publish.success`, fires `notifyPublishSuccess` (Telegram).
8. Notify outcome is audit-logged: `notify.publish.success`, `notify.publish.failure` + `pair.publish.notify_failed`, or `pair.publish.notify_skipped_unconfigured`.

## Backfill (newest-first walk-back)

```bash
# Plan-only first:
repost-with-agent pair backfill <id> --pages 2 --max 20 --interval-minutes 10 --dry-run

# Live publish:
repost-with-agent pair backfill <id> --pages 2 --max 20 --interval-minutes 10 --allow-publish
```

What happens:

1. CLI emits N `fetch-source` tasks (one per page) with `page` and optional `cursor`.
2. Agent scrapes each page; CLI deduplicates across pages, orders **newest-first** (v3.0.0; was oldest-first in v2 — Ethan voice 6021).
3. Plan filters local matches (`posted.jsonl`), applies overlength strategy (`skip` or `truncate`), caps at `--max`.
4. For each candidate:
   a. Emit `check-destination` task — agent scrapes destination, fuzzy-matches.
   b. If exists, log `pair.backfill.skip.destination`, append a `posted.jsonl` entry, skip.
   c. Wait until `scheduledAt`.
   d. Emit `post-to-destination` task.
   e. Append to `posted.jsonl`, fire Telegram notify, write `backfill-state.json`.

Idempotent: re-running picks up where it left off (resume state survives kills).

## Listen-for-future (continuous tail)

```bash
repost-with-agent pair edit <id> --run-mode listen-for-future --schedule-kind cron --schedule-expression "0 */2 * * *" --timezone Europe/London
repost-with-agent pair schedule <id> --apply launchd
launchctl load ~/Library/LaunchAgents/com.repost-with-agent.<id>.plist
```

The host scheduler now invokes `repost-with-agent pair scheduled-run <id>` at the configured cadence. By default the tick is preview-only — pass `--allow-publish` (and `pair.mode=live-approved`) to actually publish. See `docs/scheduling.md`.

## State and audit log locations

```
~/.repost-with-agent/pairs.json                              # All pair configs
~/.repost-with-agent/notify.json                             # Telegram bot token (mode 0600)
~/.repost-with-agent/agent-tasks/<correlation_id>.task.json   # CLI → agent
~/.repost-with-agent/agent-tasks/<correlation_id>.result.json # agent → CLI
~/.repost-with-agent/pairs/<id>/posted.jsonl                 # Source of truth for dedupe
~/.repost-with-agent/pairs/<id>/audit.jsonl                  # All `pair.*` events
~/.repost-with-agent/pairs/<id>/backfill-state.json          # Resume state (only during backfill)
~/.repost-with-agent/pairs/<id>/learnings.md                 # Free-form notes
~/.repost-with-agent/pairs/<id>/logs/scheduled.{out,err}.log # launchd stdout/stderr
```

## Audit event taxonomy

- `pair.created` / `pair.edited` — config mutations.
- `pair.preview` — the orchestrator emitted a preview successfully.
- `pair.preview.fetch_failed` — agent returned an error result.
- `pair.publish.needs-approval` / `pair.publish.skipped` / `pair.publish.blocked-by-mode` — refusals.
- `pair.publish.url_expanded` — a shortener was followed before publish (`{shortenedUrl, expandedUrl, hopCount}`).
- `pair.publish.overlength-blocked` / `pair.publish.truncated` — char-cap enforcement decisions.
- `pair.publish.success` — destination confirmed.
- `pair.publish.failed` / `pair.publish.auth-failed` — agent reported error.
- `notify.publish.success` / `notify.publish.failure` / `pair.publish.notify_failed` / `pair.publish.notify_skipped_unconfigured` — Telegram path.
- `pair.scheduled.start` / `pair.scheduled.end` — every scheduled tick.
- `pair.backfill.{start, plan, skip.local, skip.destination, skip.already-in-run, wait, publish.start, publish.end, complete, error}` — backfill mode.
- `pair.backfill.skipped_overlength` / `pair.backfill.truncated` — overlength decisions in the backfill plan.

## Common operational gotchas

- **`pair preview` hangs.** The CLI is waiting for an agent result. If you're running the CLI from a terminal where no agent is listening, the inbox-mode timeout (5 min) will fire and emit a `pair.preview.fetch_failed` audit event. Either run the CLI from inside the agent's session OR write the expected result file manually.
- **`notify status` reports `none`.** Wire it up: `repost-with-agent notify configure --bot-token <T> --chat-id <C> --test`. Until it does, every live publish will print a loud WARN and write `pair.publish.notify_skipped_unconfigured`.
- **Backfill keeps publishing duplicates.** Check `posted.jsonl` and `backfill-state.json`. The `check-destination` task may be returning false negatives if the agent's fuzzy match is too strict. Consider widening `candidate_text` normalization in the skill.
- **launchd plist doesn't fire.** Verify `pair.schedule.kind` is `cron` or `every` (not `manual`). Manual schedules deliberately omit StartCalendarInterval. See `docs/scheduling.md`.

## Worked example: dry run from the test suite

```typescript
import { previewPair } from "./dist/core/orchestrator.js";

const pair = { /* ... */ };
const handler = async (task) => {
  if (task.kind === "fetch-source") {
    return {
      kind: "fetch-source-result",
      correlation_id: task.correlation_id,
      items: [{ sourceItemId: "src-1", canonicalUrl: "https://...", text: "..." }],
    };
  }
};
const result = await previewPair(pair, { agent: { handler }, skipUrlExpand: true });
console.log(result.items[0].draft.text);
```

This is exactly how `tests/agent-task-contract-regression.js` exercises the orchestrator end-to-end — no browser, no network, no Playwright. The same `previewPair` function with no `agent.handler` will instead use the inbox-mode path.
