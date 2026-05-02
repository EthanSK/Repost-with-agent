# LinkedIn destination notes

Per-platform DOM hints for the agent. Read this when fulfilling a `post-to-destination` or `check-destination` task with `platform: "linkedin"`.

## Auth

- Login: persistent browser profile must already have a logged-in `linkedin.com` session.
- The agent CANNOT log in for the user. If the session is expired, return an `error-result` with `category: "needs-login"`.

## URLs

- Compose page: `https://www.linkedin.com/feed/?shareActive=true` (opens the share modal directly) or click the "Start a post" button on the home feed.
- Profile feed (for source scraping or destination dedupe): `https://www.linkedin.com/in/<handle>/recent-activity/all/` (most reliable URL — `/recent-activity/` filters to the user's posts and shares).

## Posting flow (`post-to-destination`)

1. Navigate to compose URL.
2. Wait for the rich-text editor (`[role="textbox"][contenteditable="true"]` inside the share modal).
3. Click into the textbox.
4. Type / paste `draft_text` exactly.
5. Click the "Post" button (visible label `Post`, primary blue button).
6. Wait for the success toast / modal close.
7. Capture the posted URL by visiting `/recent-activity/all/` and grabbing the topmost activity link.

LinkedIn does NOT show the posted-URL in the success confirmation — you have to navigate back to the profile and pick the newest post.

## Char cap

3000 chars (default in `DEFAULT_PLATFORM_MAX_LENGTH`). Override per-pair if needed (`pair edit` doesn't currently expose this — set explicitly via the `--overlength-strategy` flag at publish time).

## Source scraping (`fetch-source`)

- Navigate to `source_url` (typically `/recent-activity/all/`).
- Scroll until enough posts are loaded for the requested `max_items` (typically 1 scroll = ~3-6 posts; first batch ~10).
- Per post, scrape:
  - Post text body (preserving line breaks)
  - Canonical URL: the post's permalink (visible from the "..." menu → "Copy link to post" or scrape the timestamp `<a>` tag)
  - `publishedAt`: relative time string ("3h", "2d") — convert to ISO if possible, otherwise leave undefined and the orchestrator falls back to source order

## Reposts vs original posts

LinkedIn surfaces both reposts and original posts on `/recent-activity/all/`. The legacy v2 scraper filtered out reposts (it skipped LI items with the "Reposted by ..." prefix). For v3, the agent skill SHOULD do the same — only include genuine original posts in `fetch-source-result.items`.

## Known quirks

- **Mention links** (`<span class="mention">@User</span>`) become plain `@User` text outside LinkedIn. The agent should NOT try to "preserve" the mention by adding `https://linkedin.com/in/<user>` — it pollutes the cross-post body.
- **Hashtags** preserve as-is; LinkedIn renders them clickable but the plain text travels fine.
- **Embedded image / video posts**: skip in v3.0.0. The agent should return text-only posts; image carry-over is a future enhancement.
- **lnkd.in shorteners**: the orchestrator's URL expander will follow these to the final URL before publish, so don't worry about resolving them in the source scrape.
