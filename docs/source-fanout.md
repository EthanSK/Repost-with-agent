# Source-item fanout contract

A Repost-with-agent source fanout is the unit that prevents historical backfills
from drifting into “one destination per slot” behaviour.

For a source-level backfill, a scheduled slot handles **one source item** and
fans it out to **all enabled destination pairs for that source**. For example,
Ethan's LinkedIn backfill slot is:

```text
urn:li:activity:<id> → linkedin-to-x + linkedin-to-bluesky + linkedin-to-threads + linkedin-to-facebook
```

That is the default interpretation for source-platform backfill jobs. A
per-destination backfill job is valid only when the user explicitly asks for a
single pair/destination.

## Why this exists

Pair-specific backfill runs are easy for an agent to misunderstand: if one slot
posts LinkedIn→X and the agent stops there, the source item looks “handled” in
one ledger while Facebook/Threads/Bluesky may still be missing. Source fanout
makes the selected source item the unit of work, so partial completion is visible
and resumable.

## Destination enumeration

For a selected source item, enumerate every pair from
`~/.repost-with-agent/pairs.json` where:

- `pair.enabled === true`;
- `pair.source.platform` and source profile/account match the selected source
  item;
- the destination pair is in scope for the current job;
- the pair is safe for the requested mode (preview/dry/live rules still apply).

Disabled pairs are not part of the fanout. Enabled pairs that cannot be posted
because of login/config/platform state are still part of the fanout and must be
reported as `blocked` with a reason and next action.

## Per-destination outcomes

Each enabled destination gets exactly one manifest record.

Terminal outcomes:

- `posted` — this fanout posted it, verified the live destination post text
  matches the intended draft, and wrote local + global proof.
- `already-posted` / `caught-up` — local, global, destination, or semantic
  dedupe proved the destination already has it; catch-up proof was written when
  needed.
- `skipped-rule` — a user custom rule / considered entry intentionally skipped
  the item.
- `skipped-by-policy` — an explicit configured policy skipped it, e.g. an
  overlength skip policy.
- `blocked` — terminal only when it includes `category`, `reason`, and
  `nextAction`. A destination where the platform created a public post but the
  live text did not match the intended draft is `blocked` with
  `category: "live-text-mismatch"`; it may have `posted-malformed` quarantine
  proof, but it is not a successful `posted` outcome.

Non-terminal outcomes:

- `planned`
- `attempting`
- `failed`
- `soft-failed` — safe deferred failure under the same-failure streak threshold
- `unattempted`
- `blocked` without a complete reason/nextAction

A non-terminal enabled destination means the source item fanout is `partial`.

## Top-level status

- `complete` — all enabled destinations are terminal and none is blocked.
- `blocked` — all enabled destinations are terminal, but at least one destination
  is explicitly blocked with a reason/next action.
- `soft-failed` — every remaining incomplete destination is a safe deferred
  failure below the same-fingerprint threshold (default 3). The queue may
  continue, but the source item remains deferred repair work rather than
  complete.
- `partial` — at least one enabled destination is still planned, attempting,
  failed, unattempted, or incompletely blocked.
- `in-progress` — the active agent is still processing the fanout.

The source item is never silently complete just because one destination posted.

## Resume rule

If a fanout ends `partial`, `blocked`, `in-progress`, or contains any
`needs-repost`/deleted/malformed destination, the next scheduled continuation
must resume or repair that same source item first. It must not select a
newer/older source item until the earlier one is `complete`, explicitly skipped,
or cancelled with proof.

Exception: `soft-failed` fanouts may be passed only while every deferred failure
has `safeToContinue: true`, a specific `failureType`, `rootCause`,
`failureFingerprint`, `consecutiveFailureCount`, and `failureThreshold`, and the
same-fingerprint count is below threshold. When the same fingerprint reaches the
threshold, promote it to `blocked` and stop the queue until fixed or skipped.
Never soft-fail public-side-effect uncertainty, malformed/live-text mismatch,
source URL leaks, login/config/account-switch needs, or ambiguous public/
destructive/editorial decisions.

The continuation should actively try to fix the blocker itself before asking the
operator. Safe self-remediation includes clean-reposting deleted/malformed proof
from local source text without changing the words, correcting wrong
ledger/manifest rows from live proof, retrying transient destination failures,
and applying exact text-fidelity overlength skips/blocks. Ask for help only when
the next action is ambiguous, requires credentials/config, needs a
safety/editorial judgment, or would perform an uncertain destructive public
action. In that case, the `blocked` record must say what was already tried and
what exact decision/action is needed.

The manifest's `resume` block must include:

- `sourceItemId`
- `canonicalSourceUrl`
- `pendingPairIds`
- `blockedPairIds`
- `nextAction`

## Manifest location

```text
~/.repost-with-agent/source-fanouts/<source-platform>/<safe-source-item-id>.json
```

See `docs/state-files.md` and
`templates/source-fanout-manifest.json.template` for the schema.

## Scheduled prompt wording

Good scheduled source backfill prompt:

```text
Use Repost-with-agent. Run one LinkedIn source-item fanout backfill slot: choose
the next eligible LinkedIn source item, enumerate all enabled LinkedIn
destination pairs, post/skip/block every destination together, write the fanout
manifest, send one aggregate user-facing message containing all platform
outcomes/reasons for the source item, and do not select another source item if
any destination is partial.
```

Bad scheduled prompt unless the user explicitly wants destination-specific work:

```text
/repost-backfill linkedin-to-x --allow-publish
```

That pair-specific prompt can be fine for a one-off repair, but it is not the
source-level backfill unit.
