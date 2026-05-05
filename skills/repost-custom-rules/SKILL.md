---
name: repost-custom-rules
description: User-configured allow/skip rules for Repost-with-agent candidates. Apply before dedupe/publish so Ethan can block categories such as X video/livestream promos without polluting publish ledgers.
when_to_trigger: Any repost-run/backfill candidate evaluation where pairs.json contains top-level customRules or pair-level customRules, or when the user asks to block/allow certain source posts in Repost-with-agent.
---

# Repost Custom Rules

Custom rules are a user preference filter that runs AFTER source scrape and
BEFORE dedupe / URL expansion / publish. They answer: “even if this is new,
should we refuse to repost it?”

They are NOT publish proof and NOT duplicate proof. A rule skip must never be
recorded as a successful post.

## State locations

Rules live in `~/.repost-with-agent/pairs.json`:

- Top-level `customRules`: apply globally across pairs.
- Pair-level `pair.customRules`: apply only to that pair.

Append-only considered/skipped state lives at:

```text
~/.repost-with-agent/considered.jsonl
```

This file records candidates the agent has already considered and rejected for
a user-rule reason. It prevents every scheduled tick/backfill from re-reasoning
the same not-post-worthy item, without touching append-only publish ledgers.

## Rule schema

```json
{
  "id": "skip-x-ai-slop-machine-videos",
  "enabled": true,
  "action": "skip",
  "scope": {
    "sourcePlatform": "x"
  },
  "match": {
    "anyOf": [
      { "sourceItemIds": ["2051336931150123230"] },
      {
        "semanticSimilarToAny": [
          "vibe coding an ai slop machine #ai #programming #developer",
          "video or livestream promo about vibe-coding an AI slop machine"
        ],
        "mediaTypesAny": ["video", "livestream", "live"],
        "treatUnknownMediaAsMatch": true
      }
    ]
  },
  "reason": "Ethan does not want X video/livestream promo posts about vibe-coding an AI slop machine reposted.",
  "examples": [
    {
      "sourcePlatform": "x",
      "sourceItemId": "2051336931150123230",
      "canonicalSourceUrl": "https://x.com/REEEthan_YT/status/2051336931150123230",
      "text": "vibe coding an ai slop machine #ai #programming #developer"
    }
  ],
  "createdAt": "<ISO-8601>",
  "updatedAt": "<ISO-8601>"
}
```

### Supported matching fields

A rule matches a candidate only when the rule is enabled, action is `skip`, the
scope matches, and the match object matches.

Scope fields:

- `pairIds`: optional list. If present, current `pair.id` must be listed.
- `sourcePlatform`: optional exact platform string.
- `destinationPlatforms`: optional list. If present, current
  `pair.destination.platform` must be listed.

Match fields:

- `sourceItemIds`: exact source item IDs.
- `canonicalSourceUrls`: exact canonical source URLs.
- `textIncludesAll`: all listed substrings must appear in normalized text.
- `textIncludesAny`: at least one listed substring must appear in normalized text.
- `textRegex`: regex string the candidate text must match.
- `semanticSimilarToAny`: agent judgment. Match if the candidate has the same
  communicative content/topic as any listed example; lean conservative when the
  user explicitly wanted that content blocked.
- `mediaTypesAny`: at least one candidate media type must match. Expected values
  include `image`, `video`, `livestream`, `live`, `gif`, `link-card`, `none`,
  and `unknown`.
- `treatUnknownMediaAsMatch`: when `true`, a candidate with unknown media status
  passes `mediaTypesAny`. Use sparingly for user-block rules where missing a
  bad post is worse than skipping a possibly-good one.

Composition:

- Conditions inside one match object are ANDed.
- `anyOf` is an OR of match objects.
- `allOf` is an AND of match objects.
- A match object can combine `allOf` / `anyOf` with ordinary fields.

## Candidate shape requirement

Source scrape should collect the normal repost fields plus media hints when the
source platform exposes them:

```json
{
  "sourceItemId": "<platform item id>",
  "canonicalUrl": "<source URL>",
  "text": "<visible post body>",
  "publishedAt": "<ISO-8601>",
  "mediaTypes": ["video"],
  "mediaEvidence": "visible video player / Live badge / aria-label text"
}
```

If media cannot be determined, set `mediaTypes: ["unknown"]` rather than
pretending it is text-only.

## Evaluation procedure

1. Read top-level `customRules` and `pair.customRules` from
   `~/.repost-with-agent/pairs.json`. Missing arrays mean no custom rules.
2. Read `~/.repost-with-agent/considered.jsonl` if it exists.
3. If the candidate already has a considered line where:
   - `sourcePlatform` and `sourceItemId` (or canonical URL) match, and
   - `status === "skipped-rule"`, and
   - scope is global or the `pairId`/destination fields match this run,
   then drop the candidate before dedupe. Do not append another duplicate
   considered line just because a later scheduled tick saw it again.
4. Evaluate enabled custom rules in order. For the first matching skip rule:
   - Drop the candidate from the publish set.
   - Append one `candidate.custom_rule.skipped` line to
     `~/.repost-with-agent/considered.jsonl` if that exact
     `(ruleId, sourcePlatform, sourceItemId/canonicalUrl, pair/destination scope)`
     is not already present.
   - Append a per-pair audit event `pair.custom_rule.skipped` for this run.
   - Continue with the next candidate; do not run dedupe or compose for the
     skipped candidate.
5. Candidates that do not match any custom rule proceed to local/global/remote
   dedupe and Layer 2 semantic dedupe.

## Considered line schema

```json
{
  "ts": "<ISO-8601>",
  "event": "candidate.custom_rule.skipped",
  "ruleId": "skip-x-ai-slop-machine-videos",
  "pairId": "<optional pair id when destination-specific>",
  "sourcePlatform": "x",
  "sourceItemId": "2051336931150123230",
  "canonicalSourceUrl": "https://x.com/REEEthan_YT/status/2051336931150123230",
  "destinationPlatform": "<optional destination platform>",
  "destinationAccountHint": "<optional configured destination account hint>",
  "candidateExcerpt": "<first 200 chars>",
  "mediaTypes": ["video"],
  "status": "skipped-rule",
  "reason": "<human reason from rule>",
  "note": "<optional migration/context note>"
}
```

Invariants:

- Append-only. Never rewrite existing considered lines.
- Do not append to `posted.jsonl` or `global-posted.jsonl` for a pure custom-rule
  skip. Those ledgers mean destination state was proven; a preference skip does
  not prove destination state.
- A custom-rule skip does not trigger the publish-confirmation Telegram ping.
  That ping is for successful publishes only.
- It is fine to surface a concise transcript summary in a scheduled run. Include
  the operational identifiers so the scheduler transcript is not ambiguous:
  `Skipped <pairId>: <sourceItemId> <canonicalSourceUrl> matched custom rule <ruleId>.`
  Do not send one Telegram message per skip unless Ethan explicitly asks.

## Current Ethan rule seeded 2026-05-05

Ethan wants the X video/livestream item below — and future matching X
video/livestream promos — blocked from reposting:

- Source: `https://x.com/REEEthan_YT/status/2051336931150123230`
- Text: `vibe coding an ai slop machine #ai #programming #developer`
- Rule id: `skip-x-ai-slop-machine-videos`

This item had already been posted to Bluesky, Threads, and Facebook before the
rule existed. Do not rewrite or remove those append-only publish/global ledger
records. Treat the seeded considered entry only as “from now on, this kind of
candidate is not post-worthy.”

## See also

- `skills/repost-run/SKILL.md` — applies this immediately after source scrape.
- `skills/repost-backfill/SKILL.md` — applies this before backfill dedupe and
  inside the publish loop when refreshing candidates.
- `docs/state-files.md` — formal schema for `customRules` and
  `considered.jsonl`.
