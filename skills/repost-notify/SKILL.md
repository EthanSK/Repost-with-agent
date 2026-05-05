---
name: repost-notify
description: Send the configured user-facing confirmation after a successful repost publish, OR test that notification delivery is wired up. Use as part of the repost-run / repost-backfill flow, or standalone when the user asks "test the repost telegram", "send a test ping", or "verify notify is configured".
when_to_trigger: Immediately after every successful publish from the plugin (mandatory, non-negotiable), OR when the user asks to test notification delivery.
---

# Repost Notify

Send the primary-channel confirmation that fires immediately after every
successful repost publish. The channel is not inherently Telegram: read the
configured `notification.delivery` route from `~/.repost-with-agent/pairs.json`
and map it to the current harness's user-facing message tool.

## The non-negotiable rule

> Every successful post from this plugin MUST trigger a message to the user on
> the primary current-harness communication channel, confirming the source URL
> and every destination post URL created. Silent publishes are a bug.
> (Ethan voice 5977 + 5978, 2026-05-01; link-list clarification 2026-05-04.)

This is enforced by EVERY publish path in the plugin (`repost-run`,
`repost-backfill`, any future bespoke flow). No exceptions.

## Required tool

Use the configured primary user-facing message delivery path:

1. Read `notification.delivery` from `~/.repost-with-agent/pairs.json`.
2. If it is missing during setup/test, write it from the current harness metadata before scheduling live runs (for example OpenClaw's channel/account/chat target, Slack channel id, Discord channel/user id, etc.). Do not guess or silently fall back to a default bot/account when multiple accounts exist.
3. Send via the current harness adapter:
   - **OpenClaw:** call `message(action="send", channel=delivery.channel, accountId=delivery.accountId, target=delivery.target, threadId=delivery.threadId?, message=<payload>)`.
   - **Claude Code / other harnesses:** use the configured user-facing delivery tool and equivalent delivery fields.

For Ethan's current OpenClaw install, `notification.delivery` is expected to be `channel="telegram"`, `accountId="clordlethird"`, and `target="telegram:6164541473"`; that is instance data, not a hard-coded product rule.

Keep notification payloads human-readable and short. Do **not** paste raw JSON, tool results, audit rows, internal transcripts, or stack dumps into user-facing messages; keep that evidence in files/logs and summarize it in plain language.

If no primary message delivery path is loaded in the current session, surface
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
3. Call the current harness's primary message delivery tool with the configured
   recipient from `notification.delivery`:
   - OpenClaw: `message(action="send", channel=delivery.channel, accountId=delivery.accountId, target=delivery.target, threadId=delivery.threadId?, message=<payload>)`.
   - Claude Code / other harnesses: use their equivalent configured delivery path.
4. Append `pair.publish.notify.success` to `~/.repost-with-agent/pairs/<id>/audit.jsonl`.

## Failure path

If the primary message delivery call returns an error:

1. Append `pair.publish.notify.failure` to `audit.jsonl` with the error text.
2. DO NOT roll back the publish. The post is already up — rollback would
   require deleting the destination post, which is risky.
3. Tell the user in chat (so the missed ping is replaced).
4. Optionally log to `pairs/<id>/logs/notify-errors.log` for forensics.

## Unconfigured path

If no primary message delivery tool is loaded or configured in the current harness:

1. Append `pair.publish.notify_skipped_unconfigured` to `audit.jsonl`.
2. Tell the user IMMEDIATELY in chat: this is a silent publish, which is a
   project bug per the non-negotiable rule.
3. Recommend they configure `notification.delivery` for the current harness and re-run.

## Test path (standalone)

When the user asks to test repost notifications or runs the test before flipping
a pair to live:

1. Send a hardcoded test message using `notification.delivery` and the same adapter rule above:

   ```
   [Repost-with-agent] 🧪 Notify test
   This is a test ping confirming the plugin can deliver publish confirmations to you on the primary channel.
   ```

2. Tell the user in chat: "If you see the test ping land in the configured primary channel, the
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

DO NOT include the full draft text in the confirmation. The destination URL is
enough; the user clicks through to see the actual post.

## See also

- `skills/repost-run/SKILL.md` step 10 — where this skill is invoked in the
  single-post flow.
- `skills/repost-backfill/SKILL.md` step 6 — same, in the backfill loop.
- Current harness/user instructions for project-tag prefix rules.
