# Threads destination notes

Per-platform DOM hints for the running agent. Read this BEFORE you start a
`repost-run` / `repost-backfill` step that touches Threads.

> **These hints are STARTING points.** The pair-level
> `~/.repost-with-agent/pairs/<id>/learnings.md` may extend or override
> anything here as the agent discovers quirks specific to Ethan's account
> or a recent Threads UI change. Always read the pair's `learnings.md`
> before applying these defaults — the per-pair file wins on conflict,
> since it reflects the most recent observed behavior. See
> `skills/repost-learnings/SKILL.md`.

## Auth

- Login: the browser MCP profile must have a logged-in `threads.net` session.
- Threads auth piggybacks off Instagram. If `instagram.com` is not also logged
  in, expect login flow redirects.
- If session is expired, append `pair.publish.failed` audit with `category:
  "needs-login"` and stop.

## URLs

- Compose: `https://www.threads.net/` (home feed) — there's a persistent "New thread" composer at the top, or click the `+` icon in the bottom nav (mobile-style web app).
- Profile: `https://www.threads.net/@<handle>`.

## Posting flow

1. Navigate to `https://www.threads.net/`.
2. Click the "Start a thread..." input at the top, OR click the `+` icon in the side nav.
3. Wait for the composer modal — textarea is the focused element.
4. Type / paste `draft_text` exactly.
5. Click "Post" (visible label).
6. Wait for the modal to close. Capture `posted_url` by navigating to `https://www.threads.net/@<handle>` and grabbing the topmost thread permalink.

## Char cap

- 500 chars per single thread post.

## Source scraping

- Profile URL: `https://www.threads.net/@<handle>`.
- Scroll to load threads.
- Per thread, scrape:
  - Top-level thread text.
  - Canonical URL: `https://www.threads.net/@<handle>/post/<id>`.
  - `publishedAt`: the visible relative timestamp.

## Known quirks

- **Threads-of-threads.** A "thread" can contain multiple posts. For source
  scrape, treat each top-level original thread as one item — don't surface
  follow-up posts as separate items.
- **Cross-posting from Instagram.** Threads users sometimes have content
  auto-mirrored from Instagram. Mirror posts are marked with an Instagram badge
  — skip them in source scrape since they're not original Threads content.
- **Login wall.** Anonymous browsing of Threads is partially supported but
  inconsistent. Always operate from a logged-in session.
- **DOM is React Native Web** with mobile-first selectors. Prefer
  accessibility-role queries.
