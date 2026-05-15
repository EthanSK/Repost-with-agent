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
delivery for the final aggregate source-item outcome.

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
- `soft-failed` — an attempted destination failed in a way that is safe to
  defer: no public post was created or the public side effect is fully known,
  the failure has `failureType`, `rootCause`, `failureFingerprint`,
  `consecutiveFailureCount`, `failureThreshold`, and `safeToContinue: true`,
  and the consecutive same-fingerprint failure count is still below the
  threshold. Default threshold: 3.
- `unattempted` — the fanout ended before this enabled destination was checked.
  This is always non-terminal and makes the fanout `partial`.
- `needs-repost` — cleanup/remediation proved a previous destination post was
  deleted, malformed, or otherwise not usable as live proof. This is
  non-terminal and makes the fanout `partial` until repaired or explicitly
  skipped.
- `deleted-malformed` / `deleted-runaway` — cleanup markers for a public post
  that was deleted after malformed/runaway automation. These are non-terminal
  and must not be counted as successful destination proof.

Terminal per-destination statuses are: `posted`, `already-posted`, `caught-up`,
`skipped-rule`, `skipped-by-policy`, and `blocked` **only when it has an explicit
`category`, `reason`, and `nextAction`**. Remediation statuses (`needs-repost`,
`deleted-malformed`, `deleted-runaway`, `posted-malformed`, or rows with
`needsRemediation: true`) are not terminal.

Top-level fanout status MUST be:

- `complete` — every enabled destination has a terminal status and none is
  blocked.
- `blocked` — every enabled destination is terminal, and at least one destination
  is explicitly `blocked` with a reason/next action.
- `partial` — at least one enabled destination is `planned`, `attempting`,
  `failed`, `unattempted`, `needs-repost`, `deleted-malformed`,
  `deleted-runaway`, or `blocked` without a complete reason/nextAction.
- `soft-failed` — every non-success/non-skip destination is a safe deferred
  `soft-failed` destination whose same-fingerprint failure streak is below the
  configured threshold. This is not a completed source item, but a finite
  backfill scheduler may continue to later source items while keeping explicit
  repair data for the deferred destination(s).
- `in-progress` — the current agent is still actively processing destinations.

Never mark a source item `complete` merely because one destination posted.

## Blocker self-resolution rule

Default posture: resolve blockers yourself before asking Ethan.

When a destination is `partial`, `failed`, `unattempted`, `needs-repost`,
`deleted-malformed`, `deleted-runaway`, `deleted-source-url-leak`,
`posted-malformed`, or otherwise non-terminal, do not stop at a passive
"blocked" report if the next safe action is within the agent's existing
permissions and configured tools. First attempt the obvious remediation, for
example:

- clean-repost a deleted/malformed/source-URL-leak post from the local source
  text, after dedupe, source URL leak guard, and live-text proof;
- delete/quarantine malformed or duplicate public posts that this backfill run
  clearly created, when the evidence is unambiguous;
- correct bad ledger/audit/manifest rows when live proof shows the local state
  is wrong;
- catch up a source fanout when a failed or interrupted run created one
  destination post and a later listen-for-future sweep cascaded that derived
  post to other destinations; record those existing posts as `caught-up` for
  the original source item instead of reposting;
- retry a destination whose earlier failure was transient, using the current
  pair learnings and destination docs;
- compact/reword overlength drafts only after live destination UI length/cutoff
  feedback, preserving Ethan's intent, tone, links, key claims, and nuance.

Ask Ethan only when the remediation is externally destructive and ambiguous,
requires new credentials/account switching/configuration, needs a product or
editorial judgment, would publish content whose safety/notability is uncertain,
or the available evidence is insufficient to know the correct fix. If asking is
necessary, leave a precise `blocked` record with `category`, `reason`,
`nextAction`, proof URLs/excerpts, and what was already tried.

## Fail-soft streak policy

Do not let one transient destination failure freeze the whole historical
backfill. Classify every failure and decide whether it is safe to defer.

For each destination failure, write both the manifest destination record and the
pair audit with:

- `failureType` — e.g. `browser-timeout`, `selector-missing`, `rate-limit`,
  `platform-5xx`, `tool-error`, `live-proof-timeout`, `needs-login`,
  `needs-config`, `public-side-effect-uncertain`, `unknown`.
- `rootCause` — the best concise explanation, not just the symptom.
- `failureFingerprint` — stable string such as
  `<pairId>:<failureType>:<rootCause-slug>` so repeated same-class failures can
  be counted across source items.
- `consecutiveFailureCount` and `failureThreshold` (default threshold: `3`).
- `safeToContinue` — true only when advancing cannot create duplicates, lose a
  public post, or hide an action Ethan must take.

If `safeToContinue: true` and `consecutiveFailureCount < failureThreshold`, mark
the destination `soft-failed`, append `source.fanout.destination.soft_failed`,
record/update the queue-level `failureStreaks` entry, and allow the finite
backfill scheduler to advance to the next source item. Keep the source item out
of `complete`; it remains deferred repair work.

If the same `failureFingerprint` reaches the threshold (default 3 consecutive
failures), promote the current destination/source item to `blocked`, append
`source.fanout.failure_streak.blocked`, and stop selecting later source items
until the root cause is fixed or Ethan explicitly changes the threshold/skips.

Reset the streak for a pair/fingerprint after a successful `posted`,
`caught-up`, `already-posted`, or explicit non-failure skip for that pair.

Never soft-fail these unsafe cases: public post may exist but cannot be proven,
live-text mismatch/malformed post, source URL leak, login/config/account switch
needed, uncertain duplicate where policy says block, or any case requiring
Ethan's public/destructive/editorial decision. Those remain immediate
`blocked`/`needs-state-repair` cases.

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
3. Attempt only destinations whose status is `planned`, `failed`,
   `soft-failed`, `unattempted`, or incomplete `blocked`.
4. Before publishing anything, scan the source fanout directory and any active
   backfill queue file for earlier source items from the same source-level
   backfill. If an earlier item is `partial` or `in-progress`, or has a
   non-terminal destination such as `planned`, `attempting`, `failed`,
   `unattempted`, `needs-repost`, `deleted-malformed`, or `deleted-runaway`,
   stop and resume/repair that earlier item first. Do not use a later scheduled
   slot to skip over a partial source item.
5. A prior `soft-failed` item is allowed to be passed only when every deferred
   destination has `safeToContinue: true` and its same-fingerprint streak is
   below threshold. Otherwise resume/repair it first.
6. Do NOT select a different source item until this manifest is `complete`,
   explicitly skipped, cancelled with proof, or `soft-failed` under the streak
   threshold. A `blocked`, `partial`, or `in-progress` manifest stops the finite
   queue until it is repaired or Ethan explicitly decides to skip it.

## Step 3 — Pre-compute destination outcomes together

For each destination pair, before composing anything:

1. Apply custom rules / considered state from `repost-custom-rules`.
2. Check local `posted.jsonl`.
3. Check `global-posted.jsonl` via `repost-global-dedupe`.
4. Run the global dedupe derived-source crash guard: if the destination proof
   for this source item already exists indirectly because another pair/sweep
   treated a derived public post as source, mark this destination `caught-up` and
   repair the original fanout state rather than posting a duplicate.
5. Scrape destination recent posts for Layer 1 fuzzy dedupe.
6. Run Layer 2 semantic dedupe when enabled.

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

### Transactional state rule

A public browser publish must never be the first durable record of work. Before
touching a destination composer, write durable local intent; immediately after
live proof, write durable success/catch-up before attempting any other
destination. This is the crash-recovery boundary that prevents a public post
from existing with no resumable state if OpenClaw crashes, times out, or
produces an incomplete terminal tool-use turn.

For each `planned` destination:

1. Mark the destination `attempting` in the manifest **and flush it to disk**
   before touching the browser. Include `attemptStartedAt`, `draftText`,
   `textHash`, and `expectedDestinationPlatform`. Append
   `source.fanout.destination.attempting` to that pair's `audit.jsonl`. If either
   write fails, stop; do not open the composer or publish.
2. Run `repost-run` steps 6–9 for this selected source item and destination
   pair: URL expansion, exact-first/overlength-only text policy, compose, proof
   append, and global ledger append.
   - The mandatory source URL leak guard from `repost-run` is required here too:
     if the final public draft contains the source canonical URL or source
     permalink marker, block that destination with `source-url-leak-guard` rather
     than publishing.
   - Do **not** send an individual per-destination user notification from inside
     this loop.
   - Carry the destination result forward into the fanout manifest so Step 6 can
     send one aggregate message for the source item.
3. Enforce the `repost-run` mandatory live-post text proof gate before recording
   success for **any** destination. Re-open the captured destination URL and
   verify the live post text matches the intended draft (allowing only harmless
   platform rendering differences such as repeated whitespace or URL wrapper
   display). Facebook still has its extra verified-permalink requirements in
   `docs/destinations/facebook.md`.
4. If the platform created a public post but the live text proof gate fails, do
   not mark the destination `posted`. Append the `posted-malformed` quarantine
   proof described in `repost-run`, set this destination to `blocked` with
   `category: "live-text-mismatch"`, include the public URL plus observed and
   intended text excerpts, and stop the source fanout until Ethan decides
   whether to delete/repost or accept it.
5. On success, immediately set the destination to `posted` with `destinationUrl`,
   `destinationId` when available, and `notifiedByAggregate: true|false` after
   Step 6. Flush the manifest, pair `posted.jsonl`, pair `audit.jsonl`, and
   `global-posted.jsonl` before starting the next destination. If those writes
   fail after a public post exists, stop the fanout and leave the manifest
   `partial` / `needs-state-repair` with the captured URL; do not continue to
   another platform.
6. On rule/policy skip discovered during the loop, set `skipped-rule` or
   `skipped-by-policy` with the exact reason.
7. On user/platform/config/login/account problems, set `blocked` with
   `category`, `reason`, and `nextAction`.
8. On unexpected failure without a clear next action, classify it with the
   fail-soft streak policy above. If it is safe to defer and the same
   fingerprint is still below threshold, set `soft-failed` and continue the
   finite queue. If unsafe or at threshold, set `failed`/`blocked` with the
   failure metadata and stop as required.

Refresh global/destination dedupe between destination attempts when another
agent/run may have posted the same source item meanwhile.

On resume, any destination left as `attempting` without terminal success must be
treated as `needs-state-repair`: inspect recent destination posts and browser
history for the stored `draftText`/`textHash`; if live proof exists, catch it up
to `posted`/`caught-up` without reposting, otherwise demote it to `planned` or
`failed` with an explicit reason. Never skip over an `attempting` destination to
process a later queue item.

## Step 5 — Finalize status and emit resume data

After all enabled destinations have been evaluated for this source item:

1. Recompute top-level `status` from the destination records.
2. If every destination is terminal and none is blocked, set `status: "complete"`.
3. If every destination is terminal but one or more are explicitly blocked, set
   `status: "blocked"` and keep those `nextAction` fields visible.
4. If every non-terminal destination is `soft-failed` with `safeToContinue: true`
   and below its streak threshold, set `status: "soft-failed"` and include
   deferred repair data.
5. If any other enabled destination is non-terminal or missing from the
   manifest, set `status: "partial"`.
6. For `partial`, `soft-failed`, or `blocked`, add `resume` data:
   - `sourceItemId`
   - `canonicalSourceUrl`
   - `pendingPairIds`
   - `blockedPairIds`
   - a one-sentence `nextAction`
7. Append one of `source.fanout.complete`, `source.fanout.blocked`,
   `source.fanout.soft_failed`, or `source.fanout.partial` to every in-scope
   pair's `audit.jsonl`.

A scheduled backfill slot may select the next source item ONLY after every
earlier source item in the same queue/fanout set is `complete`, `soft-failed`
under the configured streak threshold, explicitly skipped, or cancelled with
proof. `blocked`, `partial`, or `in-progress` fanouts must be resolved first
instead of being skipped by a later scheduled slot. A deleted or malformed
destination (`posted-malformed`, `deleted-malformed`, `deleted-runaway`,
`deleted-source-url-leak`, `needs-repost`, `needsRemediation: true`) is not
soft-failable and must be repaired/skipped with explicit proof before the
scheduler advances.

## Step 6 — Aggregate notification / report shape

Send at most **one** user-facing message for this source item. It must name the
source item once and list every enabled destination outcome: posted URL,
already-posted/caught-up proof URL, skipped reason, or blocked/failed reason.

Do **not** send one message per platform for a source fanout. Per-platform pings
make it hard to see whether the source item completed. One source item gets one
aggregate message after all enabled destinations have been evaluated. Silent
publishes are still a bug: the single aggregate message is the confirmation.

If every destination is a duplicate/no-op and the scheduled prompt asks for
quiet no-op behavior, output exactly `NO_REPLY`. Otherwise use this shape:

```text
Source fanout: urn:li:activity:7000
Status: partial
- X: posted https://x.com/.../status/123
- Bluesky: already-posted https://bsky.app/...
- Threads: posted https://threads.com/...
- Facebook: unattempted — resume required
Next: resume the same source item for linkedin-to-facebook before selecting another LinkedIn item.
```

Append a fanout-level notify audit event such as `source.fanout.notify.success`
or `source.fanout.notify.failure` to every in-scope pair's audit log. Do not
append misleading per-pair `pair.publish.notify.success` rows for destinations
whose success was confirmed only through the aggregate fanout message.

## See also

- `skills/repost-backfill/SKILL.md` — how source-item fanout is selected from a historical source scrape.
- `skills/repost-run/SKILL.md` — destination compose/proof/notify steps reused by each fanout destination.
- `docs/source-fanout.md` — operator-facing explanation and examples.
- `docs/state-files.md` — manifest and audit schema.
- `templates/source-fanout-manifest.json.template` — example manifest.
