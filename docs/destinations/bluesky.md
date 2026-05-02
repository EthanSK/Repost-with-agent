# Bluesky destination notes

Per-platform DOM hints for the agent. Read this when fulfilling a `post-to-destination` or `check-destination` task with `platform: "bluesky"`.

## Auth

- Login: persistent browser profile must already have a logged-in `bsky.app` session (or whichever PDS the user is on).
- App passwords are only relevant for the AT Protocol API path, which v3.0.0 does NOT use. Browser session is enough.
- If session is expired, return an `error-result` with `category: "needs-login"`.

## URLs

- Compose: home page `https://bsky.app/` has a "New Post" button at top-left; OR navigate to `https://bsky.app/compose` if Bluesky exposes a direct compose URL (not all PDSs do).
- Profile feed: `https://bsky.app/profile/<handle>` (e.g. `https://bsky.app/profile/ethansk.bsky.social`).

## Posting flow (`post-to-destination`)

1. Navigate to `https://bsky.app/`.
2. Click the "New Post" / `+` button (top-left in the app shell).
3. Wait for the compose modal — textarea is the focused element by default.
4. Type / paste `draft_text` exactly.
5. Click the "Post" button in the modal (visible label "Post").
6. Wait for the modal to close. Bluesky doesn't auto-navigate to the new post — to capture `posted_url`, navigate to `https://bsky.app/profile/<handle>` and grab the topmost post link.

## Char cap

- 300 chars (graphemes, not bytes — but in practice 300 chars is the safe bet).

`DEFAULT_PLATFORM_MAX_LENGTH.bluesky = 300`.

## Source scraping (`fetch-source`)

- Profile URL: `https://bsky.app/profile/<handle>`.
- Scroll to load posts. Bluesky uses an infinite-scroll list similar to X.
- Per post, scrape:
  - Post text (the main text content of each post card).
  - Canonical URL: `https://bsky.app/profile/<handle>/post/<rkey>` — extractable from the post's permalink/timestamp `<a>` tag.
  - `publishedAt`: parse the visible relative timestamp.

## Known quirks

- **Reposts** (Bluesky's "Repost" / quote-post) appear in the profile feed. Skip them in `fetch-source` — only return original posts.
- **Embedded URL cards** auto-generate when you paste a URL. The card is part of the rendered post but the source `text` is just the URL — preserve as-is.
- **Hashtags** become `#tag` clickable text. Plain text travels fine.
- **Replies** are rendered as part of a thread on the profile feed. Skip them — only top-level posts.

## DOM stability

Bluesky is React Native Web; selectors are less stable than X. The agent should prefer to use accessible-role queries (`role="button"`, `aria-label="New post"`) over CSS selectors.
