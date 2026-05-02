---
name: repost-backfill
description: Walk back through historical source posts and repost the missing ones (newest-first). Use when the user asks to "backfill <pair>", "catch up the destination", "repost the last N posts", or invokes /repost-backfill. Multi-post operation with rate-limiting between publishes.
when_to_trigger: User wants to fill in missed historical posts on the destination, e.g. "backfill the last 10 LinkedIn posts to X", "catch up the X feed".
---

# Repost Backfill

Multi-post variant of `repost-run`. Walks back through the source's historical
posts newest-first and reposts the ones that aren't already on the destination,
with a configurable delay between publishes.

This is a separate skill from `repost-run` because the loop, dedupe ordering,
and rate-limiting differ.

## Required tools

Same as `repost-run`: Read, Edit, Write, Bash, browser MCP,
`plugin:telegram:telegram`.

## Step 1 — Load pair config + backfill options

1. Read `~/.repost-with-agent/pairs.json` and find the pair.
2. Verify `pair.enabled === true` and either:
   - `pair.runMode === "backfill"`, OR
   - The user explicitly asks for a one-shot backfill on a different runMode (in which case just remind them this is one-shot, not a permanent runMode change).
3. Ask the user (or accept from the slash command args):
   - `--max <N>` how many posts to backfill (default 10, hard cap 50 unless user explicitly says larger).
   - `--interval <minutes>` delay between publishes (default 10, minimum 2 to avoid platform rate-limits).
   - `--allow-publish` (boolean — default false). Without this flag, do a dry-run preview of every candidate but DON'T publish. With this flag, actually publish.
4. Verify `pair.mode !== "preview-only"` if `--allow-publish` is set. If `preview-only`, refuse and tell the user to flip the pair to `approval-required` or `live-approved` first.

## Step 2 — Resume state file

Backfill is interruptible. Keep an idempotent state file at
`~/.repost-with-agent/pairs/<id>/backfill-state.json`:

```json
{
  "startedAt": "<ISO-8601>",
  "max": 10,
  "intervalMinutes": 10,
  "completedSourceItemIds": ["urn:li:activity:7000", "..."],
  "skippedSourceItemIds": ["urn:li:activity:6999"]
}
```

If this file exists from a previous run and `--resume` is set, load it and skip
already-completed items.

## Step 3 — Source pagination

Use the browser MCP to walk back through historical posts on the source
profile. Per-platform pagination differs — see `docs/destinations/<platform>.md`.

For LinkedIn:

- Profile URL: `https://www.linkedin.com/in/<handle>/recent-activity/all/`.
- Scroll to load. LinkedIn's recent-activity feed virtualizes aggressively;
  scrape as you scroll, don't rely on all loaded posts staying in the DOM.
- Hard cap: ~100 historical posts before LinkedIn pagination gives up.

For X / Bluesky / Threads / Facebook: see per-platform docs.

Collect candidates UNTIL you have at least `max` non-duplicate items (after
running step 4 dedupe), or you exhaust the platform's pagination.

## Step 4 — Dedupe (full set, newest-first)

Same algorithm as `repost-run` step 4 (see `skills/repost-dedup/SKILL.md`),
applied to the full collected set:

1. **Local dedupe.** Drop any item whose `sourceItemId` is in `posted.jsonl`.
2. **Destination dedupe.** Scrape ~50–100 recent destination posts ONCE at the
   start of the run, not per-candidate. Fuzzy-match each remaining candidate
   against the scraped destination posts.

## Step 5 — Newest-first ordering

Sort the surviving candidates by `publishedAt` DESCENDING. Take the first
`max` of them. **Newest-first** is intentional (Ethan voice 6021): if the
backfill is interrupted mid-way, the destination ends up with a contiguous
recent history rather than a gap-bounded historical block.

## Step 6 — Publish loop

For each candidate in order:

1. Tell the user what we're about to publish (`#<n>/<max>`: text preview + source URL).
2. If `pair.mode === "approval-required"`: ask the user to approve. Skip on no.
3. If dry-run (no `--allow-publish`): just record the candidate in the audit
   log as `pair.backfill.would_publish` and continue to the next.
4. If publishing:
   - Run the URL expansion + length check from `repost-run` steps 6–7.
   - Drive the destination compose flow from `repost-run` step 8.
   - On success: append to `posted.jsonl` (step 9 of `repost-run`), update
     `backfill-state.json`, append `pair.backfill.published` audit.
   - **Telegram-confirm Ethan immediately** (step 10 of `repost-run`).
5. **Sleep** `intervalMinutes * 60` seconds before the next candidate (use
   `sleep` via Bash). This is mandatory — destinations rate-limit aggressively
   on rapid-fire posts.

## Step 7 — Re-check destination dedupe between publishes

Between publishes (after sleep, before next publish), re-fetch the destination
profile and re-run destination-dedupe on the next candidate. If the candidate
now appears (e.g. some other process posted it), record `pair.backfill.skipped_now_duplicate` and skip.

## Step 8 — Final summary

After the loop, print + (optionally) Telegram a summary:

```
✅ Backfill complete: <pair-id>
  Published: <N>
  Skipped:   <M> (duplicates: X, errors: Y)
  Duration:  <H>h<M>m
```

The per-publish Telegram pings already happened during step 6. The summary
itself can ALSO go to Telegram if the run was longer than ~5 minutes — Ethan
likes a wrap-up.

## Telegram-confirm every successful publish — non-negotiable

> Every successful post from this plugin MUST trigger a Telegram message to
> Ethan confirming the source and destination URL. Silent publishes are a bug.
> (Ethan voice 5977 + 5978, 2026-05-01.)

Backfill is the highest-volume publish path. Wire Telegram pings carefully:
one per successful publish (step 6), plus an optional final-summary ping.

## See also

- `skills/repost-run/SKILL.md` — single-post version.
- `skills/repost-dedup/SKILL.md` — dedupe algorithm.
- `skills/repost-url-expand/SKILL.md` — URL expansion.
- `skills/repost-notify/SKILL.md` — Telegram payload spec.
- `docs/destinations/<platform>.md` — per-platform DOM + pagination hints.
