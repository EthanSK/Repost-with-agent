---
name: repost-global-dedupe
description: Cross-pair/global dedupe for Repost-with-agent. Use before any publish-capable run so pairs with different sources/destinations share one content ledger and avoid double-posting the same item through alternate hops such as LinkedIn→X→Bluesky and X→Bluesky.
when_to_trigger: Any time a candidate survived basic per-pair source scraping and before destination compose/publish, especially when multiple pairs can share a destination or source from each other.
---

# Repost Global Dedupe — cross-pair content ledger

This is the cross-pair layer Ethan asked for on 2026-05-04: pairs must not
think in isolation. If any pair has already handled the same underlying content
for a destination, every other pair should know and skip instead of double-
posting.

## State file

Global state lives at:

```text
~/.repost-with-agent/global-posted.jsonl
```

It is append-only NDJSON. It sits beside `pairs.json` and complements, but does
not replace, each pair's local `pairs/<id>/posted.jsonl`.

Each line should be shaped like:

```json
{
  "ts": "<ISO-8601>",
  "event": "global.publish.success | global.publish.catchup | global.publish.semantic_duplicate | global.publish.remote_duplicate",
  "pairId": "<pair-id that observed/created this record>",
  "contentKey": "<canonical cross-pair content identity>",
  "sourcePlatform": "<site-key, e.g. linkedin | x | bluesky | threads | facebook | your-site>",
  "sourceItemId": "<source platform item id>",
  "canonicalSourceUrl": "<source post URL>",
  "destinationPlatform": "<site-key, e.g. linkedin | x | bluesky | threads | facebook | your-site>",
  "destinationAccountHint": "<configured destination.accountHint if known>",
  "destinationUrl": "<published/matched destination post URL>",
  "destinationId": "<destination platform item id if known>",
  "draftText": "<text that was/would be posted>",
  "status": "posted | caught-up | skipped-duplicate",
  "note": "<optional human reason>"
}
```

Missing optional fields are fine. Never rewrite old lines; append corrections
as newer lines.

## Content key rules

A `contentKey` represents the underlying idea/item independent of the pair hop.
The simplest key is:

```text
<sourcePlatform>:<sourceItemId>
```

or, if the source ID is unavailable:

```text
url:<canonicalSourceUrl without tracking params / trailing slash normalized>
```

Before finalizing that key, inherit lineage from the global ledger:

1. Load `~/.repost-with-agent/global-posted.jsonl` if it exists.
2. If the candidate's current source URL or source ID matches a previous line's
   `destinationUrl`, `destinationId`, or destination-platform canonical URL,
   inherit that line's `contentKey`.
   - Example: LinkedIn→X published `contentKey=linkedin:urn:li:activity:123`
     to `https://x.com/.../status/999`.
   - Later, `x-to-bluesky` scrapes that X status as its source. Because the X
     source URL/ID matches the earlier line's destination, the X candidate
     inherits `contentKey=linkedin:urn:li:activity:123` instead of becoming a
     new `x:999` item.
3. If multiple lines match, use the newest non-empty `contentKey` and record the
   inherited-from URL in audit if helpful.

This lineage inheritance is what prevents LinkedIn→X→Bluesky and a direct
X→Bluesky pair from both posting the same LinkedIn-origin content to Bluesky.

## Global duplicate decision

For the current pair and candidate:

1. Resolve the candidate `contentKey` using the rules above.
2. If `pair.policy.globalDedupeEnabled === false`, skip this skill. Default is
   **enabled**.
3. Search global ledger lines for the same `contentKey` where:
   - `destinationPlatform === pair.destination.platform`, and
   - if both are present, `destinationAccountHint` / destination profile/account
     point at the same configured destination identity.
4. If such a line exists, the candidate is `duplicate-global` for this
   destination. Do **not** publish. Append:
   - a per-pair audit event `pair.dedupe.global_duplicate`, and
   - a per-pair catch-up line to `pairs/<id>/posted.jsonl`, and
   - a global catch-up line with `event: "global.publish.catchup"`,
     `status: "skipped-duplicate"`, and a note naming the matched destination.
5. If no such line exists, the candidate is globally unique for this
   destination. Continue to destination scrape + Layer 2 semantic dedupe.

Important nuance: the same `contentKey` may legitimately be posted once per
configured destination. LinkedIn→X and LinkedIn→Bluesky are both allowed; two
different routes to Bluesky for the same `contentKey` are not.

## When to append global state

Append to the global ledger on every meaningful outcome that proves destination
state:

- **Successful publish:** append `global.publish.success` immediately after the
  per-pair `posted.jsonl` success line.
- **Remote/fuzzy duplicate catch-up:** append `global.publish.remote_duplicate`
  when destination scrape proves the item already exists.
- **Layer 2 semantic duplicate catch-up:** append
  `global.publish.semantic_duplicate` when the semantic layer matches an
  existing destination post.
- **Global duplicate skip:** append `global.publish.catchup` so future pairs do
  not re-reason the same skip.

Do not append global success for failed/uncertain login, CAPTCHA, rate-limit, or
compose failures. Those do not prove a destination post exists.

## Audit event

When this skill skips a candidate, append to `pairs/<id>/audit.jsonl`:

```json
{
  "ts": "<ISO-8601>",
  "event": "pair.dedupe.global_duplicate",
  "pairId": "<pair-id>",
  "sourceItemId": "<candidate source id>",
  "canonicalSourceUrl": "<candidate source URL>",
  "contentKey": "<resolved contentKey>",
  "matchedPairId": "<pair that already handled it, if known>",
  "matchedDestinationPlatform": "<destination platform>",
  "matchedDestinationUrl": "<existing destination URL>",
  "reason": "same contentKey already posted/caught-up for this destination"
}
```

## See also

- `skills/repost-run/SKILL.md` — calls this before destination publish.
- `skills/repost-dedup/SKILL.md` — Layer 1 local/destination string dedupe.
- `skills/repost-dedup-semantic/SKILL.md` — Layer 2 semantic dedupe.
- `docs/state-files.md` — state schemas.
