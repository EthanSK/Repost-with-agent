# URL expander

New in v3.0.0 (Ethan voice 6018, 6021, 2026-05-01).

## What it does

Before any draft is shown to the agent (preview, post, backfill), the orchestrator runs `expandUrlsInText()` over the body. Every URL in the draft is followed through HTTP redirects to its final destination; the original shortened URL in the body is replaced with the expanded form.

Why: when a LinkedIn post links to `lnkd.in/abc123`, that's actually a redirect to `https://medium.com/some-article`. Posting `lnkd.in/abc123` to X means the X reader gets a `lnkd.in` short-URL that they have to click through. Expanding to the real URL gives the destination's reader a one-click trip to the actual content.

## Implementation

`src/core/url-expander.ts`. Key parameters (Ethan voice 6021):

- **Max 5 hops** per URL.
- **5-second timeout** per request.
- **Fail-soft**: any error (timeout, DNS, network, redirect loop, 30x with no Location, hop-cap reached) → original URL is preserved. The publish proceeds regardless.

Algorithm:

1. `URL_PATTERN` regex extracts every URL in the text.
2. For each URL, walk redirects:
   a. HTTP HEAD with `redirect: "manual"` and a 5-second AbortController.
   b. If the response is 405 / 501, fall back to GET.
   c. If status is 30x, read `Location`, resolve relative against current URL, append to chain, loop.
   d. If chain already contains the next URL → loop detected, return current URL with `error: "Redirect loop ..."`.
   e. If status < 300 or ≥ 400 → current URL is final.
3. After every URL has expanded (or failed-soft), substitute `originalUrl` with `expandedUrl` in the body via `split(...).join(...)` (handles every occurrence safely without regex escaping).
4. Return `{text, expansions[]}`. Each successful expansion fires a `pair.publish.url_expanded` audit event with `{shortenedUrl, expandedUrl, hopCount}`.

## Coverage

Known shorteners (an explicit list lives in `KNOWN_SHORTENERS`):

- `lnkd.in/` — LinkedIn shortener
- `t.co/` — X / Twitter shortener
- `bit.ly/`, `buff.ly/`, `buffer.com/` — generic
- `goo.gl/` — Google (legacy)
- `tinyurl.com/`, `ow.ly/`, `rb.gy/`, `is.gd/`, `shorturl.at/`, `tiny.cc/`, `cutt.ly/` — generic
- `youtu.be/` — YouTube short links
- `fb.me/` — Facebook
- `trib.al/` — Tribune

But the expander is **not restricted** to these — any URL that returns a 30x with a Location header will be followed. The list is informational (and gives `isShortener()` something concrete to check against).

## Helper commands

```bash
# Expand a single URL.
repost-with-agent urls expand https://lnkd.in/abc123

# Expand every URL in a body.
repost-with-agent urls expand-text "Check out https://lnkd.in/abc and https://bit.ly/xyz"
```

Both emit JSON. `expand` returns one `ExpandUrlResult`; `expand-text` returns `{text, expansions[]}`.

## Audit events

For each successful expansion:

```json
{
  "at": "2026-05-02T12:00:00.000Z",
  "event": "pair.publish.url_expanded",
  "pairId": "linkedin-to-x",
  "details": {
    "shortenedUrl": "https://lnkd.in/abc123",
    "expandedUrl": "https://medium.com/some-article",
    "hopCount": 1,
    "destPlatform": "x"
  }
}
```

For backfill, the event also carries `backfillIndex` so you can tie expansions to specific candidates.

## Failure modes (all fail-soft)

| Symptom | Cause | Outcome |
| --- | --- | --- |
| Timeout | Server didn't respond within 5 seconds | Original URL kept, `error` field populated, no `url_expanded` audit event |
| Network error / DNS failure | Local network broke | Original URL kept |
| Redirect loop | A→B→A (or longer cycle) | Detected, current URL kept, `error: "Redirect loop ..."` |
| Hop cap | More than 5 redirects | Last visited URL kept (NOT original), `error: "Max hops ..."`. This means a 6-deep chain DOES partially expand. |
| 30x with no Location | Misconfigured server | Current URL treated as final |
| HEAD 405/501 | Server doesn't support HEAD | Falls back to GET on the same hop |

## Why fail-soft?

Ethan voice 6021: "if expansion errors, use the original shortened URL — don't block the publish." A draft with a still-shortened URL is mildly worse than no draft at all. The fail-soft rule means a flaky shortener never breaks the publish path.

## Tests

`tests/url-expander-regression.js`. 12 sections covering:

1. No-op (final URL on first hop, no redirect).
2. Single-hop expansion.
3. Multi-hop chain (lnkd.in → t.co → bit.ly → final).
4. MAX_HOPS cap returns last URL with error.
5. Redirect loop detection.
6. Timeout fail-soft (returns original URL).
7. Network error fail-soft.
8. HEAD 405 → GET fallback.
9. 30x without Location header (treated as final).
10. `expandUrlsInText` substitutes every URL; non-shortened URLs unchanged.
11. `isShortener` recognizes known hosts.
12. Smoke test for every entry in `KNOWN_SHORTENERS`.

All use injected `fetchImpl` to fake redirects without hitting the network.
