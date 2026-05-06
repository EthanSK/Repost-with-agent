# X (Twitter) destination notes

Per-platform DOM hints for the running agent. Read this BEFORE you start a
`repost-run` / `repost-backfill` step that touches X (either as source or
destination).

> **These hints are STARTING points.** The pair-level
> `~/.repost-with-agent/pairs/<id>/learnings.md` may extend or override
> anything here as the agent discovers quirks specific to Ethan's account or
> a recent X UI change.
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

- Login: the current harness browser profile must already have a logged-in `x.com`
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
6. Wait for either a success toast, a URL change to
   `https://x.com/<handle>/status/<id>`, or compose dismissal back to `/home`.
7. Capture the full `destinationUrl`. If X returns to `/home`, navigate to the
   destination profile and scrape the top post timestamp/status link.
8. **Hard proof gate:** open the captured status URL and extract the live post
   text from the post card (not the compose box). Normalize only harmless
   whitespace/display differences and verify it matches the intended draft. If
   the live text is a fragment, duplicated/stale editor text, or otherwise
   different, append `pair.publish.live_text_mismatch` plus `posted-malformed`
   quarantine proof and do not record success.

## Char cap

- Free / classic accounts: 280 chars.
- Premium / Verified: 25 000 chars.

For Ethan/OpenClaw runs, do **not** pre-compact X drafts merely because a local
280-char count says they may be long. Put the exact leak-guarded draft into the
X composer first and only compact when the live UI itself reports overlength or
cutoff feedback (for example an over-limit counter, disabled Post button with
overlength feedback, or visible cutoff warning). If the UI accepts the exact
draft, publish the exact draft.

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
  - **`mediaTypes` / `mediaEvidence`**: inspect the tweet card for obvious
    media signals. Video/livestream hints include video player containers,
    play buttons, `aria-label` text mentioning video, visible `LIVE` badges,
    duration badges, or embedded player/card text. Use `mediaTypes: ["video"]`
    or `["livestream"]` when clear; use `["unknown"]` when the scrape cannot
    tell.

Skip retweets (they have a "<user> reposted" indicator above the tweet) when
fetching as a source. They're not original content. Apply
`skills/repost-custom-rules/SKILL.md` after scraping; Ethan's current custom
rule skips X video/livestream promos matching the "vibe coding an ai slop
machine" example.

## Destination dedupe

For destination dedupe on X:

- Navigate to the destination account profile.
- Scroll to load 50–100 recent posts.
- Compare against `candidate_text` using the `repost-dedup` skill's algorithm.
  **Important**: strip URLs from BOTH sides before comparing — X rewrites
  every URL into a `t.co/<hash>` alias that won't match the LinkedIn /
  Bluesky / etc. source URL.

### Layer 2 semantic dedupe

Layer 2 (`skills/repost-dedup-semantic/SKILL.md`) runs against the
destination's last 30 posts by default. **For X power-users (multiple
posts per day), consider raising `pair.policy.semanticDedupeWindowSize`
to 50–100** so the agent has enough recent context to spot paraphrased
duplicates from the past week or two. Reuse the same scrape Layer 1
already produced — no extra browser cost.

## Known quirks

- **`t.co` URL substitution.** X rewrites every URL in posted text to a
  `t.co/<hash>` alias. A post you publish with `https://example.com/article`
  shows up in the destination scrape as `t.co/abc123`. Strip URLs from both
  candidate and scraped text before comparing.
- **Threading.** Long drafts can't be threaded automatically in v4 —
  overlength drafts are compacted (`overlengthStrategy: "compact"`, preferred), skipped (`"skip"`), or
  mechanically truncated (`"truncate"`). Re-introduce threading as a separate skill if
  needed.
- **Quoted reposts.** Show up in the profile feed but are dedupe-irrelevant.
  Skip them in source scrape (they're not original content); treat them like
  normal posts in destination dedupe.
- **Login walls.** X sometimes shows a login modal even for logged-in users
  on certain endpoints. Detect and bail with `category: "needs-login"`.
