---
name: repost-pair-list
description: List all configured Repost-with-agent pairs with their mode, runMode, schedule, and last-run summary. Use when the user asks "what pairs are configured?", "list my repost pairs", or "show me the repost-with-agent state".
when_to_trigger: User asks to list, show all, or summarize the configured repost pairs.
---

# Repost Pair List

Read `~/.repost-with-agent/pairs.json` and summarize each configured pair.

## Steps

1. **Read** `~/.repost-with-agent/pairs.json`. If the file does not exist, tell the user "No pairs configured yet. Run `/pair create` to set one up." and stop.
2. **Validate** the JSON parses cleanly. If not, tell the user the file is corrupted, point at the most recent backup (`ls -t ~/.repost-with-agent/pairs.json.bak.*` via Bash), and stop.
3. For each pair in `pairs.pairs`:
   - Note the `id`, `name`, `enabled`, `mode`, `runMode`, `source.platform`, `source.url`, `destination.platform`, `destination.accountHint`, `schedule`.
   - Tail the per-pair `posted.jsonl` to count entries and grab the most-recent timestamp + destination URL: `tail -1 ~/.repost-with-agent/pairs/<id>/posted.jsonl` (Bash). If the file doesn't exist, "No posts yet."
4. If top-level `schedulerJobs` exists, summarize active/inactive jobs after the pair list (id, enabled, scope, pairIds, publishMode, schedule, host jobName). This is advisory metadata; do not treat it as proof the host scheduler is installed.
5. Format each pair as a compact bullet list. Use bold for the id and key fields. Example output:

```
**linkedin-to-x**  (enabled · live-approved · listen-for-future)
  Source:      linkedin · https://www.linkedin.com/in/ethansk
  Destination: x · @REEEthan_YT
  Schedule:    cron · daily / every 24h (0 10 * * *) · Europe/London
  History:     11 posts · last 2026-04-30T22:53:11Z → https://x.com/REEEthan_YT/status/...

**bluesky-to-threads** (disabled · preview-only · backfill)
  Source:      bluesky · https://bsky.app/profile/ethan.bsky.social
  Destination: threads · @ethanskattan
  Schedule:    manual
  History:     0 posts · no posts yet
```

## Output format

- Always show `enabled` first in the parenthesized status line so the user can
  see at a glance which pairs are armed.
- Include the count of `posted.jsonl` entries and the most-recent destination URL.
- If `schedulerJobs` exists, include a short `Scheduler jobs:` block so custom all-pairs/per-pair/subset/dry configurations are visible.
- Don't dump the full pairs.json — just the human summary.

## Telegram

This is a read-only inspection skill. Do not Telegram on this skill — list
operations are a quiet local query.
