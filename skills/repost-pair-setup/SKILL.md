# Repost Pair Setup

Use this skill when the user wants to create or save a repost source → destination pair or queue workspace for Repost-with-agent / repost_with_agent.

## Goals

- Ask for source first, then destination.
- Keep new pairs `preview-only` by default.
- Keep queue workspaces `publish_mode: manual` by default.
- Use CLI commands and the workspace initializer instead of inventing state manually.
- Never ask for passwords in chat.

## Conversation flow

1. Ask what source website/account/feed should be watched.
2. Ask where reposts should go.
3. Ask whether the user wants `preview-only`, `approval-required`, or `live-approved`.
4. Ask for a pair name and schedule preference.
5. For pair workflows, create the pair with `repost-with-agent pair create ...`.
6. For queue workflows, run `python3 scripts/init_repost_with_agent_workspace.py <dir>` and have the user fill `user-setup.json` / `queue.jsonl` as needed.
7. Immediately run `repost-with-agent pair preview <id>` for pair workflows, or prepare a manual preview/draft for queue workflows.
8. Explain that pair history/learnings persist under `~/.repost-with-agent`, while queue workspace state/proofs live in that workspace.

## First supported example

- Source type: `linkedin-profile-activity`
- Destination type: `x-account`

## Safety

- Preview first.
- No live posting during setup.
- No stealth, CAPTCHA bypass, 2FA bypass, or anti-detection guidance.
