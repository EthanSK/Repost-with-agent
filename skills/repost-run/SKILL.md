# Repost Run

Use this skill when the user wants to inspect, preview, review, or live-publish a saved Repost-with-agent pair or queue workspace.

## Preferred actions

- `repost-with-agent pair list`
- `repost-with-agent pair show <id>`
- `repost-with-agent pair preview <id>`
- `repost-with-agent pair history <id>`
- `repost-with-agent pair post <id> --approve` *(approval-gated; only when the user explicitly authorizes the live publish)*

## Run behavior

- Load existing pair config from `~/.repost-with-agent/pairs.json`, or queue workspace files (`user-setup.json`, `queue.jsonl`, `state.json`) when a workspace is provided.
- Respect pair mode, `publish_mode`, and run policy.
- Treat preview/manual approval as the safe default.
- Mention learnings/history/logs when relevant because they are loaded every run.

## Live publish rules

- `pair post <id>` requires the explicit `--approve` flag. Without it the orchestrator returns `needs-approval` and writes nothing.
- It also requires the pair to be in `approval-required` or `live-approved` mode — `preview-only` always refuses.
- The orchestrator re-runs preview, re-checks dedupe at post time (race-safe), and refuses if the top candidate is `uncertain` unless `--allow-uncertain` is also passed.
- Never invoke `--approve` on the user's behalf without an explicit, current-conversation green light.
