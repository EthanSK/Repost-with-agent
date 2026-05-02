# Threads destination notes

Per-platform DOM hints for the running agent. Read this BEFORE you start a
`repost-run` / `repost-backfill` step that touches Threads.

> **These hints are STARTING points.** The pair-level
> `~/.repost-with-agent/pairs/<id>/learnings.md` may extend or override
> anything here as the agent discovers quirks specific to Ethan's account
> or a recent Threads UI change.
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

## Destination dedupe

- Navigate to `https://www.threads.net/@<handle>`.
- Scroll to load 50–100 recent threads.
- Compare against `candidate_text` using the `repost-dedup` skill's algorithm.

### Layer 2 semantic dedupe

Layer 2 (`skills/repost-dedup-semantic/SKILL.md`) runs against the
destination's last 30 threads by default. Threads has a relatively high
post volume for chatty accounts; 30 typically covers a couple of weeks.
Bump `pair.policy.semanticDedupeWindowSize` higher (50–100) for very
active Threads accounts or leave at 30 for moderate-cadence ones.

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
