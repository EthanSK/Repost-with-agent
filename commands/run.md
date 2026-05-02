# `/run`

Default safe run flow — preview plus history review:

```bash
repost-with-agent pair preview <id>
repost-with-agent pair history <id>
```

Live publish (approval-gated; only when the user explicitly authorizes it):

```bash
repost-with-agent pair post <id> --approve
```

Backfill (newest-first walk-back through historical posts):

```bash
repost-with-agent pair backfill <id> --dry-run        # see the plan
repost-with-agent pair backfill <id> --allow-publish  # actually publish
```

`pair post` always:

1. emits a `fetch-source` agent-task and waits for your scrape result,
2. re-checks dedupe at post-time (race-safe),
3. refuses on `preview-only` mode,
4. refuses without `--approve`,
5. blocks `uncertain` matches unless `--allow-uncertain` is also passed,
6. emits a `post-to-destination` agent-task; you drive the browser to publish; CLI captures the result, appends to `posted.jsonl`, fires Telegram notify.

Do not run `pair post --approve` without explicit current-conversation user authorization.

## Telegram-confirm every successful publish — non-negotiable

> Every successful post from this tool MUST trigger a Telegram message to Ethan confirming what was posted, the source URL, and the destination URL. The CLI does this automatically via the configured `notify.telegram` channel. If you are an agent operating on this repo and you trigger a publish through any non-CLI path you MUST also fire a Telegram confirmation. Silent publishes are a bug. (Ethan voice 5977 + 5978, 2026-05-01.)

Before running `pair post --approve`:

```bash
repost-with-agent notify status   # confirm source: file or env, never none
```

If unconfigured, run `repost-with-agent notify configure --bot-token <T> --chat-id <C> --test` first.
