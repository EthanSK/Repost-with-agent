---
name: repost-source-fanout
description: Process one selected source item across every enabled destination pair for that source, especially scheduled/backfill slots. Use when the user or scheduler asks to backfill/catch up a source platform such as LinkedIn to all configured destinations, or when a partial fanout needs resume.
when_to_trigger: A backfill/scheduled slot should handle one source item and all enabled destinations together; the user asks to resume/repair a partial source item; or a run must prove all destination outcomes for one source item.
---

# Repost Source Fanout

This is the load-bearing unit for source-level backfills.

A **source-item fanout** means: choose ONE source item, enumerate EVERY enabled
pair whose source matches that item, then handle all enabled destinations for
that same item before the slot is allowed to move on.

For Ethan's LinkedIn backfill, an hourly/scheduled slot is therefore:

```text
one LinkedIn source item → X + Bluesky + Threads + Facebook (all enabled LinkedIn destinations)
```

It is **not** four independent destination jobs unless the user explicitly asks
for destination-specific work.

## Required tools

Same as `repost-run` / `repost-backfill`: Read, Edit, Write, Bash,
current-harness browser automation, and configured current-harness user-message
delivery for successful publishes.

## Status vocabulary

Per-destination status MUST be one of:

- `planned` — destination is missing and should be attempted in this fanout.
- `attempting` — compose/dedupe/post flow currently running for this destination.
- `posted` — destination publish succeeded and proof was appended to the local
  pair history plus `global-posted.jsonl`.
- `already-posted` — local/global/destination dedupe proved this source item is
  already present on that destination; catch-up proof was appended where needed.
- `caught-up` — synonym for an already-present destination where the run added
  missing local/global proof.
- `skipped-rule` — a custom user rule / considered-state rule skipped this item
  for that destination. This is terminal, but it is not publish proof.
- `skipped-by-policy` — a configured policy, such as an explicit overlength
  skip policy, intentionally skipped this destination. Include the policy id or
  rule name in `reason`.
- `blocked` — the destination cannot be completed without user/platform/action.
  MUST include `category`, `reason`, and `nextAction`.
- `failed` — an attempted destination failed without a clear terminal block.
  This is non-terminal and makes the fanout `partial` until retried or promoted
  to `blocked` with a reason.
- `unattempted` — the fanout ended before this enabled destination was checked.
  This is always non-terminal and makes the fanout `partial`.

Terminal per-destination statuses are: `posted`, `already-posted`, `caught-up`,
`skipped-rule`, `skipped-by-policy`, and `blocked` **only when it has an explicit
`category`, `reason`, and `nextAction`**.

Top-level fanout status MUST be:

- `complete` — every enabled destination has a terminal status and none is
  blocked.
- `blocked` — every enabled destination is terminal, and at least one destination
  is explicitly `blocked` with a reason/next action.
- `partial` — at least one enabled destination is `planned`, `attempting`,
  `failed`, `unattempted`, or `blocked` without a complete reason/nextAction.
- `in-progress` — the current agent is still actively processing destinations.

Never mark a source item `complete` merely because one destination posted.

## Step 1 — Resolve source scope and destination pairs

1. Read `~/.repost-with-agent/pairs.json`.
2. Resolve the source scope literally:
   - `source:linkedin`, `linkedin source fanout`, `LinkedIn backfill slot`, or a
     named LinkedIn source item means all enabled pairs where
     `pair.source.platform === "linkedin"` and the source profile/config matches.
   - If the prompt names a specific source item id/URL, use that item.
   - If no source item is named, scrape the source once and select the next
     eligible item using `repost-backfill` ordering (newest-first for backfill).
3. Build `enabledDestinationPairs` from pairs where:
   - `enabled === true`;
   - source platform/profile matches the selected source item;
   - destination is not the same platform/account as the source unless the user
     explicitly configured same-platform reposting;
   - the current job is allowed to inspect/publish that pair's mode.
4. If zero enabled destination pairs are found, stop with `blocked` /
   `needs-config`. Do not silently treat the source as done.

The pair list must be captured at fanout start and written to the manifest so a
later resume knows exactly which destinations were in scope.

## Step 2 — Create or resume the fanout manifest

Fanout manifests live under:

```text
~/.repost-with-agent/source-fanouts/<source-platform>/<safe-source-item-id>.json
```

Use the schema in `docs/state-files.md` and the example in
`templates/source-fanout-manifest.json.template`.

On a fresh run:

1. Create a manifest with `status: "in-progress"`.
2. Add the selected source item metadata (`platform`, `sourceItemId`,
   `canonicalSourceUrl`, `publishedAt`, `textHash`/excerpt when available).
3. Add one destination record per enabled destination pair, initially
   `status: "planned"`.
4. Append `source.fanout.start` to every in-scope pair's `audit.jsonl`.

On resume:

1. Load the manifest for that source item.
2. Keep terminal destination records unchanged.
3. Attempt only destinations whose status is `planned`, `failed`, `unattempted`,
   or incomplete `blocked`.
4. Do NOT select a different source item until this manifest is `complete` or
   explicitly `blocked`.

## Step 3 — Pre-compute destination outcomes together

For each destination pair, before composing anything:

1. Apply custom rules / considered state from `repost-custom-rules`.
2. Check local `posted.jsonl`.
3. Check `global-posted.jsonl` via `repost-global-dedupe`.
4. Scrape destination recent posts for Layer 1 fuzzy dedupe.
5. Run Layer 2 semantic dedupe when enabled.

Record the result in the manifest:

- Existing proof → `already-posted` or `caught-up` with proof URL and ledger line.
- Custom/user skip → `skipped-rule` with `ruleId` and reason.
- Policy skip → `skipped-by-policy` with policy name and reason.
- Missing and allowed → remain `planned`.
- Needs login/config/account switch/platform action → `blocked` with
  `category`, `reason`, and `nextAction`.
- Dedupe uncertainty with `blockOnUncertainDuplicate === true` → `blocked`, not
  `complete`.

If a destination's state cannot be inspected and no explicit block is recorded,
mark it `unattempted` or `failed`; the top-level status must be `partial`.

## Step 4 — Attempt all missing destinations for this same source item

For each `planned` destination:

1. Mark the destination `attempting` in the manifest before touching the browser.
2. Run `repost-run` steps 6–10 for this selected source item and destination
   pair: URL expansion, length/compact policy, compose, proof append, global
   ledger append, and user notification.
3. For Facebook, enforce the verified-permalink proof gate from
   `docs/destinations/facebook.md` before recording success.
4. On success, set the destination to `posted` with `destinationUrl`,
   `destinationId` when available, and `notified: true|false`.
5. On rule/policy skip discovered during the loop, set `skipped-rule` or
   `skipped-by-policy` with the exact reason.
6. On user/platform/config/login/account problems, set `blocked` with
   `category`, `reason`, and `nextAction`.
7. On unexpected failure without a clear next action, set `failed` and include
   the error. This keeps the fanout `partial` until a future run resumes.

Refresh global/destination dedupe between destination attempts when another
agent/run may have posted the same source item meanwhile.

## Step 5 — Finalize status and emit resume data

After all enabled destinations have been evaluated for this source item:

1. Recompute top-level `status` from the destination records.
2. If every destination is terminal and none is blocked, set `status: "complete"`.
3. If every destination is terminal but one or more are explicitly blocked, set
   `status: "blocked"` and keep those `nextAction` fields visible.
4. If any enabled destination is non-terminal or missing from the manifest, set
   `status: "partial"`.
5. For `partial` or `blocked`, add `resume` data:
   - `sourceItemId`
   - `canonicalSourceUrl`
   - `pendingPairIds`
   - `blockedPairIds`
   - a one-sentence `nextAction`
6. Append one of `source.fanout.complete`, `source.fanout.blocked`, or
   `source.fanout.partial` to every in-scope pair's `audit.jsonl`.

A scheduled backfill slot may select the next source item ONLY after the current
source item fanout is `complete` or explicitly `blocked`. A `partial` fanout must
be resumed first.

## Step 6 — Report shape

The transcript/user-facing summary should name the source item once and list all
destination outcomes. Example:

```text
Source fanout: urn:li:activity:7000
Status: partial
- X: posted https://x.com/.../status/123
- Bluesky: already-posted https://bsky.app/...
- Threads: posted https://threads.com/...
- Facebook: unattempted — resume required
Next: resume the same source item for linkedin-to-facebook before selecting another LinkedIn item.
```

For successful publishes, the normal per-publish user notification still fires
immediately via `repost-notify`. The final summary does not replace those pings.

## See also

- `skills/repost-backfill/SKILL.md` — how source-item fanout is selected from a historical source scrape.
- `skills/repost-run/SKILL.md` — destination compose/proof/notify steps reused by each fanout destination.
- `docs/source-fanout.md` — operator-facing explanation and examples.
- `docs/state-files.md` — manifest and audit schema.
- `templates/source-fanout-manifest.json.template` — example manifest.
