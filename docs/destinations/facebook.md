# Facebook destination notes

Per-platform DOM hints for the agent. Read this when fulfilling a `post-to-destination` or `check-destination` task with `platform: "facebook"`.

## Auth

- Login: persistent browser profile must have a logged-in `facebook.com` session.
- Facebook will sometimes prompt for 2FA / device-confirmation challenges. The agent CANNOT solve these — return an `error-result` with `category: "needs-login"` if a challenge appears.

## Targets

Facebook supports posting to:

- **Personal timeline** (your own profile feed).
- **Page** you administer.
- **Group** you're a member of.

For v3.0.0, the `destination_account` field is the target's identifier — for a page, the page handle; for a personal timeline, the user's handle. The agent should switch into the right "audience" before posting (Facebook's composer has an audience picker).

## URLs

- Compose (personal): `https://www.facebook.com/` (home feed → "What's on your mind?" box).
- Compose (page): `https://www.facebook.com/<page-handle>` then click "Create post".
- Profile feed: `https://www.facebook.com/<handle>` or `https://www.facebook.com/profile.php?id=<id>`.

## Posting flow (`post-to-destination`)

1. Navigate to the appropriate compose URL based on the target type.
2. Click into the "What's on your mind?" / "Write a post..." textbox.
3. Type / paste `draft_text` exactly.
4. (Optional) verify the audience picker is set correctly (Public / Friends / Page name) — for a page or group, the audience should already be the right scope.
5. Click "Post".
6. Wait for the modal to close. Capture `posted_url` by finding the new post on the feed and clicking through to its permalink, OR by reading the post's permalink from the timestamp `<a>`.

## Char cap

- 63 206 chars (Facebook's published limit; effectively no practical cap).

`DEFAULT_PLATFORM_MAX_LENGTH.facebook = 63206`.

## Source scraping (`fetch-source`)

- Profile / page URL: `https://www.facebook.com/<handle>`.
- Scroll to load posts. Facebook's feed virtualization is aggressive — scrape as you scroll.
- Per post, scrape:
  - Post text (visible body, minus "See more" expander — click "See more" if needed to load full text).
  - Canonical URL: post permalink (extractable from the timestamp `<a>` tag).
  - `publishedAt`: the visible timestamp.

## Known quirks

- **Privacy-restricted posts** may appear in the feed but resolve to a 404 / "content unavailable" page when unauthenticated. The agent should skip posts whose visibility is not Public, since the destination dedupe and cross-post path can't read them reliably.
- **Reactions and comments** are not part of `text`. Don't include them.
- **Embedded video / live posts**: skip in v3.0.0 (text-only mirror).
- **Page vs profile vs group composer DOM** — the three look similar but use slightly different selectors. Use accessibility-role queries to find the textbox/button, not CSS selectors.
- **2FA / login challenge** is the most common failure. If the user is prompted to confirm a new device, the agent has to surface it and let the user complete it manually.
