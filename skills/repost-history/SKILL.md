---
name: repost-history
description: Read the per-pair posted.jsonl history file and show recent entries. Use when the user asks "what did I repost from <pair>", "show <pair> history", or "tail repost history".
when_to_trigger: User wants to see what's been reposted from a given pair.
---

# Repost History

Tail the per-pair `posted.jsonl` and show recent entries.

## Steps

1. Read the requested pair's `posted.jsonl` at `~/.repost-with-agent/pairs/<id>/posted.jsonl`.
2. If file doesn't exist or is empty, tell the user "No posts yet for <pair-id>." and stop.
3. Default tail length: 20 lines. Accept `--limit N` from the user.
4. Read with `tail -<N>` via Bash. Each line is a JSON object with fields:
   - `ts` (ISO-8601)
   - `sourceItemId` (e.g. `urn:li:activity:7000`)
   - `canonicalSourceUrl`
   - `destinationUrl`
   - `destinationId`
   - `draftText` (the text we posted, ≤500 chars summary if longer)
5. Format each entry compactly:

   ```
   2026-04-30T22:53Z  urn:li:activity:7000
     Source: https://www.linkedin.com/feed/update/urn:li:activity:7000/
     Posted: https://x.com/REEEthan_YT/status/123
     Text:   "Yesterday I shipped v3.0.0 of Repost-with-agent — instructions + JSON state, no more SDKs..."
   ```

## Telegram

Read-only. No Telegram on this skill.
