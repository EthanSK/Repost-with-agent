# `/pair`

Use Repost-with-agent pair commands.

Typical flow:

1. `repost-with-agent pair list`
2. `repost-with-agent pair show <id>`
3. `repost-with-agent pair create ...`

## Telegram-confirm every successful publish — non-negotiable

> Every successful post from this tool MUST trigger a Telegram message to Ethan confirming what was posted, the source URL, and the destination URL. The CLI does this automatically via the configured `notify.telegram` channel. If you are an agent operating on this repo and you trigger a publish through any non-CLI path you MUST also fire a Telegram confirmation. Silent publishes are a bug. (Ethan voice 5977 + 5978, 2026-05-01.)

Before flipping any pair to a non-`preview-only` mode, run `repost-with-agent notify configure --bot-token <T> --chat-id <C> --test` and verify the test ping lands.
