---
name: repost-url-expand
description: Expand shortened URLs (lnkd.in, t.co, bit.ly, buff.ly, etc.) in a draft post body to their canonical form before publishing. Use as part of the repost-run / repost-backfill flow, or when the user asks "expand this URL", "follow this redirect", or invokes /urls expand.
when_to_trigger: Before publishing any draft that contains URLs, OR when the user asks to manually expand a URL.
---

# Repost URL Expand

Resolve shortened URLs in a draft body to their final canonical form before
publishing. This avoids posting `https://lnkd.in/abc` to X (where it becomes
`t.co/xyz` wrapping `lnkd.in/abc` wrapping the real URL) and also helps with
destination dedupe (since shortener domains differ across reposts).

## Algorithm

1. Find every URL in the body via regex `https?://[^\s)]+` (be careful to NOT
   include trailing punctuation like `.` or `)`).
2. For each URL:
   - If the host is in the **shortener allowlist** (see below), follow it.
   - Else if the URL returns a 30x redirect, follow it.
   - Else leave it alone.
3. Follow up to **5 hops** with a **5-second timeout** per hop.
4. On any failure (timeout, DNS fail, 5xx, redirect loop), keep the original
   URL (fail-soft).
5. Substitute the resolved URL for the original in the draft body.

## Shortener allowlist

These are always followed regardless of whether they 30x:

```
lnkd.in
t.co
bit.ly
buff.ly
goo.gl
tinyurl.com
ow.ly
is.gd
rebrand.ly
tr.im
shorturl.at
cutt.ly
rb.gy
```

Add to this list as you encounter new shorteners in the wild.

## How to follow with curl

The simplest implementation uses `curl` via Bash:

```bash
expand_url() {
  local url="$1"
  curl -sIL --max-time 5 --max-redirs 5 -o /dev/null -w '%{url_effective}\n' "$url"
}

expand_url "https://lnkd.in/abc"
# → https://example.com/article-final
```

`-s` silent, `-I` HEAD, `-L` follow redirects, `--max-time 5` per-hop budget,
`--max-redirs 5` cap, `-o /dev/null` discard body, `-w '%{url_effective}'`
print the final URL.

For platforms that block HEAD requests (some CDNs do), retry with GET:

```bash
curl -sL --max-time 5 --max-redirs 5 -o /dev/null -w '%{url_effective}\n' "$url"
```

## When to expand

In the `repost-run` step 6 flow:

1. Take the candidate's text body from the source scrape.
2. Run URL expansion across every URL in the body.
3. Substitute resolved URLs.
4. Do **not** append the source canonical URL as a public backlink. Store the
   source canonical URL in `posted.jsonl`, audit, and Telegram confirmation
   only. The destination post should be native to the destination platform.
5. Run the mandatory source URL leak guard before publishing: if the final
   public draft contains `canonicalSourceUrl`, or a LinkedIn source permalink
   marker such as `linkedin.com/feed/update/` / `urn:li:activity:`, rebuild the
   draft from the source body and check again. If it still appears, block the
   destination with `source-url-leak-guard` instead of publishing.

If the source text contains source-platform wrapper URLs (for example
`lnkd.in` / LinkedIn safety redirects), resolve them to the underlying
non-LinkedIn final URL before publishing to X. Do not publish LinkedIn wrapper
links to X unless the LinkedIn URL itself is the intended content.

For each successful expansion, append `pair.publish.url_expanded` to
`audit.jsonl`:

```json
{"ts":"<ts>","event":"pair.publish.url_expanded","from":"https://lnkd.in/abc","to":"https://example.com/article-final"}
```

For each failure, append `pair.publish.url_expand_failed`:

```json
{"ts":"<ts>","event":"pair.publish.url_expand_failed","url":"https://lnkd.in/abc","error":"timeout"}
```

## Manual invocation

If the user just wants to expand a URL ad-hoc (no publish involved), run:

```bash
curl -sIL --max-time 5 --max-redirs 5 -o /dev/null -w '%{url_effective}\n' "<url>"
```

Tell them the result. Don't append audit events for ad-hoc expansions.

## What about non-shortener URLs that 30x?

Some URLs aren't shorteners but still 30x to a final form (e.g. an HTTPS-
upgrade, a www-redirect, a stale URL pointing at a new path). The expansion
algorithm should follow those too — they're harmless and produce a cleaner
final URL.

The only case where you should NOT follow a 30x is one that lands on a login
page or paywall (the redirect target replaces a meaningful URL with a
"please sign in" URL). Detect this by checking if the final URL host or path
contains `/login` / `/signin` / `/sso` and bail back to the original.

## See also

- `skills/repost-run/SKILL.md` — calls URL expansion at step 6.
- `skills/repost-backfill/SKILL.md` — same.
- `docs/state-files.md` — audit event schemas.
