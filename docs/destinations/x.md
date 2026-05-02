# X (Twitter) destination notes

Per-platform DOM hints for the agent. Read this when fulfilling a `post-to-destination` or `check-destination` task with `platform: "x"`.

## Auth

- Login: persistent browser profile must already have a logged-in `x.com` session.
- The agent CANNOT log in for the user. If the session is expired, return an `error-result` with `category: "needs-login"`.

## URLs

- Compose page: `https://x.com/compose/post` (full-page composer; reliable across logged-in accounts).
- Profile feed: `https://x.com/<handle>` (e.g. `https://x.com/REEEthan_YT`).

## Posting flow (`post-to-destination`)

1. Navigate to `https://x.com/compose/post`.
2. Wait for the textarea (`[data-testid="tweetTextarea_0"]` is the stable selector as of 2026-05).
3. Click into the textarea.
4. Type / paste `draft_text` exactly.
5. Click the Post button (`[data-testid="tweetButtonInline"]` or `[data-testid="tweetButton"]`).
6. Wait for the URL to change to `https://x.com/<handle>/status/<id>` — that's the `posted_url`.
7. Extract the numeric `<id>` for `posted_id`.

## Char cap

- 280 chars (free / classic).
- 25 000 chars (Premium / Verified).

The orchestrator uses 280 by default in `DEFAULT_PLATFORM_MAX_LENGTH`. If the user is on Premium, pass `--overlength-strategy truncate` (no-op for shorter drafts) or set the destination max-length override on the pair.

## Source scraping (`fetch-source`)

- Profile URL: `https://x.com/<handle>`.
- Scroll to load posts. X's timeline virtualization aggressively unmounts off-screen posts, so the agent should scrape as it scrolls (don't rely on all loaded posts being in the DOM).
- Per post, scrape:
  - Post text (`[data-testid="tweetText"]`).
  - Canonical URL: the timestamp `<a>` tag wrapping the relative time link.
  - `publishedAt`: parse the timestamp's `title` or `datetime` attribute.

## Destination dedupe (`check-destination`)

- Navigate to the destination account's profile.
- Scroll to load 50–100 recent posts.
- Compare against `candidate_text` using the same fuzzy logic as v2's X adapter:
  - Strip trailing URL on both sides (X collapses URLs to t.co aliases that won't match the LinkedIn URL).
  - Whitespace-collapse, lowercase, strip trailing punctuation.
  - Exact match OR ≥80-char prefix overlap → `exists: true`.

## Known quirks

- **t.co URL substitution.** X rewrites every URL in posted text to a `t.co/<hash>` alias. This means a post you publish with `https://example.com/article` will show up in the destination scrape as `t.co/abc123`. Strip URLs from both candidate and scraped text before comparing.
- **Threading.** v2 had logic to thread long drafts. v3.0.0 does not — overlength drafts are either skipped (`--overlength-strategy skip`) or truncated (`--overlength-strategy truncate`). Threading can be re-introduced as a per-platform agent skill if needed.
- **Quoted reposts** show up in the profile feed but are typically dedupe-irrelevant; the agent should skip them in `fetch-source` (they're not original content) but treat them like normal posts in `check-destination`.
