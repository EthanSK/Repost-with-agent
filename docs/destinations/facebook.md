# Facebook destination notes

Per-platform DOM hints for the running agent. Read this BEFORE you start a
`repost-run` / `repost-backfill` step that touches Facebook.

> **These hints are STARTING points.** The pair-level
> `~/.repost-with-agent/pairs/<id>/learnings.md` may extend or override
> anything here as the agent discovers quirks specific to Ethan's account,
> page, or group (FB's composer DOM differs across the three) or a recent
> Facebook UI change.
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

- Login: the current harness browser profile must have a logged-in `facebook.com` session.
- Facebook will sometimes prompt for 2FA / device-confirmation challenges.
  The agent CANNOT solve these — append `pair.publish.failed` audit with
  `category: "needs-login"` if a challenge appears.

## Targets

Facebook supports posting to:

- **Personal timeline** (your own profile feed).
- **Page** you administer.
- **Group** you're a member of.

In v4, the `destination.accountHint` field is the target's identifier — for a
page, the page handle; for a personal timeline, the user's handle.
`destination.accountDisplayName` is the visible name the UI should show, and
`destination.targetType` should be `profile`, `page`, or `group`.

Facebook often logs the browser into a master personal account first, then lets
that account post as a Page. The running agent MUST switch to, or verify it is
already using, the configured page/profile/group before typing any draft. If the
composer appears to be posting as the wrong identity, stop with
`category: "needs-account-switch"` rather than publishing from the wrong account.

## URLs

- Compose (personal): `https://www.facebook.com/` (home feed → "What's on your mind?" box).
- Compose (page): `https://www.facebook.com/<page-handle>` then click "Create post".
- Profile feed: `https://www.facebook.com/<handle>` or `https://www.facebook.com/profile.php?id=<id>`.

## Posting flow

1. Navigate to the appropriate compose URL based on the target type.
   - For `targetType: "page"`, navigate to `https://www.facebook.com/<page-handle>`
     and use the page's own "Create post" affordance.
   - Reuse an existing Facebook tab when one is already open; do not create
     duplicate Facebook tabs on every scheduled run.
2. Click into the "What's on your mind?" / "Write a post..." textbox.
3. Verify the composer identity / audience matches `destination.accountHint`
   and `destination.accountDisplayName` (for example a Page name such as
   `Reetham`). Use the profile/page switcher if needed.
4. Type / paste `draft_text` exactly.
5. Verify the audience picker is set correctly (Public / Friends / Page name) —
   for a page or group, the audience should already be the right scope.
6. Click "Post".
7. Wait for the modal to close. Capture `posted_url` by finding the new post on the feed and clicking through to its permalink, OR by reading the post's permalink from the timestamp `<a>`.
   - **Do not trust the first Facebook URL you see.** Facebook's feed and dialog DOM can leave older post links/timestamp anchors near the newly-posted content.
   - Prefer the new post card's `Boost post` URL `target_id=<post id>` when present; normalize it to `https://www.facebook.com/<page-handle>/posts/<post id>`.
   - After extracting any candidate permalink, open it in the browser and verify the page title/body contains the expected draft text (or a distinctive excerpt) and does **not** contain a different recent post's text.
   - If the URL opens the wrong post, keep searching the live page for the matching post card and record `pair.publish.failed` with `category: "platform-error"` if no verified URL can be found. Do not append `posted.jsonl`, global ledger, or user notification with an unverified Facebook permalink.

## Char cap

- 63 206 chars (Facebook's published limit; effectively no practical cap).

## Source scraping

- Profile / page URL: `https://www.facebook.com/<handle>`.
- Scroll to load posts. Facebook's feed virtualization is aggressive — scrape as you scroll.
- Per post, scrape:
  - Post text (visible body, minus "See more" expander — click "See more" if needed to load full text).
  - Canonical URL: post permalink (extractable from the timestamp `<a>` tag).
  - `publishedAt`: the visible timestamp.
  - If a visible post card exposes a `Boost post` link with `target_id`, treat that numeric id as the safest permalink source, but still open and verify the normalized URL before using it as proof.

## Destination dedupe

- Navigate to the destination profile / page / group.
- Scroll to load 50–100 recent posts.
- Compare against `candidate_text` using the `repost-dedup` skill's algorithm.

### Layer 2 semantic dedupe

Layer 2 (`skills/repost-dedup-semantic/SKILL.md`) runs against the
destination's last 30 posts by default. Facebook personal timelines /
pages tend to have lower volume than X or Threads, so 30 is usually
plenty. Bump `pair.policy.semanticDedupeWindowSize` only if the
destination is a high-frequency page; for Substack-style low-volume
publishing, 30 is generous.

## Known quirks

- **Privacy-restricted posts** may appear in the feed but resolve to a 404 / "content unavailable" page when unauthenticated. The agent should skip posts whose visibility is not Public, since the destination dedupe and cross-post path can't read them reliably.
- **Reactions and comments** are not part of `text`. Don't include them.
- **Embedded video / live posts**: skip in v4 (text-only mirror).
- **Page vs profile vs group composer DOM** — the three look similar but use
  slightly different selectors. Use accessibility-role queries to find the
  textbox/button, not CSS selectors.
- **Wrong identity risk** — if Facebook opens the composer as Ethan's personal
  profile when the pair says `targetType: "page"`, switch to the configured
  page first. If the switcher is hidden behind a Meta account/page menu and you
  cannot confirm it, stop and ask Ethan to select the page manually.
- **2FA / login challenge** is the most common failure. If the user is
  prompted to confirm a new device, surface it and let the user complete it
  manually.
- **Wrong permalink proof** — a post can publish correctly while the DOM still
  exposes an older post's `pfbid` / timestamp URL nearby. User-facing links and
  ledgers must be content-verified by opening the captured URL before success
  is recorded.
