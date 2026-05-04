---
name: repost-dedup-semantic
description: Layer 2 semantic-similarity dedupe for Repost-with-agent. After Layer 1 (exact + fuzzy-string match) returns "no duplicate", you (the agent) read the candidate draft alongside the destination's most recent posts and use your OWN reasoning to decide whether the candidate is "saying the same thing in different words" as anything already on the destination. If yes, skip the publish — Ethan would rather miss a post than ship an embarrassing paraphrased duplicate.
when_to_trigger: Any time the publish flow has a Layer-1-clean candidate ready to post AND `pair.policy.semanticDedupeEnabled !== false`. Runs once per candidate, immediately before the actual compose-and-publish step. Called from `skills/repost-run/SKILL.md` (single-post) and `skills/repost-backfill/SKILL.md` (per loop iteration).
---

# Repost Dedup — Layer 2 (semantic similarity)

> **Why this skill exists.** Ethan voice 6106 (2026-05-01): *"It should make
> sure the agent actually semantically looks and processes the content of
> the message and checks the target destination and sees if there's a post
> with similar wording already there. If because there is, then it shouldn't
> go through. So the ID thing in the JSON files, etc., that's precise, and
> that's like layer one. But layer two is it should check the semantics, and
> if there's something already similar, it shouldn't post a duplicate.
> That'll be embarrassing."*

This is Layer 2 of a two-layer dedupe pipeline. Layer 1 catches verbatim
re-posts via cheap string ops; Layer 2 catches **paraphrased duplicates**
via your own semantic reasoning.

## Layer separation

| Layer | Skill                          | Method                                                          | Catches                                    | Cost                  |
| ----- | ------------------------------ | --------------------------------------------------------------- | ------------------------------------------ | --------------------- |
| 1     | `repost-dedup`                 | Exact `sourceItemId` lookup + fuzzy-string match (normalize, ≥80-char prefix overlap) | Verbatim and near-verbatim re-posts       | Cheap (string ops)    |
| 2     | `repost-dedup-semantic` (this) | Agent reads candidate + recent destination posts, makes a judgment | Paraphrased duplicates ("same point, different words") | One pass of your reasoning |

Both run in series. Layer 1 first as a quick filter; Layer 2 only on
candidates that survived Layer 1. **A candidate must pass BOTH to publish.**

## Required inputs

Before you start this skill you should already have:

1. The **candidate draft** (the body you're about to publish, post-URL-expansion).
2. The **destination's recent post bodies** scraped during Layer 1 (if Layer
   1 already scraped them, reuse — don't re-scrape). Default window: the most
   recent **30** posts. Override per-pair via `pair.policy.semanticDedupeWindowSize`.
3. The **pair config**, specifically `pair.policy.semanticDedupeEnabled`
   (default `true`) and `pair.policy.semanticDedupeWindowSize` (default `30`).

If `semanticDedupeEnabled === false`, skip this skill entirely and proceed
to publish. Don't append any audit event — the user explicitly opted out.

If you don't have the destination scrape from Layer 1 (e.g. Layer 1 was
skipped or its scrape failed), this skill cannot run reliably. Behave as
"uncertain": if `pair.policy.blockOnUncertainDuplicate === true` (default),
SKIP the candidate and append `pair.dedupe.uncertain` audit with reason
`"semantic-dedupe-no-destination-scrape"`. If `false`, proceed to publish.

## The judgment you have to make

For each candidate, ask yourself this question literally:

> **Would a reader who has already seen one of the existing destination posts
> find the candidate redundant?**

That's the threshold. Not "do they share keywords" — Layer 1 already handles
keyword overlap. The Layer 2 question is about **communicative function**:
is the candidate making essentially the same point, the same announcement,
the same opinion, the same claim, with the same call-to-action implied or
stated? If yes → it's a paraphrased duplicate, skip. If the candidate has
genuine new information, a different angle, a different communicative
function, or addresses a different audience → proceed.

## Worked examples

### GOOD MATCH (skip — semantic duplicate)

- **Existing destination post:** "Just shipped a new feature for cross-posting between LinkedIn and X — agents do the work, no APIs, no Playwright."
- **Candidate draft:** "We just launched our cross-poster from LinkedIn to X. Pure agent-driven. No APIs needed."
- **Reasoning:** Same announcement, near-identical claims (cross-posting, LinkedIn→X, agent-driven, no APIs), same implied call-to-action. A reader who saw the existing post would absolutely find this redundant. **Skip.**

### WEAK MATCH (proceed — same theme, different function)

- **Existing destination post:** "Why I'm bullish on agent-driven workflows for content syndication."
- **Candidate draft:** "We just shipped a cross-poster for LinkedIn → X."
- **Reasoning:** Existing is a thesis / opinion piece. Candidate is a launch announcement. They share a theme (agent-driven syndication) but their **communicative function differs** — one frames a worldview, the other reports a concrete release. A reader who saw the thesis would still want to know about the launch. **Proceed.**

### GOOD MATCH (skip — rephrased opinion)

- **Existing destination post:** "Why I think Claude Sonnet 4.6 outperforms 4.5 on agent tasks."
- **Candidate draft:** "Claude Sonnet 4.6 is way better than 4.5 for agentic workflows."
- **Reasoning:** Same opinion, same comparison (4.6 vs 4.5), same conclusion (4.6 wins on agents). The candidate is just a tighter rephrasing of the same claim. **Skip.**

### WEAK MATCH (proceed — same topic, different specifics)

- **Existing destination post:** "Sonnet 4.6 finally crossed 90% on the SWE-bench verified subset."
- **Candidate draft:** "Sonnet 4.6 added a 200K context window without inference-cost regression."
- **Reasoning:** Both are about Sonnet 4.6, but they cite different facts (SWE-bench score vs context-window pricing). Each adds independent information. A reader of the first wouldn't have learned the second. **Proceed.**

### GOOD MATCH (skip — same announcement, different framing)

- **Existing destination post:** "v4.3.0 is live — Layer 2 semantic dedupe is shipping. No more embarrassing paraphrased duplicates."
- **Candidate draft:** "Just shipped Repost-with-agent v4.3 with semantic dedupe baked in. Bye bye duplicate posts."
- **Reasoning:** Same release, same version, same headline feature, same outcome claim. **Skip.**

### EDGE CASE (proceed — quote / commentary distinction)

- **Existing destination post:** "Anthropic just released Claude Opus 4.7."
- **Candidate draft:** "Anthropic just released Claude Opus 4.7. My early take: the 1M-context variant is a massive deal for codebase work."
- **Reasoning:** Candidate quotes the existing fact but adds a substantive personal opinion (1M context is a massive deal for codebase work). The added commentary is the new communicative content. **Proceed.** (If you're conservative and think this is a borderline call, lean toward skipping — Ethan would rather miss a post than be embarrassed.)

## The procedure

1. **Confirm Layer 1 already ran and returned "unique".** If not, stop —
   Layer 2 only runs on Layer-1-clean candidates.

2. **Load the destination scrape window.** Take the most recent
   `windowSize` (default 30) post bodies from the destination scrape Layer
   1 produced. If fewer than `windowSize` posts exist, use whatever Layer 1
   gathered.

3. **Read the candidate draft AND the destination posts.** Hold both in
   your reasoning. You don't need to dump them to disk — this is an
   in-context read.

4. **For each existing post in the window**, ask the question from "The
   judgment you have to make" above. Walk through the comparison
   explicitly in your reasoning:
   - What's the candidate's main point / announcement / opinion?
   - What's the existing post's main point / announcement / opinion?
   - Would a reader of the existing post find the candidate redundant?
   - Apply the worked-example mental model from above.

5. **First match wins.** As soon as you decide one existing post is a
   semantic duplicate of the candidate, stop comparing and treat the
   candidate as a duplicate. (No need to score every existing post — one
   match is enough.)

6. **Lean conservative.** When genuinely on the fence between "proceed" and
   "skip", **skip**. Ethan voice 6106: *"that'll be embarrassing."* The
   cost of a missed post is low; the cost of an embarrassing duplicate is
   high. Asymmetric — bias toward skip.

## Outcomes

You produce one of two verdicts per candidate:

### `semantic-duplicate` — skip publish

- DO NOT call the publish flow for this candidate.
- Append a `pair.publish.semantic_duplicate` audit event to
  `~/.repost-with-agent/pairs/<id>/audit.jsonl` with these fields:
  ```json
  {
    "ts": "<ISO-8601>",
    "event": "pair.publish.semantic_duplicate",
    "pairId": "<id>",
    "sourceItemId": "<candidate sourceItemId>",
    "candidateExcerpt": "<first 200 chars of candidate draft>",
    "matchedExistingUrl": "<destination URL of the matched existing post>",
    "matchedExistingExcerpt": "<first 200 chars of the matched existing post>",
    "agentReasoning": "<1-3 sentence justification — why these are the same communicative content>",
    "windowSize": <int — number of posts you compared against>
  }
  ```
- Append a catch-up entry to `posted.jsonl` so this `sourceItemId` is
  treated as Layer-1 done on next run (avoids re-doing Layer 2 on the same
  candidate next tick). Also append a matching catch-up line to
  `~/.repost-with-agent/global-posted.jsonl` with
  `event: "global.publish.semantic_duplicate"`, the resolved `contentKey`, and
  `status: "skipped-duplicate"` so every other pair learns this destination
  already has the content:
  ```json
  {"ts":"<ts>","sourceItemId":"<id>","canonicalSourceUrl":"<src>","destinationUrl":"<matchedExistingUrl>","destinationId":"<dest id>","note":"caught-up via Layer 2 semantic dedupe"}
  ```
- Tell the user (in the agent transcript, NOT Telegram): "Skipped — Layer 2
  semantic-duplicate of <matchedExistingUrl>." Include the 1-3 sentence
  reasoning so the user can sanity-check.
- For multi-candidate flows (backfill), continue to the next candidate in
  the loop.

### `semantic-unique` — proceed to publish

- Continue to the regular publish step in the calling skill (`repost-run`
  step 8 / `repost-backfill` step 6 publish branch).
- No audit event needed for a clean pass — the existing
  `pair.publish.start` / `pair.publish.success` events will fire.
- (Optional): if you want a paper trail that Layer 2 ran and cleared, you
  may append `pair.dedupe.semantic_clean` with `{candidateExcerpt,
  windowSize, candidatesCompared}`. Not required by the schema but useful
  for retrospective analysis.

## Telegram

This skill does NOT send a Telegram message itself. The non-negotiable
Telegram-confirm rule applies only to **successful publishes**; a skipped
candidate is the absence of a publish, so no ping is owed. The successful-
publish ping happens in the calling skill after Layer 2 returns
`semantic-unique`.

If you want to surface a streak of skips to Ethan (e.g. backfill skipped
all 10 candidates as semantic duplicates), include that in the regular
final-summary message the calling skill sends — don't fire a separate
Telegram for each Layer 2 skip.

## Failure modes

- **Destination scrape missing.** Treat as uncertain (see "Required inputs"
  above). Don't guess.
- **Candidate is empty / single emoji / pure URL.** Bail out — Layer 2
  needs prose to reason about. Treat as `semantic-unique` and proceed (or
  defer to a length / sanity check earlier in the flow).
- **Window is empty (destination is brand-new and has zero posts).** No
  existing posts means no possible semantic duplicates. Treat as
  `semantic-unique` and proceed.

## Tuning the window size

`pair.policy.semanticDedupeWindowSize` defaults to 30. This is enough for
most accounts: 30 recent posts on a typical destination covers ~1–4 weeks
of activity.

- **High-volume destinations (X power-users, multiple posts per day):**
  consider raising to 50–100 if duplicates from older posts are a concern.
- **Low-volume destinations (Substack-style, weekly cadence):** 30 is
  plenty; even 10 may be enough.
- **Cost trade-off:** larger windows give you more posts to compare
  against (better recall) but slow your reasoning pass. 30 is the sweet
  spot empirically.

## Read order with Layer 1

The publish flow now looks like:

```
Step 4 — Layer 1 dedupe (skills/repost-dedup)
    ├── local — posted.jsonl exact match
    ├── global — cross-pair contentKey ledger
    └── remote — destination fuzzy-string match
Step 4.5 — Layer 2 semantic dedupe (THIS SKILL)
    └── agent reasoning over candidate + destination scrape
Step 5+ — pick newest non-duplicate, expand URLs, length check
Step 8 — publish
Step 9 — append posted.jsonl
Step 10 — Telegram-confirm
```

A candidate is "publishable" iff it cleared BOTH Layer 1 and Layer 2.

## See also

- `skills/repost-dedup/SKILL.md` — Layer 1 (exact + fuzzy string match).
- `skills/repost-global-dedupe/SKILL.md` — global cross-pair content ledger.
- `skills/repost-run/SKILL.md` — single-post flow that calls this skill at step 4.5.
- `skills/repost-backfill/SKILL.md` — multi-post flow that calls this skill per loop iteration.
- `skills/repost-notify/SKILL.md` — Telegram payload spec (only on successful publish).
- `docs/state-files.md` — `pair.publish.semantic_duplicate` audit event schema + the `pair.policy.semanticDedupeEnabled` / `semanticDedupeWindowSize` fields.
- `docs/destinations/<platform>.md` — per-platform notes including window-size guidance.
