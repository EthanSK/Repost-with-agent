---
description: Backfill historical source posts. Source-level jobs use one source-item fanout across all enabled destinations; pair-specific jobs are destination-specific only when explicitly requested.
---

# `/repost-backfill`

Walk back through historical source posts. For source-level backfills, each slot
selects one source item and fans it out to every enabled destination pair for
that source. Pair-specific backfills repost to one destination only and should
be used only when the user explicitly asks for a destination-specific repair/job.

## Usage

```
/repost-backfill source:<platform> [--max <N>] [--interval <minutes>] [--allow-publish] [--resume]
/repost-backfill <pair-id> [--max <N>] [--interval <minutes>] [--allow-publish] [--resume]
```

Flags:

- `--max <N>` — cap the number of source items for source fanout, or candidate publishes for a destination-specific pair backfill (default 10, hard cap 50 unless the user explicitly asks for higher).
- `--interval <minutes>` — requested delay between publishes (default 10 for
  planning; actual publish delay is floored by `policy.minDelayBetweenPostsMinutes`,
  normally 60).
- `--allow-publish` — actually publish. Default behaviour without this flag is
  a dry-run that scrapes + dedupes + shows what would publish.
- `--resume` — for source fanout, resume partial manifests under `~/.repost-with-agent/source-fanouts/` before selecting another source item; for pair-specific backfill, load `~/.repost-with-agent/pairs/<id>/backfill-state.json` and skip already-completed items.

## What it does

Dispatches to `skills/repost-backfill/SKILL.md`.

For `source:<platform>` / source-level scheduled slots, it also loads
`skills/repost-source-fanout/SKILL.md`: choose one source item, enumerate all
enabled destination pairs for that source, and mark the fanout `complete`,
`blocked`, or `partial` only after every enabled destination has an outcome.

For `<pair-id>`, it applies custom user skip rules + `considered.jsonl` before
dedupe and again inside the publish loop for that single destination pair.
Newest-first ordering is intentional — if interrupted, the destination ends up
with a contiguous recent history rather than a gap-bounded historical block.
(Ethan voice 6021.)

## Mode rules

- `preview-only` mode pairs always refuse `--allow-publish`. Tell the user to
  bump the pair to `approval-required` or `live-approved` first.
- Backfill respects `policy.minDelayBetweenPostsMinutes` as a floor on
  `--interval`.

## Confirm every successful source item — non-negotiable

> Every successful source item from this plugin MUST trigger a user-facing
> message confirming the source URL and destination post URL(s). For source
> fanout, send one message per source post containing all platform outcomes —
> not one message per platform. Silent publishes are a bug.
> (Ethan voice 5977 + 5978, 2026-05-01; aggregate fanout clarification 2026-05-06.)

For source fanout, send one aggregate message after all enabled destinations for
the source item have been posted/skipped/caught-up/blocked. Destination-specific
pair backfills still send one message per successful single-pair publish.

## See also

- `skills/repost-backfill/SKILL.md` — full step-by-step.
- `skills/repost-source-fanout/SKILL.md` — source-item fanout manifest/result rules.
- `skills/repost-dedup/SKILL.md` — fuzzy-match algorithm.
- `skills/repost-url-expand/SKILL.md` — shortener resolution.
