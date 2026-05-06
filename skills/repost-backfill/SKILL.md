---
name: repost-backfill
description: Walk back through historical source posts and repost the missing ones (newest-first). Use when the user asks to "backfill <pair>", "catch up the destination", "repost the last N posts", or invokes /repost-backfill. Multi-post operation with rate-limiting between publishes.
when_to_trigger: User wants to fill in missed historical posts on the destination, e.g. "backfill the last 10 LinkedIn posts to X", "catch up the X feed".
---

# Repost Backfill

Multi-post variant of `repost-run`. Walks back through historical source posts
newest-first.

There are two valid units:

- **Source-item fanout (default for source-level/scheduled backfills):** select
  one source item and process every enabled destination pair for that source
  together using `skills/repost-source-fanout/SKILL.md`.
- **Destination-specific pair backfill:** process one `<pair-id>` only when the
  user explicitly asks for a single destination/pair repair or job.

This is a separate skill from `repost-run` because the loop, dedupe ordering,
fanout manifest, and rate-limiting differ.

## Required tools

Same as `repost-run`: Read, Edit, Write, Bash, current-harness browser
automation, and configured current-harness user-message delivery.

## Step 1 — Load config, resolve unit, and read backfill options

1. Read `~/.repost-with-agent/pairs.json`.
2. Resolve the requested unit:
   - `source:<platform>`, "LinkedIn backfill slot", "backfill LinkedIn to all",
     or any source-level scheduled prompt → **source-item fanout**. Load
     `skills/repost-source-fanout/SKILL.md` and follow it for the selected
     source item.
   - `<pair-id>` → destination-specific pair backfill. This is valid only when
     the user explicitly asks for that pair/destination.
3. For source-item fanout, enumerate enabled pairs for the source before
   posting anything. The slot is not complete until every enabled destination
   has a manifest status: posted, already-posted/caught-up, skipped by rule or
   policy, explicitly blocked with reason/nextAction, or partial.
4. For destination-specific pair backfill, find the pair. Note any top-level
   `customRules` and pair-level `pair.customRules`; they run before backfill
   dedupe/publish.
5. Verify every pair you may publish has `enabled === true` and either:
   - `pair.runMode === "backfill"`, OR
   - The user explicitly asks for a one-shot backfill on a different runMode (in
     which case just remind them this is one-shot, not a permanent runMode change).
6. Ask the user (or accept from the slash command args):
   - `--max <N>` how many source items to backfill (default 10, hard cap 50 unless user explicitly says larger). For source fanout, `max` counts source items, not destination posts.
   - `--interval <minutes>` requested delay between source items / publishes (default 10 for planning; actual publish delay is floored by each pair's `policy.minDelayBetweenPostsMinutes`, normally 60).
   - `--allow-publish` (boolean — default false). Without this flag, do a dry-run preview of every candidate but DON'T publish. With this flag, actually publish where pair mode allows it.
7. Compute `effectiveIntervalMinutes = max(--interval or 10, pair.policy.minDelayBetweenPostsMinutes or 60)` for every publish-capable pair. If the user supplied a lower interval, tell them the pair policy floor won; never rapid-fire publishes below the configured floor.
8. Verify `pair.mode !== "preview-only"` if `--allow-publish` is set for that pair. If `preview-only`, refuse/skip that destination and mark it blocked or preview-only in the fanout manifest rather than silently pretending it completed.

## Step 1.5 — Read pair learnings (institutional memory)

Read `~/.repost-with-agent/pairs/<id>/learnings.md` if it exists. Backfill is
the highest-volume publish path on this plugin, so prior learnings about
this pair's pagination caps, rate-limit signatures, destination-dedupe
quirks, and per-account DOM oddities are especially valuable here.

**Priority order — read this carefully:**

1. **First, scan the most-recent entry's `### Selectors` and `### Step
   playbook` sub-sections.** Use them VERBATIM in steps 3 (source
   pagination) and 6 (publish loop) — they're a recipe the prior run
   already verified worked, so you skip the DOM re-discovery cost on every
   loop iteration.
2. **Second, scan the entry's `### Quirks` block** for rate-limit
   signatures, pagination caps, and "skip if X" rules. Backfill loops
   exercise these the most aggressively, so plan around them up front
   (e.g. set `intervalMinutes` to whatever the prior run found cleared
   the rate-limit modal).
3. **Third, scan older entries** for any superseding context.
4. **Fall back to `docs/destinations/<platform>.md` ONLY when learnings.md
   is silent on a step**, OR when a cached selector fails to match the
   live DOM.

When a cached selector / step FAILS mid-loop, capture the updated
mechanics in your reasoning and flush them at the **Final step** below.

Track newly-discovered quirks in your reasoning as the loop runs — for
example, "between item 7 and item 8 the destination's rate-limit modal
appeared after a 4-min gap", or "scrolling past the 60th source item
shows a 'You're caught up' footer instead of more posts on this account".
Don't append to learnings.md mid-loop; batch the writes at the **Final
step** below so a mid-loop crash doesn't corrupt the file with a
half-written entry.

Full rules + entry shape (with the 3 optional `###` sub-sections):
`skills/repost-learnings/SKILL.md`.

## Step 2 — Resume state file

Backfill is interruptible. Keep an idempotent state file at
`~/.repost-with-agent/pairs/<id>/backfill-state.json`:

```json
{
  "startedAt": "<ISO-8601>",
  "max": 10,
  "intervalMinutes": 60,
  "completedSourceItemIds": ["urn:li:activity:7000", "..."],
  "skippedSourceItemIds": ["urn:li:activity:6999"]
}
```

If this file exists from a previous run and `--resume` is set, load it and skip
already-completed items.

## Step 3 — Source pagination

Use current-harness browser automation to walk back through historical posts on the source
profile. Per-platform pagination differs — see `docs/destinations/<platform>.md`.

For LinkedIn:

- Profile URL: `https://www.linkedin.com/in/<handle>/recent-activity/all/`.
- Scroll to load. LinkedIn's recent-activity feed virtualizes aggressively;
  scrape as you scroll, don't rely on all loaded posts staying in the DOM.
- Hard cap: ~100 historical posts before LinkedIn pagination gives up.

For X / Bluesky / Threads / Facebook: see per-platform docs.

Collect candidates UNTIL you have at least `max` non-duplicate items (after
running step 4 dedupe), or you exhaust the platform's pagination.

## Step 3.5 — Apply custom user rules + considered state

Before Layer 1 dedupe, use `skills/repost-custom-rules/SKILL.md` on the full
collected source set.

1. Read `~/.repost-with-agent/considered.jsonl` if it exists and drop candidates
   already recorded as `status: "skipped-rule"` for this source id/URL and
   matching global/pair/destination scope.
2. Evaluate top-level `customRules` and pair-level `pair.customRules`.
3. For each new custom-rule skip, append `candidate.custom_rule.skipped` to
   `considered.jsonl` unless already present, append `pair.custom_rule.skipped`
   to this pair's `audit.jsonl`, record the item in `backfill-state.json` as
   skipped, and remove it from the publish set.
4. Do NOT append custom-rule skips to `posted.jsonl` or
   `global-posted.jsonl`; no destination state was proven.

Current Ethan rule to respect if present in config: X source video/livestream
promos matching `vibe coding an ai slop machine #ai #programming #developer`
(rule id `skip-x-ai-slop-machine-videos`) are skipped for future reposts.

## Step 4 — Layer 1 dedupe (full set: local + global + destination)

Same algorithm as `repost-run` step 4 (see `skills/repost-dedup/SKILL.md`),
applied to the full collected set after custom-rule filtering. **Layer 1** =
cheap string ops over local history, the global cross-pair content ledger, and
the destination scrape.

1. **Local dedupe.** Drop any item whose `sourceItemId` is in this pair's
   `posted.jsonl`.
2. **Global cross-pair dedupe.** Use
   `skills/repost-global-dedupe/SKILL.md` to resolve each candidate's
   `contentKey` and drop any item already posted/caught-up for this
   destination platform/account by any pair. This prevents alternate routes
   like LinkedIn→X→Bluesky and X→Bluesky from double-posting the same content.
3. **Destination dedupe.** Scrape ~50–100 recent destination posts ONCE at the
   start of the run, not per-candidate. **Keep this scrape in your reasoning**
   — Layer 2 (step 5.5, per loop iteration) reuses it. Fuzzy-match each
   remaining candidate against the scraped destination posts.

## Step 5 — Newest-first ordering

Sort the surviving candidates by `publishedAt` DESCENDING. Take the first
`max` of them. **Newest-first** is intentional (Ethan voice 6021): if the
backfill is interrupted mid-way, the destination ends up with a contiguous
recent history rather than a gap-bounded historical block.

For source-item fanout, select one source item at a time from this ordered list
and complete/blocked/partial its manifest before selecting the next source item.
Do not let per-destination ledgers make the scheduler advance to another source
item while an enabled destination for the current source item is unattempted.

## Step 5.5 — Layer 2 dedupe (semantic similarity, per candidate)

Use the `repost-dedup-semantic` skill. This is **Layer 2** — your own
semantic judgment over each candidate vs. the destination scrape from step
4. Catches paraphrased duplicates that Layer 1 cannot.

> Ethan voice 6106 (2026-05-01): *"It should make sure the agent actually
> semantically looks and processes the content of the message and checks the
> target destination... if there's something already similar, it shouldn't
> post a duplicate. That'll be embarrassing."*

Run Layer 2 **per candidate, immediately before publish** (i.e. inside the
publish loop in step 6, BEFORE step 6.4's compose flow). Doing it here
rather than as a single bulk pass means each candidate is checked against
the freshest destination state — earlier publishes in this same loop are
themselves Layer-2 inputs for later candidates.

1. Check `pair.policy.semanticDedupeEnabled` (default `true`). If `false`,
   skip Layer 2 entirely — the user explicitly opted out.
2. Take the most-recent `pair.policy.semanticDedupeWindowSize` (default 30)
   destination posts. **Refresh the scrape between iterations** so a
   candidate at iteration N is compared against destination state including
   anything you've published in iterations 1..N-1.
3. Apply the worked examples in `skills/repost-dedup-semantic/SKILL.md`.
   Lean conservative — when on the fence, skip.
4. If **semantic-duplicate**: append `pair.publish.semantic_duplicate` audit
   event with `{candidateExcerpt, matchedExistingUrl, matchedExistingExcerpt,
   agentReasoning, windowSize}`, append a catch-up entry to `posted.jsonl`,
   append a matching global ledger catch-up, record in `backfill-state.json` as
   skipped, and continue to the next candidate in the loop.
5. If **semantic-unique**: continue to step 6.4 publish.

Layer 2 is OPTIONAL but RECOMMENDED — enabled by default. Both layers must
clear before any candidate publishes. Backfill loops are the highest-value
place for Layer 2 because the source's historical posts often re-tread the
same theme with slightly different wording — Layer 2 catches those.

## Step 6 — Publish loop

For source-item fanout, this loop delegates each selected source item to
`skills/repost-source-fanout/SKILL.md`: create/resume the fanout manifest,
process every enabled destination, then return here only after the manifest is
`complete`, `blocked`, or `partial` with resume data.

For destination-specific pair backfill, process each candidate in order:

1. Tell the user what we're about to publish (`#<n>/<max>`: text preview + source URL).
2. If `pair.mode === "approval-required"`: ask the user to approve. Skip on no.
3. **Re-apply custom rules / considered state** to this candidate using
   `skills/repost-custom-rules/SKILL.md`; a long backfill may have new rules or
   considered lines from another run by the time this iteration starts. If it
   matches, log + skip + continue to the next iteration.
4. **Run Layer 2 semantic dedupe** (step 5.5 above) on this candidate
   against the freshest destination scrape. If it returns
   `semantic-duplicate`, log audit + skip + continue to next iteration.
5. If dry-run (no `--allow-publish`): just record the candidate in the audit
   log as `pair.backfill.would_publish` and continue to the next.
6. If publishing:
   - Run the URL expansion + length check from `repost-run` steps 6–7.
   - Drive the destination compose flow from `repost-run` step 8.
   - Apply the repost-run mandatory live-post text proof gate for every
     destination: re-open the captured destination URL and verify the live post
     text matches the intended draft/excerpt before recording success or
     notifying Ethan. If the URL opens a different post, the text is malformed,
     or the live text is only a fragment/duplicate of the intended draft, append
     the `posted-malformed` quarantine proof described in `repost-run`, log
     `pair.publish.live_text_mismatch`, and do not append success state.
     Facebook still has its extra verified-permalink search requirements.
   - On success: append to `posted.jsonl` and
     `~/.repost-with-agent/global-posted.jsonl` (step 9 of `repost-run`),
     update `backfill-state.json`, append `pair.backfill.published` audit.
   - For destination-specific pair backfills, notify the user for that single-pair publish (step 10 of `repost-run`). For source-item fanout backfills, do **not** notify per destination; carry the result into the source-item aggregate notification.
7. **Sleep** `effectiveIntervalMinutes * 60` seconds before the next candidate
   (use `sleep` via Bash). This is mandatory — destinations rate-limit
   aggressively on rapid-fire posts, and the per-pair policy floor prevents
   accidental spam bursts.

## Step 7 — Re-check destination dedupe between publishes

Between publishes (after sleep, before next publish), re-read the global ledger,
re-fetch the destination profile, and re-run global + destination dedupe on the
next candidate. If the candidate now appears (e.g. another pair/process posted
it), record `pair.backfill.skipped_now_duplicate`, append catch-up state when
there is proof of the destination post, and skip.

## Step 8 — Final summary

For source-item fanout runs, summarize by source item first, then destination
outcomes. Include `partial`/`blocked` and the manifest resume data when any
enabled destination did not finish.

After a destination-specific pair loop, print + (optionally) Telegram a summary:

```
✅ Backfill complete: <pair-id>
  Published: <N>
  Skipped:   <M> (duplicates: X, custom-rules: C, errors: Y)
  Rule IDs:  <comma-separated custom-rule ids or n/a>
  Duration:  <H>h<M>m
```

For source-item fanout runs, this final per-source summary is the user-facing
notification: one message per source post containing all platform outcomes or
reasons. Do not also send per-platform pings. For destination-specific pair
loops, the per-publish pings already happened during step 6; an additional
wrap-up summary can go to the user if the run was longer than ~5 minutes.

## Step 9 — Flush discovered quirks to learnings.md

Before exiting, append any quirks you tracked during the loop to
`~/.repost-with-agent/pairs/<id>/learnings.md`. Use `>>` via Bash —
append-only. Each entry uses the structured shape:

```
## YYYY-MM-DD HH:MM — <one-line summary>

<2–5 sentences of prose: what you saw, why it matters, implication.>

### Selectors          (optional — STRONGLY preferred when you have any)
- <label>: `<selector>` (<platform>, <where in flow>)

### Step playbook     (optional — STRONGLY preferred when you have any)
1. <imperative step using the selectors above>

### Quirks            (optional)
- <one-line edge case / rate-limit signature / timing>
```

Backfill is unusually rich source of learnings — each loop iteration touches
the source + destination DOM, exercises the dedupe path, and stresses the
rate-limit envelope. Use the structured sections aggressively here, because
the next backfill run can save real time by following your selectors +
step playbook verbatim instead of re-discovering them.

Examples worth capturing as full structured entries:

- A `### Selectors` block listing the destination compose textbox,
  Post button, and rate-limit modal. A `### Quirks` line: "Destination
  rate-limit modal appears after the 4th publish in a 30-min window for
  this account; bumping `intervalMinutes` to 12 cleared it."
- A `### Step playbook` capturing the exact source-pagination scroll
  count + wait that worked. A `### Quirks` line: "Source pagination on
  this LinkedIn account caps at ~60 posts (not 100); set realistic
  `--max` going forward."
- A `### Quirks` line: "Between item 7 and item 8, the destination scrape
  returned an empty feed for 90s before recovering — likely a cache flush;
  add a 60s retry before flagging `pair.dedupe.uncertain`."

If a fresh observation contradicts an older entry, do NOT delete the older
one. Use `Edit` to add ` [obsoleted YYYY-MM-DD]` to the older heading, then
append a new entry that mentions which prior entry it supersedes.

If the loop was uneventful and matched all prior expectations — write
nothing. The file is for deltas, not heartbeats. See
`skills/repost-learnings/SKILL.md` for full "signal vs noise" rules + the
good/bad entry example showing all three optional sub-sections.

## User confirmation — non-negotiable

> Every successful source item from this plugin MUST trigger a user-facing
> message confirming the source and destination URLs. For source fanout, that is
> one aggregate message per source post containing all platform outcomes, not one
> message per platform. Silent publishes are a bug.
> (Ethan voice 5977 + 5978, 2026-05-01; aggregate fanout clarification 2026-05-06.)

Backfill is the highest-volume publish path. Wire notifications carefully. For
destination-specific pair backfills, send one message per successful single-pair
publish. For source-item fanout backfills, suppress per-destination pings and
send one aggregate message after all enabled destinations for that source item
have been posted/skipped/caught-up/blocked. Use `notification.delivery` from
`~/.repost-with-agent/pairs.json` for the concrete channel/account/target
(OpenClaw maps this to the `message` tool). Never rely on default delivery
accounts, and never paste raw JSON/tool output into user-facing messages.

## See also

- `skills/repost-run/SKILL.md` — single-post version.
- `skills/repost-custom-rules/SKILL.md` — user preference skip rules +
  append-only considered state (runs before dedupe).
- `skills/repost-dedup/SKILL.md` — Layer 1 dedupe (exact + fuzzy string match).
- `skills/repost-global-dedupe/SKILL.md` — global cross-pair content ledger.
- `skills/repost-dedup-semantic/SKILL.md` — Layer 2 dedupe (agent semantic reasoning).
- `skills/repost-url-expand/SKILL.md` — URL expansion.
- `skills/repost-notify/SKILL.md` — Telegram payload spec.
- `skills/repost-learnings/SKILL.md` — pair-level institutional-memory file.
- `docs/destinations/<platform>.md` — per-platform DOM + pagination hints.
