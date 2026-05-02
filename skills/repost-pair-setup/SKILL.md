# Repost Pair Setup

Use this skill when the user wants to create or save a repost source → destination pair for Repost-with-agent / repost_with_agent.

## Goals

- Ask for source platform first, then destination platform.
- Keep new pairs `preview-only` by default.
- Use CLI commands instead of inventing state manually.
- Never ask for passwords in chat.
- **Wire up the Telegram-on-publish notifier before any pair flips to live — non-negotiable.**

## v3.0.0 architecture in one sentence

Repost-with-agent is **instructions for an agent**, not a posting framework. The CLI is a thin orchestrator over JSON state. The agent (Claude Code via `chrome-devtools-mcp`, OpenClaw via its built-in browser tool) drives the user's logged-in browser to do the actual posting. There is **no** API path and **no** Playwright in this codebase.

Supported platforms in v3.0.0: **LinkedIn, X, Bluesky, Threads, Facebook**. Platform names are free-form string labels in pair config; the agent reads them and picks the right URL templates and DOM selectors at task-execution time.

## Telegram-confirm every successful publish — non-negotiable

> Every successful post from this tool MUST trigger a Telegram message to Ethan confirming what was posted, the source URL, and the destination URL. The CLI does this automatically via the configured `notify.telegram` channel. If you are an agent operating on this repo and you trigger a publish through any non-CLI path (direct API call, scripted action, etc.) you MUST also fire a Telegram confirmation. Silent publishes are a bug. (Ethan voice 5977 + 5978, 2026-05-01.)

Setup-time checkpoint (do this BEFORE the first live run):

```bash
repost-with-agent notify configure --bot-token <TELEGRAM_BOT_TOKEN> --chat-id <CHAT_ID> --test
```

Then `repost-with-agent notify status` should report `Resolved source: file` (or `env`) — never `none`.

## Conversation flow

1. Ask what source **platform** + URL/account to mirror (`linkedin`, `x`, `bluesky`, `threads`, `facebook`).
2. Ask the destination **platform** + account.
3. Ask whether the user wants `preview-only`, `approval-required`, or `live-approved`.
4. Ask for `runMode`: `listen-for-future` (default — tail new posts via the host scheduler) or `backfill` (walk back through history newest-first).
5. Ask for a pair name and schedule preference.
6. Create the pair:

   ```bash
   repost-with-agent pair create \
     --source-platform <linkedin|x|bluesky|threads|facebook> \
     --source-url "<profile or recent-activity URL>" \
     --destination-platform <linkedin|x|bluesky|threads|facebook> \
     --destination-account "@<handle>" \
     --run-mode listen-for-future \
     --mode preview-only
   ```

7. Confirm the user has logged into both source AND destination platforms inside the agent's persistent browser profile (the agent CANNOT log in for the user — see `docs/migration-v2-to-v3.md` for the per-machine profile path).
8. Run `repost-with-agent pair preview <id>` immediately. The CLI will emit one or more `[agent-task fetch-source ...]` banners — the agent (you) reads each task and invokes its browser MCP to fulfil it.
9. **Run `repost-with-agent notify configure --bot-token <T> --chat-id <C> --test` if it's the first install on this machine.** Without this, live publishes will print a loud WARN and write a `pair.publish.notify_skipped_unconfigured` audit event but the post WILL still go out — that's a project bug, not a feature. Wire it up.
10. Explain that pair history/learnings persist under `~/.repost-with-agent/pairs/<id>/`.

## Agent-task contract (what the CLI hands you)

When you run a pair command, the orchestrator will need three task kinds. Each carries a `correlation_id` you must echo back in the matching result.

### `fetch-source`

```json
{
  "kind": "fetch-source",
  "platform": "linkedin",
  "source_url": "https://www.linkedin.com/in/ethansk/recent-activity/all/",
  "max_items": 10,
  "page": 1,
  "correlation_id": "fetch-...-abcd1234",
  "pair_id": "linkedin-to-x"
}
```

You should:

1. Use your browser MCP to navigate to `source_url`.
2. Scroll until enough posts are loaded for the requested `max_items`.
3. Scrape post text + canonical URL + (optional) `publishedAt` for each post.
4. Write a `fetch-source-result` to `~/.repost-with-agent/agent-tasks/<correlation_id>.result.json` (or stdout, depending on how the CLI was launched):

```json
{
  "kind": "fetch-source-result",
  "correlation_id": "fetch-...-abcd1234",
  "items": [
    { "sourceItemId": "urn:li:activity:7000", "canonicalUrl": "...", "text": "...", "publishedAt": "2026-05-01T12:00:00.000Z" }
  ],
  "hasMore": true,
  "auth_message": "linkedin: logged in as ethansk"
}
```

### `post-to-destination`

```json
{
  "kind": "post-to-destination",
  "platform": "x",
  "destination_account": "@REEEthan_YT",
  "draft_text": "<URL-expanded body, with canonical source URL appended>",
  "source_url": "https://www.linkedin.com/feed/update/...",
  "correlation_id": "post-...-abcd1234",
  "pair_id": "linkedin-to-x"
}
```

You should:

1. Navigate to the destination's compose page (`https://x.com/compose/post`, `https://bsky.app/`, etc.).
2. Fill the textarea with `draft_text` exactly — do NOT modify it. URL expansion has already been applied; truncation has already been applied.
3. Click Post / Share / Tweet.
4. Wait for the success indicator (the post URL appearing).
5. Write a `post-to-destination-result`:

```json
{
  "kind": "post-to-destination-result",
  "correlation_id": "post-...-abcd1234",
  "posted_url": "https://x.com/REEEthan_YT/status/12345",
  "posted_id": "12345",
  "posted_at": "2026-05-01T12:00:00.000Z"
}
```

If posting fails, write an `error-result` with a `category` field (`needs-login`, `needs-config`, `rate-limit`, `platform-error`, `unknown`):

```json
{
  "kind": "error-result",
  "correlation_id": "post-...-abcd1234",
  "error": "x.com login session expired",
  "category": "needs-login"
}
```

### `check-destination`

```json
{
  "kind": "check-destination",
  "platform": "x",
  "destination_account": "@REEEthan_YT",
  "candidate_text": "<the draft text we are about to publish>",
  "correlation_id": "check-...-abcd1234",
  "pair_id": "linkedin-to-x"
}
```

You should:

1. Navigate to the destination account's profile.
2. Scroll to load 50–100 recent posts.
3. Scrape post text + URLs.
4. Fuzzy-match `candidate_text` against the scraped posts (whitespace-collapse, lowercase, strip trailing punctuation, prefix-match ≥80 chars).
5. Write a `check-destination-result`:

```json
{
  "kind": "check-destination-result",
  "correlation_id": "check-...-abcd1234",
  "exists": true,
  "url": "https://x.com/REEEthan_YT/status/12340",
  "posted_id": "12340",
  "postedAt": "2026-04-30T09:00:00.000Z",
  "reason": "Prefix match ≥80 chars."
}
```

If you can't determine, return `{exists: false, reason: "..."}` — the orchestrator treats lookup failures as "unknown" and proceeds with the publish (Ethan would rather see a near-duplicate than miss a post).

## First supported example

- Source platform: `linkedin`
- Destination platform: `x`

## Safety

- Preview first.
- No live posting during setup.
- No stealth, CAPTCHA bypass, 2FA bypass, or anti-detection guidance.
- Browser automation is only ever for transparent user-controlled login sessions.
- See `docs/safety.md` for the full safety contract.
