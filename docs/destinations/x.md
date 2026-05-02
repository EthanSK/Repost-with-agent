# X (Twitter) destination notes

Per-platform DOM hints for the running agent. Read this BEFORE you start a
`repost-run` / `repost-backfill` step that touches X (either as source or
destination).

> **These hints are STARTING points.** The pair-level
> `~/.repost-with-agent/pairs/<id>/learnings.md` may extend or override
> anything here as the agent discovers quirks specific to Ethan's account or
> a recent X UI change. Always read the pair's `learnings.md` before
> applying these defaults — the per-pair file wins on conflict, since it
> reflects the most recent observed behavior. See
> `skills/repost-learnings/SKILL.md`.

## Auth

- Login: the browser MCP profile must already have a logged-in `x.com`
  session. The agent cannot log in for the user. If the session is expired,
  append `pair.publish.failed` audit with `category: "needs-login"` and stop.

## URLs

- Compose: `https://x.com/compose/post` — full-page composer; reliable across
  logged-in accounts.
- Profile feed: `https://x.com/<handle>` (e.g. `https://x.com/REEEthan_YT`).

## Posting flow

1. Navigate to `https://x.com/compose/post`.
2. Wait for the textarea: `[data-testid="tweetTextarea_0"]` (stable selector
   as of 2026-05).
3. Click into it.
4. Type the draft body EXACTLY.
5. Click the Post button: `[data-testid="tweetButtonInline"]` or
   `[data-testid="tweetButton"]`.
6. Wait for the URL to change to `https://x.com/<handle>/status/<id>`.
7. Extract the numeric `<id>` for `destinationId`. Capture the full URL as
   `destinationUrl`.

## Char cap

- Free / classic accounts: 280 chars.
- Premium / Verified: 25 000 chars.

The default in the `repost-run` length check is 280. If the user is on
Premium, set the per-pair `policy.overlengthStrategy: "truncate"` or override
the cap explicitly.

## Source scraping

- Profile URL: `https://x.com/<handle>`.
- Scroll to load posts. X's timeline virtualizes aggressively and unmounts
  off-screen posts — **scrape as you scroll**, don't rely on all loaded posts
  being in the DOM after several scrolls.
- Per post, scrape:
  - **Body**: `[data-testid="tweetText"]`.
  - **Canonical URL**: the timestamp `<a>` tag wrapping the relative-time link
    (resolve to absolute URL).
  - **`publishedAt`**: parse the timestamp's `title` or `datetime` attribute.
  - **`sourceItemId`**: the numeric ID from the URL.

Skip retweets (they have a "<user> reposted" indicator above the tweet) when
fetching as a source. They're not original content.

## Destination dedupe

For destination dedupe on X:

- Navigate to the destination account profile.
- Scroll to load 50–100 recent posts.
- Compare against `candidate_text` using the `repost-dedup` skill's algorithm.
  **Important**: strip URLs from BOTH sides before comparing — X rewrites
  every URL into a `t.co/<hash>` alias that won't match the LinkedIn /
  Bluesky / etc. source URL.

## Known quirks

- **`t.co` URL substitution.** X rewrites every URL in posted text to a
  `t.co/<hash>` alias. A post you publish with `https://example.com/article`
  shows up in the destination scrape as `t.co/abc123`. Strip URLs from both
  candidate and scraped text before comparing.
- **Threading.** Long drafts can't be threaded automatically in v4 —
  overlength drafts are either skipped (`overlengthStrategy: "skip"`) or
  truncated (`"truncate"`). Re-introduce threading as a separate skill if
  needed.
- **Quoted reposts.** Show up in the profile feed but are dedupe-irrelevant.
  Skip them in source scrape (they're not original content); treat them like
  normal posts in destination dedupe.
- **Login walls.** X sometimes shows a login modal even for logged-in users
  on certain endpoints. Detect and bail with `category: "needs-login"`.
