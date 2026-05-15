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
  "event": "global.publish.success | global.publish.catchup | global.publish.semantic_duplicate | global.publish.remote_duplicate | global.publish.deleted | global.publish.malformed",
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
  "status": "posted | caught-up | skipped-duplicate | posted-malformed | deleted-malformed | deleted-runaway | deleted-source-url-leak",
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

### Crash-recovery derived-source guard

Do not rely only on the global ledger when the current source account is also a
configured destination account for another pair. A crashed or interrupted run can
create a public destination post before it writes `global-posted.jsonl`; the next
daily sweep may then scrape that public post as a fresh source and cascade it to
other platforms.

Before publishing a candidate from an owned destination account such as the X
profile used by a LinkedIn→X pair:

1. Search every local pair history (`~/.repost-with-agent/pairs/*/posted.jsonl`)
   for a live row whose `destinationUrl` / `destinationId` matches the current
   candidate's `canonicalSourceUrl` / `sourceItemId`. If found, inherit that
   row's `contentKey` and treat the current source as a derived repost output,
   not a new organic source.
2. Search source-fanout manifests under `~/.repost-with-agent/source-fanouts/`
   for destination records matching the candidate URL/id. If found, inherit the
   manifest source item key (`<sourcePlatform>:<sourceItemId>`).
3. Search active backfill queues under `~/.repost-with-agent/backfill-queues/`
   when the candidate text/link is a near-exact match for a queue item's
   `sourceBody`/clean draft, even if the failed run never wrote a manifest or
   pair ledger. Match conservatively: same expanded public URL plus an obvious
   text overlap, or ≥80-character normalized prefix/quote overlap. When this
   matches, fail closed with `derived-source-shadow` rather than publishing.
4. Append a `pair.dedupe.derived_source_shadow` audit event and a global catch-up
   line if the destination already exists; otherwise skip the candidate without
   creating a public post. The audit must name the upstream source item, the
   matched queue/manifest/ledger proof, and the reason.

This guard covers the exact failure mode where LinkedIn→X created an X post,
OpenClaw failed before state was fully written, and the daily `x-to-*` sweep saw
that X post as new source material. In that case the correct action is to repair
or catch up the original LinkedIn fanout state, not repost the derived X post to
more destinations.

## Global duplicate decision

For the current pair and candidate:

1. Resolve the candidate `contentKey` using the rules above.
2. If `pair.policy.globalDedupeEnabled === false`, skip this skill. Default is
   **enabled**.
3. Run the crash-recovery derived-source guard above. If it matches, do **not**
   publish the candidate as a normal source item; either inherit the upstream
   key and continue dedupe, or skip/catch up with `derived-source-shadow` when
   the only safe conclusion is that the source is a repost output from another
   pair/backfill.
4. Search global ledger lines for the same `contentKey` where:
   - `destinationPlatform === pair.destination.platform`, and
   - if both are present, `destinationAccountHint` / destination profile/account
     point at the same configured destination identity.
5. Compute the newest **live-success verdict** for those same-destination rows.
   A row proves live success only when its event/status is one of
   `global.publish.success`, `global.publish.catchup`,
   `global.publish.remote_duplicate`, `global.publish.semantic_duplicate`,
   `posted`, `caught-up`, or `skipped-duplicate`, it has a destination URL/ID,
   and it has no remediation/deletion/malformed flags. Newer rows with
   `global.publish.deleted`, `deleted-*`, `posted-malformed`,
   `global.publish.malformed`, `needsRepost`, or `needsRemediation` remove or
   quarantine the old proof and must not count as duplicates.
6. If the latest same-destination verdict is live success, the candidate is
   `duplicate-global` for this destination. Do **not** publish. Append:
   - a per-pair audit event `pair.dedupe.global_duplicate`, and
   - a per-pair catch-up line to `pairs/<id>/posted.jsonl`, and
   - a global catch-up line with `event: "global.publish.catchup"`,
     `status: "skipped-duplicate"`, and a note naming the matched destination.
7. If no live same-destination verdict exists, the candidate is globally unique
   for this destination. Continue to destination scrape + Layer 2 semantic
   dedupe.

Important nuance: the same `contentKey` may legitimately be posted once per
configured destination. LinkedIn→X and LinkedIn→Bluesky are both allowed; two
different routes to Bluesky for the same `contentKey` are not.

## When to append global state

Append to the global ledger on every meaningful outcome that proves destination
state. Use correction/deletion rows instead of relying on old success rows after
cleanup; future dedupe must evaluate the latest verdict, not mere row existence:

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
compose failures. Those do not prove a destination post exists. If a previously
recorded destination post is deleted or found malformed/source-url-leaking,
append `global.publish.deleted` or `global.publish.malformed` with the old URL,
status (`deleted-malformed`, `deleted-runaway`, `deleted-source-url-leak`, or
`posted-malformed`), and `needsRepost` / `needsRemediation` as appropriate so
later runs do not treat stale proof as live.

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

For derived-source suppression, append the sibling shape:

```json
{
  "ts": "<ISO-8601>",
  "event": "pair.dedupe.derived_source_shadow",
  "pairId": "<pair-id>",
  "sourceItemId": "<candidate source id>",
  "canonicalSourceUrl": "<candidate source URL>",
  "contentKey": "<inherited upstream contentKey if known>",
  "matchedUpstreamSourcePlatform": "linkedin",
  "matchedUpstreamSourceItemId": "urn:li:activity:...",
  "matchedProof": "global-ledger | pair-ledger | source-fanout-manifest | backfill-queue-text-match",
  "reason": "source post is a public destination output from another pair/backfill; repair upstream state instead of cascading"
}
```

## See also

- `skills/repost-run/SKILL.md` — calls this before destination publish.
- `skills/repost-dedup/SKILL.md` — Layer 1 local/destination string dedupe.
- `skills/repost-dedup-semantic/SKILL.md` — Layer 2 semantic dedupe.
- `docs/state-files.md` — state schemas.
