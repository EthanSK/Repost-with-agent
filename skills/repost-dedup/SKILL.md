---
name: repost-dedup
description: Reference for the Repost-with-agent dedupe algorithm — how to check a candidate against per-pair history, the global cross-pair ledger, and recent destination posts to avoid double-posting. Used by repost-run, repost-backfill, and any other publish path.
when_to_trigger: Any time you (the agent) need to decide whether a candidate post is already published locally, globally across pairs, or remotely on the destination platform.
---

# Repost Dedup — Layer 1 (exact + fuzzy string matching)

Reference algorithm for deciding whether a candidate post is a duplicate of
something already on the destination. Custom user rules run before this skill;
see `skills/repost-custom-rules/SKILL.md` for not-post-worthy preference skips.
Then three dedupe checks run before publish: local (per-pair `posted.jsonl`),
global (cross-pair `global-posted.jsonl`), and remote (against the actual
destination feed).

This skill is **Layer 1** of a two-layer dedupe pipeline. It catches
verbatim and near-verbatim re-posts via cheap string ops. **Layer 2**
(`skills/repost-dedup-semantic/SKILL.md`) catches paraphrased duplicates via
agent semantic reasoning. Both layers must clear before publish — see
"Layer separation" below.

## Why two checks?

- **Local** is fast and exact (`sourceItemId` lookup), but only catches posts
  this one pair recorded.
- **Global** is fast and cross-pair. It catches the same underlying content
  moving through different hops, for example LinkedIn→X→Bluesky racing with
  a direct X→Bluesky pair.
- **Remote** is slower (browser scrape) but catches manual posts, posts from
  another tool, retweets, etc.

All three checks are mandatory before any publish unless the user explicitly
disables global dedupe for a pair with `pair.policy.globalDedupeEnabled: false`.
A candidate skipped by custom rules should not reach this dedupe stage and must
not be appended to `posted.jsonl` / `global-posted.jsonl`.

## Layer separation — Layer 1 vs Layer 2

Repost-with-agent v4.3+ runs dedupe in two passes:

| Layer | Skill                          | Method                                                                                | Catches                                                | Cost                |
| ----- | ------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------- |
| 1     | `repost-dedup` (this skill)    | Exact `sourceItemId` lookup + fuzzy-string match (normalize + ≥80-char prefix overlap) | Verbatim and near-verbatim re-posts                    | Cheap (string ops)  |
| 2     | `repost-dedup-semantic`        | Agent reads candidate + recent destination posts and judges semantic redundancy        | Paraphrased duplicates ("same point, different words") | One reasoning pass  |

Layer 1 runs first as a quick filter. Only candidates that survive Layer 1
proceed to Layer 2. **A candidate is publishable iff it clears BOTH layers.**

Layer 1 cannot catch a paraphrase like "We just shipped X — agents do the
work, no APIs" vs. an existing "Just launched the X cross-poster. Pure
agent-driven, no API needed." The strings differ enough that fuzzy-prefix
overlap won't trigger; only Layer 2's semantic check catches it. Conversely,
Layer 2 is wasted on verbatim re-posts where Layer 1's string match is
trivially correct and orders of magnitude cheaper. Run them in series.

Layer 2 is enabled by default (`pair.policy.semanticDedupeEnabled: true`)
and can be turned off per-pair if you genuinely want only string-level
dedupe.

## Local dedupe

1. Read `~/.repost-with-agent/pairs/<id>/posted.jsonl` (line-delimited JSON,
   may be empty or missing).
2. For each line, parse the JSON and extract `sourceItemId`.
3. Build a Set of all `sourceItemId`s.
4. For each candidate:
   - If `candidate.sourceItemId` is in the Set → DUPLICATE.
   - Else → not a local duplicate (proceed to remote check).

Use `jq` or grep for speed if posted.jsonl is large:

```bash
jq -r '.sourceItemId' ~/.repost-with-agent/pairs/<id>/posted.jsonl | grep -Fxq "<candidate-id>"
# exit 0 → duplicate, exit 1 → not duplicate
```

## Global cross-pair dedupe

Read `~/.repost-with-agent/global-posted.jsonl` (append-only NDJSON; may be
missing). Use `skills/repost-global-dedupe/SKILL.md` to resolve a candidate
`contentKey` and detect whether any pair has already posted/caught-up that
content for this pair's destination platform/account.

Key points:

1. Default `pair.policy.globalDedupeEnabled` is `true`. Treat missing as true.
2. Resolve `contentKey` from `<sourcePlatform>:<sourceItemId>` or canonical URL.
3. If the candidate source is itself a destination post from another pair
   (e.g. an X status created by LinkedIn→X), inherit that earlier line's
   `contentKey` so the downstream pair still represents the LinkedIn-origin
   content.
4. If the same `contentKey` already has a global ledger line for the current
   destination platform/account, verdict is `duplicate-global`. Skip and append
   the audit/catch-up lines described in `repost-global-dedupe`.
5. If no same-destination global line exists, continue to destination scrape.

This check is what makes all pairs look globally instead of thinking in silos.

## Remote dedupe (destination scrape)

1. Use current-harness browser automation to navigate to `pair.destination.profileUrl`.
2. Scroll to load 50–100 recent destination posts (this covers ~7 days for
   active accounts; tune per platform).
3. For each loaded destination post, extract its visible text body.
4. Normalize both candidate text and destination text BEFORE comparing:
   - Collapse whitespace: replace runs of `\s+` with single ` `.
   - Lowercase: `tolower`.
   - Strip URLs: remove every `https?://\S+` token. (Why? X / Bluesky rewrite
     URLs into shortened aliases like `t.co/abc123` that won't match the
     original `lnkd.in/abc` from the source.)
   - Strip trailing punctuation: `.!?,;:` and quotes.
5. Compare:
   - **Exact match on the normalized strings** → DUPLICATE.
   - **≥80-char prefix overlap** (i.e. the first 80 normalized chars of the
     candidate appear at the start of the destination post, or vice versa) →
     DUPLICATE.
   - Else → not a duplicate.

Why 80 chars? It's enough that incidental phrases ("good morning everyone")
won't match by accident, but short enough that truncated reposts (e.g. when
the destination has a tighter char cap and the body was cut) still match.

## Uncertain matches

If the destination scrape fails (network error, page failed to load, CAPTCHA
modal, login expired):

- Treat all candidates as "uncertain".
- If `pair.policy.blockOnUncertainDuplicate === true` (default): SKIP all
  candidates this run.
- If `false`: proceed and publish anyway (Ethan would rather see a near-
  duplicate than miss a post — but the default is conservative).

Append a `pair.dedupe.uncertain` audit event with the reason.

## Implementation hints

For the running agent: the simplest implementation is to do everything in
memory in your context. You don't need a script — just read the JSON / scrape
the page / compare strings.

If you want to factor into Bash for a backfill of 50+ candidates, here's a
sketch:

```bash
# Normalize a string (whitespace + lowercase + strip URLs + trailing punct).
normalize() {
  echo "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's#https?://[^[:space:]]+##g' \
    | sed -E 's/[[:space:]]+/ /g' \
    | sed -E 's/[[:punct:]]+$//'
}
```

But honestly, doing it in your reasoning is fine for the small candidate
counts (≤20) you'll typically see.

## Output for the calling skill

For each candidate, produce one of three verdicts:

- `duplicate-local` — found in this pair's `posted.jsonl`. Skip.
- `duplicate-global` — found in `global-posted.jsonl` for this destination.
  Skip + append the global/per-pair catch-up records from
  `skills/repost-global-dedupe/SKILL.md`.
- `duplicate-remote` — found in the destination scrape. Skip + append a
  catch-up entry to `posted.jsonl` so we don't re-check next run:

  ```json
  {"ts":"<ts>","sourceItemId":"<id>","canonicalSourceUrl":"<src>","destinationUrl":"<destination url where match was found>","destinationId":"<id>","note":"caught-up via destination dedupe"}
  ```

- `unique` — neither match. Eligible for publish.
- `uncertain` — cannot determine. See "Uncertain matches" above.

## See also

- `skills/repost-custom-rules/SKILL.md` — user preference skip rules +
  append-only considered state; runs before this dedupe layer.
- `skills/repost-dedup-semantic/SKILL.md` — **Layer 2** semantic dedupe (agent
  reasoning over candidate vs. recent destination posts). Runs AFTER this
  skill on Layer-1-clean candidates. Catches paraphrased duplicates.
- `skills/repost-global-dedupe/SKILL.md` — cross-pair contentKey ledger.
- `skills/repost-run/SKILL.md` — calls this dedupe at step 4 (Layer 1) and
  `repost-dedup-semantic` at step 4.5 (Layer 2).
- `skills/repost-backfill/SKILL.md` — runs Layer 1 once across the full
  candidate set (newest-first) and Layer 2 per loop iteration before the
  publish loop.
- `docs/destinations/<platform>.md` — per-platform quirks (e.g. X's `t.co`
  rewriting, Bluesky's link cards) plus Layer 2 window-size guidance.
