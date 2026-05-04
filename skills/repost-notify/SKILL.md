---
name: repost-notify
description: Send a Telegram confirmation to Ethan after a successful repost publish, OR test that Telegram delivery is wired up. Use as part of the repost-run / repost-backfill flow, or standalone when the user asks "test the repost telegram", "send a test ping", or "verify notify is configured".
when_to_trigger: Immediately after every successful publish from the plugin (mandatory, non-negotiable), OR when the user asks to test Telegram delivery.
---

# Repost Notify

Send the Telegram confirmation that fires immediately after every successful
repost publish.

## The non-negotiable rule

> Every successful post from this plugin MUST trigger a Telegram message to
> Ethan confirming the source URL and the destination URL. Silent publishes
> are a bug. (Ethan voice 5977 + 5978, 2026-05-01.)

This is enforced by EVERY publish path in the plugin (`repost-run`,
`repost-backfill`, any future bespoke flow). No exceptions.

## Required tool

Use Telegram/message delivery in the current harness:

- **OpenClaw:** use the first-class `message` tool / configured Telegram channel.
- **Claude Code:** use `plugin:telegram:telegram`'s `reply` tool.
- **Other harnesses:** use the equivalent configured Telegram delivery tool.

If no Telegram/message delivery path is loaded in the current session, surface
the error and stop the publish flow. Do not silently skip.

## Payload

Format (use the current harness's normal Telegram formatting mode):

```
[Repost-with-agent] ✅ Posted: <pair-id>
Source: <canonicalSourceUrl>
→ Destination: <destinationUrl>
```

Project-tag / prefix rules from the current harness's user instructions still apply. Include `[Repost-with-agent]` at the start unless the harness has a stricter active-project tag rule.

## Success path

1. After the publish step in `repost-run` / `repost-backfill` returns success
   AND `posted.jsonl` has been appended:
2. Build the message payload above.
3. Call the current harness's Telegram/message delivery tool with the appropriate
   recipient:
   - OpenClaw: use the `message` tool / Telegram channel/account/target from
     the current session or repost-notification config.
   - Claude Code: use `plugin:telegram:telegram` `reply` with the configured
     `chat_id`.
   - Other harnesses: use their equivalent configured Telegram delivery path.
4. Append `pair.publish.notify.success` to `~/.repost-with-agent/pairs/<id>/audit.jsonl`.

## Failure path

If the Telegram/message delivery call returns an error:

1. Append `pair.publish.notify.failure` to `audit.jsonl` with the error text.
2. DO NOT roll back the publish. The post is already up — rollback would
   require deleting the destination post, which is risky.
3. Tell the user in chat (so the missed ping is replaced).
4. Optionally log to `pairs/<id>/logs/notify-errors.log` for forensics.

## Unconfigured path

If no Telegram/message delivery tool is loaded or configured in the current harness:

1. Append `pair.publish.notify_skipped_unconfigured` to `audit.jsonl`.
2. Tell the user IMMEDIATELY in chat: this is a silent publish, which is a
   project bug per the non-negotiable rule.
3. Recommend they configure the current harness's Telegram/message delivery path and re-run.

## Test path (standalone)

When the user asks "test the repost telegram" or runs the test before flipping
a pair to live:

1. Send a hardcoded test message:

   ```
   [Repost-with-agent] 🧪 Telegram test
   This is a test ping confirming the plugin can deliver publish confirmations to you.
   ```

2. Tell the user in chat: "If you see the test ping land in Telegram, the
   plugin is wired up correctly."

3. Don't append audit events for tests.

## Backfill quiet hours

If the user is running a backfill of 10+ posts during quiet hours (defined as
22:00–08:00 in the user's `pair.schedule.tz`), DO NOT collapse the per-publish
pings — Ethan still wants every confirmation. But add a `(quiet hours)` marker
so he can scan past them faster:

```
[Repost-with-agent] ✅ Posted: linkedin-to-x (quiet hours · backfill 3/10)
Source: ...
→ Destination: ...
```

(Default: NO quiet-hours marker. Only add it if the user explicitly asks for
backfills to mark quiet hours.)

## What to put in the message body

Stay short:

- ONE project tag in `[]` at the start.
- ONE check / fail emoji.
- TWO URLs: source canonical, destination final.
- Optional: pair id, item index for backfills (`3/10`).

DO NOT include the full draft text in the Telegram. The destination URL is
enough; the user clicks through to see the actual post.

## See also

- `skills/repost-run/SKILL.md` step 10 — where this skill is invoked in the
  single-post flow.
- `skills/repost-backfill/SKILL.md` step 6 — same, in the backfill loop.
- Current harness/user instructions for project-tag prefix rules.
