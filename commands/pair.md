---
description: Manage Repost-with-agent pairs (list / show / create / edit). Skill-driven; no CLI.
---

# `/pair`

Manage Repost-with-agent source → destination pairs. This command dispatches
to the matching skill based on the subcommand.

## Subcommands

- `/pair list` → invoke `skills/repost-pair-list/SKILL.md`. Read
  `~/.repost-with-agent/pairs.json` and summarize.
- `/pair show <id>` → invoke `skills/repost-pair-show/SKILL.md`. Show full
  pair details + recent posts + audit.
- `/pair create` → invoke `skills/repost-pair-setup/SKILL.md`. Walk the user
  through creating a new pair.
- `/pair edit <id>` → invoke `skills/repost-pair-setup/SKILL.md` in edit
  mode (read existing pair, ask the user which fields to update, write back).

## Architecture (v4.5.3)

This plugin ships **no code that does the work**. The slash command above is a
thin wrapper that loads the matching skill — the running agent (OpenClaw,
Claude Code, or another supported harness) does all the heavy lifting using its
native tools: Read, Edit, Write, Bash, current-harness browser automation, and
current-harness primary message delivery.

JSON state lives at `~/.repost-with-agent/pairs.json`, per-pair files under
`~/.repost-with-agent/pairs/<id>/`, and source fanout manifests under
`~/.repost-with-agent/source-fanouts/`. The agent reads/writes them via the
native Read/Edit/Write tools.

## Preserve exact post wording — non-negotiable

> Public destination post text must preserve the original source post wording exactly. New and edited pairs default to `policy.overlengthStrategy: "skip"`, `policy.textFidelity: "exact-source-body-only"`, and `policy.forbidSemanticRewrites: true`. Do not compact, truncate, paraphrase, summarize, fix grammar, or otherwise reword a public post to fit a destination.

The `repost-pair-setup` skill must write those defaults unless Ethan explicitly changes policy later.

## Confirm every successful source item — non-negotiable

> Every successful source item from this plugin MUST trigger a user-facing
> message confirming the source URL and destination post URL(s). For source
> fanout / all-destination runs, send one message per source post containing all
> platform outcomes, not one message per platform. Silent publishes are a bug.
> (Ethan voice 5977 + 5978, 2026-05-01; aggregate fanout clarification 2026-05-06.)

The `repost-pair-setup` skill checks Telegram is wired up before flipping a
new pair to a non-`preview-only` mode.

## See also

- `/repost-run` — run a single pair end-to-end.
- `/repost-backfill` — multi-post historical walk; source-level scheduled backfills use source-item fanout.
- `/repost-setup-cron` — install a current-harness scheduler entry for listen-for-future pairs (OpenClaw cron preferred for OpenClaw workflows).
