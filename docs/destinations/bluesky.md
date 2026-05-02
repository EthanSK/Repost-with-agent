# Bluesky destination notes

Per-platform DOM hints for the running agent. Read this BEFORE you start a
`repost-run` / `repost-backfill` step that touches Bluesky (either as source
or destination).

> **These hints are STARTING points.** The pair-level
> `~/.repost-with-agent/pairs/<id>/learnings.md` may extend or override
> anything here as the agent discovers quirks specific to Ethan's account
> or a recent Bluesky UI change (PDS-specific behavior, the React Native
> Web composer moving, etc.).
>
> **Read order: learnings.md FIRST, this doc second.** Specifically, scan
> the most-recent learnings entry's `### Selectors` and `### Step
> playbook` sub-sections and try them verbatim before falling back to the
> defaults below. The per-pair file wins on conflict — it reflects the
> most recent observed behavior. Only fall back to this doc when
> learnings.md is silent on the step you need, or when a cached selector
> fails to match the live DOM (in which case capture the updated
> selector in a new learnings entry at end of run). See
> `skills/repost-learnings/SKILL.md` for the entry shape + read-priority
> rules.

## Auth

- Login: the browser MCP profile must already have a logged-in `bsky.app`
  session (or whichever PDS the user is on).
- App passwords are only relevant for the AT Protocol API path, which v4.0.0
  does NOT use. Browser session is enough.
- If session is expired, append `pair.publish.failed` audit with `category:
  "needs-login"` and stop.

## URLs

- Compose: home page `https://bsky.app/` has a "New Post" button at top-left; OR navigate to `https://bsky.app/compose` if Bluesky exposes a direct compose URL (not all PDSs do).
- Profile feed: `https://bsky.app/profile/<handle>` (e.g. `https://bsky.app/profile/ethansk.bsky.social`).

## Posting flow

1. Navigate to `https://bsky.app/`.
2. Click the "New Post" / `+` button (top-left in the app shell).
3. Wait for the compose modal — textarea is the focused element by default.
4. Type / paste `draft_text` exactly.
5. Click the "Post" button in the modal (visible label "Post").
6. Wait for the modal to close. Bluesky doesn't auto-navigate to the new post — to capture `posted_url`, navigate to `https://bsky.app/profile/<handle>` and grab the topmost post link.

## Char cap

- 300 chars (graphemes, not bytes — but in practice 300 chars is the safe bet).

## Source scraping

- Profile URL: `https://bsky.app/profile/<handle>`.
- Scroll to load posts. Bluesky uses an infinite-scroll list similar to X.
- Per post, scrape:
  - Post text (the main text content of each post card).
  - Canonical URL: `https://bsky.app/profile/<handle>/post/<rkey>` — extractable from the post's permalink/timestamp `<a>` tag.
  - `publishedAt`: parse the visible relative timestamp.

## Destination dedupe

For destination dedupe on Bluesky:

- Navigate to `https://bsky.app/profile/<handle>`.
- Scroll to load 50–100 recent posts.
- Compare against `candidate_text` using the `repost-dedup` skill's algorithm.

## Known quirks

- **Reposts** (Bluesky's "Repost" / quote-post) appear in the profile feed.
  Skip them in source scrape — only return original posts.
- **Embedded URL cards** auto-generate when you paste a URL. The card is part
  of the rendered post but the source `text` is just the URL — preserve as-is.
- **Hashtags** become `#tag` clickable text. Plain text travels fine.
- **Replies** are rendered as part of a thread on the profile feed. Skip them
  — only top-level posts.

## DOM stability

Bluesky is React Native Web; selectors are less stable than X. Prefer
accessible-role queries (`role="button"`, `aria-label="New post"`) over CSS
selectors.
