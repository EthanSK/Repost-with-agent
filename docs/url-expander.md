# URL expander (v4.0.0 — agent-driven)

This is the long-form reference for `skills/repost-url-expand/SKILL.md`. The
skill itself contains the full procedure the agent follows; this doc explains
the WHY and lists per-platform quirks the agent should know.

## Why expand URLs at all?

LinkedIn, X, Bluesky, Threads, and Facebook all wrap URLs in their own
shortener domains as a side-effect of posting:

- LinkedIn → `lnkd.in/<hash>`
- X → `t.co/<hash>`
- Bluesky → keeps full URL but renders a "card" preview
- Threads → keeps full URL
- Facebook → wraps in `fb.me/<hash>` for some flows

Without expansion, a LinkedIn post containing `https://example.com/article` will
appear in your X feed (when reposted by this plugin) as `lnkd.in/abc → t.co/xyz`
— two layers of shortener. Click-through still works, but:

- The URL preview card on the destination is broken (wrong domain).
- Destination dedupe gets fooled: a re-post of the same article on a
  different day will use a different `t.co` alias, so fuzzy-match on URLs
  can't catch it.
- The user's analytics pipeline (if any) sees clicks against `t.co` not the
  real article.

Expanding to the canonical URL fixes all three.

## Algorithm

See `skills/repost-url-expand/SKILL.md` for the agent-facing procedure. In
short:

1. Find every `https?://[^\s)]+` token in the body.
2. For each, follow up to 5 hops with a 5-second timeout per hop using `curl
   -sIL --max-time 5 --max-redirs 5 -o /dev/null -w '%{url_effective}'`.
3. Substitute the resolved URL.
4. Fail-soft: any error keeps the original URL.

## Per-platform quirks

### LinkedIn (`lnkd.in`)

- Always 30x's. Two hops typically: `lnkd.in/abc` → `linkedin.com/safety/...?url=https://example.com/article` → `https://example.com/article`.
- The intermediate `linkedin.com/safety/` redirector echoes the destination URL in the query string.

### X (`t.co`)

- Always 30x's directly to the destination URL. One hop.
- HEAD requests are sometimes blocked; if `curl -I` returns 405, fall back to
  `curl -L` without `-I` (still uses `-o /dev/null`).

### Bluesky / Threads / Facebook

- Mostly don't shorten. URLs in the body are usually direct already.
- Bluesky link cards add a separate "card" object alongside the URL — when
  scraping for dedupe, consider both.

### Generic shorteners

- `bit.ly`, `buff.ly`, `tinyurl.com`, `ow.ly`, `goo.gl` (still resolves
  despite Google deprecation), `is.gd`, `rebrand.ly`, `tr.im`, `shorturl.at`,
  `cutt.ly`, `rb.gy`.
- Most are one hop. A few chain (e.g. `bit.ly` → `goo.gl` → final).

## When to NOT expand

- URLs that land on a login / paywall page (`/login`, `/signin`, `/sso`,
  `/auth`). Bail back to the original — the canonical URL the user can act
  on isn't necessarily the final-after-redirect URL.
- URLs already resolved on previous runs. There's no caching layer in v4 —
  every run re-expands. That's fine for the small URL counts (≤5 per post)
  in typical usage.

## Telegram link-preview pitfall

Telegram-confirmation messages include the destination URL. If the destination
URL is itself a `t.co` alias (because the destination platform always wraps),
Telegram's link preview will resolve it, but if the alias has been deactivated
the preview will be ugly. Mitigation:

- The Telegram message body uses the **destination platform's canonical URL**
  (e.g. `https://x.com/<handle>/status/<id>`), NOT a `t.co` alias.
- The destination URL we capture in `posted.jsonl` is also the canonical
  destination URL, not a wrapped one.

## Audit events

- `pair.publish.url_expanded` — one URL was successfully expanded. Includes `from`, `to`.
- `pair.publish.url_expand_failed` — one URL expansion failed. Includes `url`, `error`.

Append one event per URL, not one per post.

## Manual invocation

For ad-hoc URL expansion (no publish involved), the user can ask:

> "expand https://lnkd.in/abc"

The agent runs `curl -sIL --max-time 5 --max-redirs 5 -o /dev/null -w
'%{url_effective}\n'` and prints the result. No audit events.

## See also

- `skills/repost-url-expand/SKILL.md` — the procedure the agent follows.
- `skills/repost-run/SKILL.md` step 6 — where expansion happens in the publish flow.
- `docs/state-files.md` — audit event schemas.
