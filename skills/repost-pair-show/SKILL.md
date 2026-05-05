---
name: repost-pair-show
description: Show full details for one Repost-with-agent pair, including config, recent posts, recent audit events, and learnings. Use when the user asks "show me <pair-id>", "what's the state of <pair-id>", or "audit <pair-id>".
when_to_trigger: User asks to inspect, audit, or show a specific pair.
---

# Repost Pair Show

Show full details for a specific pair: configuration, recent post history,
recent audit events, and free-form learnings.

## Steps

1. **Read** `~/.repost-with-agent/pairs.json`.
2. **Find** the pair by `id`. If not found, list available ids and stop.
3. Pretty-print the pair config (use `jq` via Bash for clean output:
   `jq '.pairs[] | select(.id == "<id>")' ~/.repost-with-agent/pairs.json`).
4. If top-level `schedulerJobs` exists, show jobs whose `scope` is `all-enabled` or whose `pairIds` includes this pair id. Label these as advisory scheduler metadata, not proof the host job is installed.
5. **Tail** the last 10 entries of `~/.repost-with-agent/pairs/<id>/posted.jsonl`
   via `tail -10` (Bash). For each entry, format as:
   `<ts>  <sourceItemId>  →  <destinationUrl>`.
6. **Tail** the last 20 entries of `~/.repost-with-agent/pairs/<id>/audit.jsonl`
   via `tail -20` (Bash). Include only `event` + `ts` + a short reason.
7. **Read** `~/.repost-with-agent/pairs/<id>/learnings.md` (if exists, may be
   empty).
   - Print the **last 5** `## …` entries verbatim under a "Recent learnings"
     heading (newest at the bottom — the file is append-only so the last 5
     `##` headings ARE the most recent). Use a small `awk` / `tail` pipe to
     extract them; one practical approach is to `grep -n '^## '
     learnings.md | tail -5` to find the line numbers of the last 5 headings,
     then `sed -n '<first>,$p'` from the earliest of those.
   - If the file is empty or only contains the placeholder stub, print
     `(no learnings recorded yet)` instead.
   - If the user asks for the full file (`--full-learnings` or similar),
     dump the entire file verbatim under "All learnings" instead of the
     last-5 tail.

## Output format

```
=== Pair: <id> ===
  Name:        <name>
  Enabled:     <true|false>
  Mode:        <mode>
  Run mode:    <runMode>
  Source:      <platform> · <url>
  Destination: <platform> · <accountHint>
  Schedule:    <schedule>
  Scheduler:   <matching schedulerJobs summary, if any>
  Created:     <createdAt>
  Updated:     <updatedAt>

=== Recent posts (last 10) ===
  2026-04-30T22:53Z  urn:li:activity:7000  →  https://x.com/.../status/...
  ...

=== Recent audit (last 20) ===
  2026-04-30T22:53:11Z  pair.publish.success  Posted to x.com.
  2026-04-30T22:53:09Z  pair.publish.url_expanded  https://lnkd.in/abc → https://example.com/article
  ...

=== Recent learnings (last 5) ===
  ## 2026-05-12 14:22 — LinkedIn recent-activity pagination cap dropped to ~60
  <body>

  ## 2026-05-09 09:14 — X composer textarea stopped auto-focusing
  <body>

  ...
```

If `--full-learnings` was passed, replace the last-5 tail with the full
file contents under `=== All learnings ===`.

## See also

- `skills/repost-learnings/SKILL.md` — format + lifecycle of the
  learnings.md file this skill surfaces.

## Telegram

Read-only inspection. No Telegram on this skill.
