---
name: repost-run
description: Run a single Repost-with-agent pair end-to-end — scrape source, dedupe (local + destination), expand URLs, publish via the user's logged-in browser, append history, and Telegram-confirm Ethan. Use when the user asks to "run pair <id>", "post the latest from <pair>", "tick the <pair-id> pair", or invokes /repost-run. Also invoked by the cron / launchd subagent for listen-for-future pairs.
when_to_trigger: User wants to run a single pair manually, OR a scheduled subagent is ticking a listen-for-future pair, OR the user asks to "post the next one from <pair>". Single-post operation.
---

# Repost Run

You are the running agent. This skill instructs you how to do ONE end-to-end
repost: pick the next non-duplicate item from the source, expand any shortened
URLs, post it via the user's logged-in browser, append history, and Telegram-
confirm.

For multi-post historical walks, see `skills/repost-backfill/SKILL.md` instead.

## Required tools

You MUST have these available in the current session:

- **Read, Edit, Write, Bash** — built-in.
- **Browser MCP** — one of `chrome-devtools-mcp` (Claude Code), the OpenClaw
  built-in browser tool, or `claude-in-chrome`. Used to navigate, scrape, and
  click.
- **`plugin:telegram:telegram`** — to send the success confirmation. If the
  Telegram plugin is not loaded in this session, surface the error and stop —
  do not silently skip the confirmation.

If any of these is missing, tell the user which one and stop. Don't try to
substitute curl/Playwright/etc.

## Step 1 — Load pair config

1. Read `~/.repost-with-agent/pairs.json`.
2. Find the requested pair by `id`. If not found, list available ids and stop.
3. Verify `pair.enabled === true`. If false, tell the user the pair is
   disabled and stop.
4. Note `mode`, `runMode`, `source`, `destination`, `policy.maxItemsPerRun`
   (default 1), `policy.overlengthStrategy` (default `"skip"`),
   `policy.blockOnUncertainDuplicate` (default true).

## Step 2 — Decide what we're allowed to do

- If `mode === "preview-only"`: do steps 3–5 (scrape + show draft) but STOP
  before publish. Tell the user what we would have published.
- If `mode === "approval-required"`: do steps 3–6, then ASK the user to
  authorize the post explicitly in chat. Only proceed if they say yes in this
  same conversation.
- If `mode === "live-approved"`: do everything end-to-end. This is the only
  mode the cron / launchd subagent should encounter (the install skill refuses
  to schedule non-live-approved pairs).

## Step 3 — Scrape the source

Use your browser MCP. Per-platform DOM hints live in
`docs/destinations/<platform>.md` — read the matching one before you start.

For platform `linkedin`:

1. Navigate to `pair.source.url` (typically `https://www.linkedin.com/in/<handle>/recent-activity/all/`).
2. Wait for the feed to render. Scroll 1–2 times to load ~10 recent posts.
3. For each post, extract:
   - `sourceItemId` — the activity URN (`urn:li:activity:NNNNNNNN`) parsed
     from the post's data attributes or the canonical URL fragment.
   - `canonicalUrl` — the full `https://www.linkedin.com/feed/update/<urn>/` URL.
   - `text` — the visible post body, in reading order.
   - `publishedAt` — the relative timestamp resolved to ISO-8601.

For platform `x` / `bluesky` / `threads` / `facebook`: see the matching
`docs/destinations/<platform>.md`.

If the page shows a logged-out indicator (login modal, "sign in to continue"
CTA), STOP and tell the user "needs-login on <platform>". Do not try to log
in.

## Step 4 — Dedupe (local + destination)

Use the `repost-dedup` skill semantics. In summary:

1. **Local dedupe.** Read `~/.repost-with-agent/pairs/<id>/posted.jsonl`
   (line-delimited JSON, may be empty). For each candidate from step 3, drop it
   if its `sourceItemId` already appears in any line.
2. **Destination dedupe.** Use the browser MCP to navigate to
   `pair.destination.profileUrl`. Scroll to load ~50–100 recent posts. For each
   *remaining* candidate, fuzzy-match the candidate text against the scraped
   destination posts:
   - Normalize: collapse whitespace, lowercase, strip trailing punctuation,
     strip URLs (X / Bluesky rewrite URLs into shortened aliases that won't
     match the source).
   - Match: exact-normalized OR ≥80-char prefix overlap → duplicate.
3. If `policy.blockOnUncertainDuplicate === true` and you cannot positively
   determine for any reason (page failed to load, content was paywalled,
   etc.), treat the candidate as "uncertain" and SKIP it (do not publish).

## Step 5 — Pick the next item

Filter to items NOT marked as duplicates by step 4. If none remain, write a
`pair.run.no_new_items` line to `~/.repost-with-agent/pairs/<id>/audit.jsonl`
and stop. Tell the user "No new posts to repost from <pair>."

If items remain, pick the **newest** one (highest `publishedAt`). For backfill
runs, see `skills/repost-backfill/SKILL.md`.

## Step 6 — Expand URLs in the draft

Use the `repost-url-expand` skill semantics:

1. Find every URL in the candidate text via regex.
2. For each URL whose host is in the shortener list (`lnkd.in`, `t.co`,
   `bit.ly`, `buff.ly`, `goo.gl`, `tinyurl.com`, `ow.ly`, `is.gd`, `rebrand.ly`,
   `tr.im`), or any URL that returns a 30x: follow redirects up to 5 hops with
   a 5-second timeout per hop using `curl -sIL --max-time 5 -o /dev/null -w '%{url_effective}'` via Bash.
3. Substitute the resolved URL into the draft.
4. If expansion fails for any URL: keep the original (fail-soft). Append
   `pair.publish.url_expand_failed` to audit with the error.
5. Append a `pair.publish.url_expanded` audit event per successful expansion.

Append the source canonical URL at the end of the draft if not already present:
`<draft body>\n\n<pair.source.canonicalUrl>` — this gives the destination post
a backlink and helps with future destination-dedupe.

## Step 7 — Length check

Look up the destination char cap (X = 280 default, X Premium = 25 000, Bluesky
= 300, Threads = 500, LinkedIn = 3 000, Facebook = 63 206). See
`docs/destinations/<platform>.md`.

If the draft exceeds the cap:

- `policy.overlengthStrategy === "skip"`: append a `pair.publish.skipped_overlength` audit event and stop. Tell the user.
- `policy.overlengthStrategy === "truncate"`: shrink to `(cap − 24)` chars,
  append `… <source canonical URL>`. Append `pair.publish.truncated` audit.

## Step 8 — Publish

This is where the running agent drives the user's logged-in browser.

1. Navigate to the destination's compose URL (see `docs/destinations/<platform>.md`).
2. Wait for the textarea / contenteditable.
3. Click into it.
4. Type the draft EXACTLY. Don't paraphrase, don't add hashtags.
5. Click the Post / Share / Tweet button.
6. Wait for the success indicator (URL changes, modal dismisses, toast appears).
7. Capture the resulting `posted_url` (e.g. `https://x.com/<handle>/status/<id>`).
   - For X: the URL changes to `/status/<id>` after posting. Read it from the page.
   - For Bluesky: the toast or feed shows the new post; navigate to your
     profile and grab the topmost post URL.
   - For LinkedIn / Threads / Facebook: see per-platform docs.

If publish fails (login expired, rate limit, platform error):

- Append `pair.publish.failed` audit with `category: "needs-login" | "rate-limit" | "platform-error" | "unknown"`.
- Tell the user what happened.
- Telegram Ethan with the failure (`plugin:telegram:telegram`).
- DO NOT append to `posted.jsonl` (we did not actually post).

## Step 9 — Append history

Append to `~/.repost-with-agent/pairs/<id>/posted.jsonl` ONE line of JSON:

```json
{"ts":"2026-05-01T12:00:00Z","sourceItemId":"urn:li:activity:7000","canonicalSourceUrl":"https://www.linkedin.com/feed/update/urn:li:activity:7000/","destinationUrl":"https://x.com/REEEthan_YT/status/123","destinationId":"123","draftText":"<the exact text we posted>"}
```

Append (DO NOT overwrite). Use `>>` via Bash to be safe:

```bash
echo '<json-line>' >> ~/.repost-with-agent/pairs/<id>/posted.jsonl
```

Append `pair.publish.success` to `audit.jsonl` with the `posted_url`.

## Step 10 — Telegram-confirm Ethan (non-negotiable)

> Every successful post from this plugin MUST trigger a Telegram message to
> Ethan confirming the source and destination URL. Silent publishes are a bug.
> (Ethan voice 5977 + 5978, 2026-05-01.)

Use `plugin:telegram:telegram` `reply` tool. Message format:

```
[Repost-with-agent] ✅ Posted: <pair-id>
Source: <canonical source URL>
→ Destination: <destination URL>
```

If the Telegram send fails:

- Append `pair.publish.notify_failed` audit with the error.
- Tell the user in chat (so the missed ping is replaced).
- DO NOT roll back the post — it's already up.

If you reach this step and Telegram is unconfigured / unavailable, append
`pair.publish.notify_skipped_unconfigured` audit. Treat that as an alert: the
plugin shipped a silent publish. Tell the user immediately.

See `skills/repost-notify/SKILL.md` for the Telegram payload spec.

## Step 11 — Final summary

Print to the user (in the agent transcript, NOT Telegram):

```
✅ Reposted from <pair-id>
  Source:      <canonical source URL>
  Destination: <destination URL>
  Posted at:   <ts>
  Telegram:    delivered
```

## Cron / launchd context

When invoked from a fresh subagent spawned by the cron job:

- The subagent has no chat user. All interactive prompts above are skipped — it
  just runs the pair end-to-end if `mode === "live-approved"`.
- It must still Telegram-confirm Ethan via `plugin:telegram:telegram`.
- It must still append to `posted.jsonl` and `audit.jsonl`.
- After running, the subagent exits. The next cron tick spawns a fresh subagent.

## Error categories

When you hit a failure, append the appropriate audit event and tell the user
which category:

- `needs-login` — destination or source session expired. User must log in via
  the browser MCP profile, then re-run.
- `needs-config` — Telegram not configured, pair config missing required field, etc.
- `rate-limit` — destination platform rejected with a 429 or rate-limit modal.
  Wait and retry later.
- `platform-error` — destination platform error not in the above categories.
  Capture the error text and audit it.
- `unknown` — anything else. Tell the user what you saw.

## See also

- `skills/repost-dedup/SKILL.md` — dedupe algorithm details.
- `skills/repost-url-expand/SKILL.md` — URL expansion details.
- `skills/repost-notify/SKILL.md` — Telegram payload spec.
- `skills/repost-backfill/SKILL.md` — multi-post historical walks.
- `docs/destinations/<platform>.md` — per-platform DOM hints.
- `docs/state-files.md` — formal state-file schemas.
