# Repost Pair Setup

Use this skill when the user wants to create or save a repost source → destination pair or queue workspace for Repost-with-agent / repost_with_agent.

## Goals

- Ask for source first, then destination.
- Keep new pairs `preview-only` by default.
- Keep queue workspaces `publish_mode: manual` by default.
- Use CLI commands and the workspace initializer instead of inventing state manually.
- Never ask for passwords in chat.
- **Wire up the Telegram-on-publish notifier before any pair flips to live — non-negotiable.**

## Telegram-confirm every successful publish — non-negotiable

> Every successful post from this tool MUST trigger a Telegram message to Ethan confirming what was posted, the source URL, and the destination URL. The CLI does this automatically via the configured `notify.telegram` channel. If you are an agent operating on this repo and you trigger a publish through any non-CLI path (direct API call, scripted action, etc.) you MUST also fire a Telegram confirmation. Silent publishes are a bug. (Ethan voice 5977 + 5978, 2026-05-01.)

Setup-time checkpoint (do this BEFORE the first live run):

```bash
repost-with-agent notify configure --bot-token <TELEGRAM_BOT_TOKEN> --chat-id <CHAT_ID> --test
```

Then `repost-with-agent notify status` should report `Resolved source: file` (or `env`) — never `none`.

## Conversation flow

1. Ask what source website/account/feed should be watched.
2. Ask where reposts should go.
3. Ask whether the user wants `preview-only`, `approval-required`, or `live-approved`.
4. Ask for a pair name and schedule preference.
5. For pair workflows, create the pair with `repost-with-agent pair create ...`.
6. For queue workflows, run `python3 scripts/init_repost_with_agent_workspace.py <dir>` and have the user fill `user-setup.json` / `queue.jsonl` as needed.
7. Immediately run `repost-with-agent pair preview <id>` for pair workflows, or prepare a manual preview/draft for queue workflows.
8. **Run `repost-with-agent notify configure --bot-token <T> --chat-id <C> --test` if it's the first install on this machine.** Without this, live publishes will print a loud WARN and write a `pair.publish.notify_skipped_unconfigured` audit event but the post WILL still go out — that's a project bug, not a feature. Wire it up.
9. Explain that pair history/learnings persist under `~/.repost-with-agent`, while queue workspace state/proofs live in that workspace.

## First supported example

- Source type: `linkedin-profile-activity`
- Destination type: `x-account`

## Safety

- Preview first.
- No live posting during setup.
- No stealth, CAPTCHA bypass, 2FA bypass, or anti-detection guidance.
