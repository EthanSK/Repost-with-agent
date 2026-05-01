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

`pair post` always:

1. re-runs preview,
2. re-checks dedupe at post-time (race-safe),
3. refuses on `preview-only` mode,
4. refuses without `--approve`,
5. blocks `uncertain` matches unless `--allow-uncertain` is also passed.

Do not run `pair post --approve` without explicit current-conversation user authorization.
