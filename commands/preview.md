# `/preview`

Preview a saved Repost-with-agent pair without publishing anything.

```bash
repost-with-agent pair preview <id>
```

The CLI emits a `[agent-task fetch-source ...]` banner. As the agent operating this repo, you read the task, drive the user's logged-in browser via your browser MCP to scrape the source profile, and write a `fetch-source-result` back. The CLI then formats and prints the draft.

## Telegram-confirm every successful publish — non-negotiable

> Preview itself never publishes, but the moment you (or a scheduled tick) flip to live, every successful post from this tool MUST trigger a Telegram message to Ethan confirming what was posted, the source URL, and the destination URL. The CLI does this automatically via the configured `notify.telegram` channel. Silent publishes are a bug. Wire it up with `repost-with-agent notify configure --bot-token <T> --chat-id <C> --test` before any live run. (Ethan voice 5977 + 5978, 2026-05-01.)
