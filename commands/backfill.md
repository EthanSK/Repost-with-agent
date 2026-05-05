---
description: Backfill historical source posts to the destination (newest-first), with rate-limiting between publishes.
---

# `/repost-backfill`

Walk back through historical source posts and repost the missing ones to the
destination, newest-first, with a configurable delay between publishes.

## Usage

```
/repost-backfill <pair-id> [--max <N>] [--interval <minutes>] [--allow-publish] [--resume]
```

Flags:

- `--max <N>` — cap the number of publishes (default 10, hard cap 50 unless
  the user explicitly asks for higher).
- `--interval <minutes>` — requested delay between publishes (default 10 for
  planning; actual publish delay is floored by `policy.minDelayBetweenPostsMinutes`,
  normally 60).
- `--allow-publish` — actually publish. Default behaviour without this flag is
  a dry-run that scrapes + dedupes + shows what would publish.
- `--resume` — load `~/.repost-with-agent/pairs/<id>/backfill-state.json` from
  a previous run and skip already-completed items.

## What it does

Dispatches to `skills/repost-backfill/SKILL.md`. It applies custom user skip
rules + `considered.jsonl` before dedupe and again inside the publish loop.
Newest-first ordering is
intentional — if interrupted, the destination ends up with a contiguous recent
history rather than a gap-bounded historical block. (Ethan voice 6021.)

## Mode rules

- `preview-only` mode pairs always refuse `--allow-publish`. Tell the user to
  bump the pair to `approval-required` or `live-approved` first.
- Backfill respects `policy.minDelayBetweenPostsMinutes` as a floor on
  `--interval`.

## Confirm every successful publish — non-negotiable

> Every successful post from this plugin MUST trigger a Telegram message to
> Ethan confirming the source URL and destination post URL. Silent publishes are a bug.
> (Ethan voice 5977 + 5978, 2026-05-01.)

Each successful publish in the backfill loop fires its own ping. After a long
backfill (≥5 minutes), an optional summary ping fires too.

## See also

- `skills/repost-backfill/SKILL.md` — full step-by-step.
- `skills/repost-dedup/SKILL.md` — fuzzy-match algorithm.
- `skills/repost-url-expand/SKILL.md` — shortener resolution.
