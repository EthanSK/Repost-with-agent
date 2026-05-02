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

## Optional: include a learnings tail

If the user asks for `--with-learnings` (or similar) on top of the history
tail, also read `~/.repost-with-agent/pairs/<id>/learnings.md` and print the
last 3 `## …` entries under a `=== Recent learnings (last 3) ===` heading
below the post history. This is handy when the user is reviewing a sequence
of posts and wants the institutional context that informed them.

If `learnings.md` is empty or only contains the placeholder stub, print
`(no learnings recorded yet)`. See `skills/repost-learnings/SKILL.md` for
the file format.

By default (no `--with-learnings`), this skill is a pure history tail and
doesn't touch `learnings.md`.

## See also

- `skills/repost-pair-show/SKILL.md` — full pair inspection (config + history
  + audit + learnings).
- `skills/repost-learnings/SKILL.md` — format of the learnings.md file.

## Telegram

Read-only. No Telegram on this skill.
