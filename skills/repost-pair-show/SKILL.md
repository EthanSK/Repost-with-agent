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
4. **Tail** the last 10 entries of `~/.repost-with-agent/pairs/<id>/posted.jsonl`
   via `tail -10` (Bash). For each entry, format as:
   `<ts>  <sourceItemId>  →  <destinationUrl>`.
5. **Tail** the last 20 entries of `~/.repost-with-agent/pairs/<id>/audit.jsonl`
   via `tail -20` (Bash). Include only `event` + `ts` + a short reason.
6. **Read** `~/.repost-with-agent/pairs/<id>/learnings.md` (if exists, may be
   empty) and include verbatim under a "Learnings" heading.

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
  Created:     <createdAt>
  Updated:     <updatedAt>

=== Recent posts (last 10) ===
  2026-04-30T22:53Z  urn:li:activity:7000  →  https://x.com/.../status/...
  ...

=== Recent audit (last 20) ===
  2026-04-30T22:53:11Z  pair.publish.success  Posted to x.com.
  2026-04-30T22:53:09Z  pair.publish.url_expanded  https://lnkd.in/abc → https://example.com/article
  ...

=== Learnings ===
  <contents of learnings.md or "(empty)">
```

## Telegram

Read-only inspection. No Telegram on this skill.
