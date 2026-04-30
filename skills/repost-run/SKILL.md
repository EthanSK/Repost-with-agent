# Repost Run

Use this skill when the user wants to inspect, preview, or review a saved Repost-with-agent pair or queue workspace.

## Preferred actions

- `repost-with-agent pair list`
- `repost-with-agent pair show <id>`
- `repost-with-agent pair preview <id>`
- `repost-with-agent pair history <id>`

## Run behavior

- Load existing pair config from `~/.repost-with-agent/pairs.json`, or queue workspace files (`user-setup.json`, `queue.jsonl`, `state.json`) when a workspace is provided.
- Respect pair mode, `publish_mode`, and run policy.
- Treat preview/manual approval as the safe default.
- Mention learnings/history/logs when relevant because they are loaded every run.

## Current limitation

This foundation pass does not add a new generic live-publish command yet. Do not claim that it exists.
