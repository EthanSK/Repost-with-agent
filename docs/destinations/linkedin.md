# LinkedIn destination notes

Per-platform DOM hints for the running agent. Read this BEFORE you start a
`repost-run` / `repost-backfill` step that touches LinkedIn (either as source
or destination).

## Auth

- Login: the browser MCP profile must already have a logged-in `linkedin.com`
  session. The agent cannot log in for the user. If the session is expired,
  append a `pair.publish.failed` audit event with `category: "needs-login"`
  and stop.

## URLs

- Compose: `https://www.linkedin.com/feed/?shareActive=true` (opens the share
  modal directly), or click "Start a post" on the home feed.
- Profile feed (source scraping + destination dedupe): `https://www.linkedin.com/in/<handle>/recent-activity/all/`.

## Posting flow

1. Navigate to the compose URL.
2. Wait for the rich-text editor (`[role="textbox"][contenteditable="true"]`
   inside the share modal).
3. Click into the textbox.
4. Type the draft body EXACTLY. Don't reformat, don't add hashtags.
5. Click the "Post" button (primary blue, visible label `Post`).
6. Wait for the success toast / modal close.
7. **Capture the posted URL.** LinkedIn does NOT show the posted URL in the
   success toast. Navigate back to `/recent-activity/all/` and grab the
   topmost activity's permalink (open the "..." menu → "Copy link to post",
   or scrape the timestamp `<a>` tag).

## Char cap

3 000 chars. The skill's overlength check uses this value. If the user wants
something different, edit the per-pair policy.

## Source scraping

- Navigate to `<source_url>` (typically `/recent-activity/all/`).
- Scroll until enough posts are loaded — typically 1 scroll ≈ 3–6 posts;
  first batch ≈ 10.
- Per post, scrape:
  - **Post body** (preserve line breaks).
  - **Canonical URL**: permalink from the "..." menu, or the timestamp `<a>`.
  - **`sourceItemId`**: the activity URN (`urn:li:activity:NNNNNNNN`) from
    the post's data attributes or canonical URL fragment.
  - **`publishedAt`**: relative time ("3h", "2d") resolved to ISO-8601 if
    possible.

## Reposts vs original posts

`/recent-activity/all/` surfaces both reposts and original posts. **Skip
reposts** in `fetch-source` — they're not original content. Indicators:

- "Reposted by <user>" header above the post.
- Embedded `feed-shared-update-v2__reshare` block.

## Destination dedupe

For `check-destination` semantics on LinkedIn:

- Navigate to `https://www.linkedin.com/in/<handle>/recent-activity/all/`.
- Scroll to load 50–100 recent posts.
- Compare candidate text against scraped post bodies using the
  `repost-dedup` skill's algorithm (whitespace-collapse, lowercase, strip
  URLs, exact-normalized OR ≥80-char prefix overlap).

## Known quirks

- **Mention links** (`<span class="mention">@User</span>`) become plain
  `@User` text outside LinkedIn. Don't synthesize `https://linkedin.com/in/<user>`
  in the cross-post body — it pollutes the destination.
- **Hashtags** preserve as-is. LinkedIn renders them clickable; plain text
  travels fine.
- **Embedded image / video posts**: skip in v4. Image carry-over is a future
  enhancement.
- **`lnkd.in` shorteners**: the `repost-url-expand` skill expands these to
  the final URL before publish. Don't try to resolve them during source scrape.
- **Pagination cap**: `/recent-activity/all/` virtualizes aggressively and
  caps at ~100 historical posts. Backfills past ~100 typically can't load
  more.
