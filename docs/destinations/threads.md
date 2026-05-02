# Threads destination notes

Per-platform DOM hints for the agent. Read this when fulfilling a `post-to-destination` or `check-destination` task with `platform: "threads"`.

## Auth

- Login: persistent browser profile must have a logged-in `threads.net` session.
- Threads auth piggybacks off Instagram. If `instagram.com` is not also logged in, expect login flow redirects.
- If session is expired, return an `error-result` with `category: "needs-login"`.

## URLs

- Compose: `https://www.threads.net/` (home feed) — there's a persistent "New thread" composer at the top, or click the `+` icon in the bottom nav (mobile-style web app).
- Profile: `https://www.threads.net/@<handle>`.

## Posting flow (`post-to-destination`)

1. Navigate to `https://www.threads.net/`.
2. Click the "Start a thread..." input at the top, OR click the `+` icon in the side nav.
3. Wait for the composer modal — textarea is the focused element.
4. Type / paste `draft_text` exactly.
5. Click "Post" (visible label).
6. Wait for the modal to close. Capture `posted_url` by navigating to `https://www.threads.net/@<handle>` and grabbing the topmost thread permalink.

## Char cap

- 500 chars per single thread post.

`DEFAULT_PLATFORM_MAX_LENGTH.threads = 500`.

## Source scraping (`fetch-source`)

- Profile URL: `https://www.threads.net/@<handle>`.
- Scroll to load threads.
- Per thread, scrape:
  - Top-level thread text.
  - Canonical URL: `https://www.threads.net/@<handle>/post/<id>`.
  - `publishedAt`: the visible relative timestamp.

## Known quirks

- **Threads-of-threads.** A "thread" can contain multiple posts. For `fetch-source`, treat each top-level original thread as one item — don't surface follow-up posts as separate items.
- **Cross-posting from Instagram.** Threads users sometimes have content auto-mirrored from Instagram. The cross-mirror posts are usually marked with an Instagram badge — skip them in `fetch-source` since they're not original Threads content.
- **Login wall.** Anonymous browsing of Threads is partially supported but inconsistent. The agent should always operate from a logged-in session.
- **DOM is React Native Web** with mobile-first selectors. Prefer accessibility-role queries.
