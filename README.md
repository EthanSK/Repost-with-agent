# Repost-with-agent (v4.4.0)

A skill-only agent/OpenClaw-compatible plugin that drives the running agent
through cross-platform reposting. **No CLI, no MCP server, no platform SDKs,
no Playwright.** The plugin ships zero code that does the work — it ships
instructions (skills) and the agent's existing toolkit (Read, Edit, Write,
Bash, the current harness's browser automation, and the current harness's
configured message-delivery tool) does everything.

Supports LinkedIn, X, Bluesky, Threads, Facebook. Browser automation only
operates on transparent, logged-in sessions — no API keys, no stealth, no
CAPTCHA / 2FA bypass. For OpenClaw runs, that means OpenClaw's own browser
profile (`openclaw`, CDP port `18800`), not Ethan's personal browser/profile.

## TL;DR

1. Clone this repo.
2. Register this repo as a directory-source plugin in the harness you want to use:
   - OpenClaw: add the repo path to `plugins.load.paths` and enable
     `plugins.entries["repost-with-agent"]`.
   - Claude Code / compatible loaders: point the loader at `.claude-plugin/`.
3. Restart/reload the harness only when first registering the repo, moving the
   repo, or changing manifests/commands. Plain skill/doc edits are read from
   this directory by fresh agent runs.
4. In a fresh session: `/pair create` to set up a source → destination pair.
5. `/repost-run <pair-id>` to do a manual end-to-end repost.
6. `/repost-setup-cron <pair-id>` to schedule recurring ticks (default daily / every 24h).

That's it. The agent does everything else.


## Registration / update mechanics

This is a directory-source plugin. Harness config points at this repo instead
of copying the skill files elsewhere. There is no repo-owned shell registration
helper.

- **OpenClaw primary path:** `~/.openclaw/openclaw.json` includes this repo in
  `plugins.load.paths` and enables
  `plugins.entries["repost-with-agent"]`.
- **Claude Code / Claude-compatible path:** the loader points at the
  `.claude-plugin/` directory-source metadata when that harness is used.
- **After a normal repo edit or `git pull`:** no re-registration is needed as
  long as the configured path still points at this repo.
- **Re-register the repo path:** only for first setup, if the repo moved, if the
  plugin was disabled, or if harness config was reset.
- **Restart/reload the harness:** needed for first registration and usually
  safest after manifest or slash-command additions/removals. Existing
  long-running agent sessions may keep old startup context; start a fresh
  run/session for newly edited skill text.

## Marketplace / packaging sanity check

Before publishing or sharing a bundle, package only the tracked repo files
(for example via `git archive` or a clean checkout). Do not zip the live
working directory if it contains ignored local files such as `.env`,
`.claude/`, browser/cache artefacts, or `~/.repost-with-agent` state.

## Architecture in one sentence

This plugin is a folder of Markdown skills + slash commands; the running agent
reads them and executes the procedure using its native tools. The plugin
itself runs zero code at runtime.

The agent maintains a per-pair `learnings.md` so it doesn't re-figure quirks
every run — pagination caps, DOM changes, rate-limit signatures, and
account-specific gotchas accumulate across scheduled ticks instead of being
rediscovered from scratch each time. v4.2.0 adds a structured entry shape
(optional `### Selectors`, `### Step playbook`, and `### Quirks`
sub-sections) so each entry doubles as a recipe the next run can follow
verbatim — read learnings.md FIRST, fall back to
`docs/destinations/<platform>.md` only when learnings.md is silent or a
cached selector misses. (See
[`skills/repost-learnings/SKILL.md`](skills/repost-learnings/SKILL.md).)

## Global + two-layer dedupe

Every publish must first check the global cross-pair ledger, then clear BOTH
Layer 1 and Layer 2 before going live:

- **Global cross-pair ledger.** Read
  `~/.repost-with-agent/global-posted.jsonl` and resolve a `contentKey` for
  the underlying content. If LinkedIn→X already created/caught-up an X post, a
  later X→Bluesky candidate inherits the LinkedIn-origin `contentKey`; if that
  key already reached Bluesky by any pair, the new route skips. This prevents
  alternate hops from double-posting the same content. See
  [`skills/repost-global-dedupe/SKILL.md`](skills/repost-global-dedupe/SKILL.md).
- **Layer 1 — strings.** Exact `sourceItemId` match against
  `posted.jsonl`, global ledger check, plus a fuzzy-string match (normalize
  whitespace, lowercase, strip URLs, ≥80-char prefix overlap) against the
  destination's recent posts. Cheap. Catches verbatim and near-verbatim
  re-posts. See
  [`skills/repost-dedup/SKILL.md`](skills/repost-dedup/SKILL.md).
- **Layer 2 — agent semantic check.** After Layer 1 clears, the agent
  reads the candidate draft alongside the destination's most recent 30
  posts (override per-pair via `pair.policy.semanticDedupeWindowSize`)
  and uses its own reasoning to decide whether the candidate is
  "essentially the same announcement / opinion / claim, different
  words." Catches paraphrased duplicates. v4.3.0+. See
  [`skills/repost-dedup-semantic/SKILL.md`](skills/repost-dedup-semantic/SKILL.md).

Ethan voice 6106 (2026-05-01): *"It should make sure the agent actually
semantically looks and processes the content of the message and checks
the target destination and sees if there's a post with similar wording
already there. If because there is, then it shouldn't go through... that'll
be embarrassing."*

Layer 2 is enabled by default and can be turned off per-pair with
`pair.policy.semanticDedupeEnabled: false`. The agent leans conservative
on the threshold — when on the fence between "proceed" and "skip", it
skips, since a missed post is much cheaper than an embarrassing
duplicate.

(See [`docs/architecture.md`](docs/architecture.md) for the long version.)

## Required harness toolkit

The agent in your harness session must have:

- **Read, Edit, Write, Bash** — built-in for supported agent harnesses.
- **Native browser automation in the current harness** — for example OpenClaw's
  built-in browser, `chrome-devtools-mcp` when the current harness is Claude
  Code, or another explicit browser adapter. Used to navigate, scrape, fill
  forms, click buttons.
- **configured message delivery in the current harness** — OpenClaw should use
  its first-class `message` tool / Telegram channel; Claude Code should use
  `plugin:telegram:telegram`; other harnesses should use their equivalent
  configured delivery path. Used to send the mandatory
  publish-confirmation pings to Ethan.

Do **not** hand a Repost-with-agent run to Claude Code merely because Claude
Code is listed as a supported harness. The agent that receives the request owns
the run and should use its own browser tools unless Ethan explicitly asks for a
different harness.

If any of those is missing in a session, the relevant skill will surface the
missing dependency and stop. There's no fallback — the plugin trusts the
harness toolkit, it doesn't reimplement it.

## What the running agent does

When you invoke `/repost-run linkedin-to-x`:

1. Slash command resolves to `skills/repost-run/SKILL.md`.
2. Agent reads the skill (Markdown).
3. Agent reads `~/.repost-with-agent/pairs.json` to find the pair.
4. Agent uses its current-harness browser automation to navigate to the LinkedIn profile, scroll to
   load recent posts, scrape text + URLs.
5. Agent reads `~/.repost-with-agent/pairs/linkedin-to-x/posted.jsonl` to
   check local dedupe.
6. Agent navigates to the X profile and scrapes recent posts to check
   destination dedupe (fuzzy match: normalize whitespace, lowercase, strip
   URLs, ≥80-char prefix overlap).
7. Agent picks the newest non-duplicate item.
8. Agent expands shortened URLs (`lnkd.in`, `t.co`, `bit.ly`, etc.) via
   `curl -sIL` in Bash, and does **not** add the source platform permalink to
   the destination post body. Source URLs stay in state/audit/Telegram only.
9. Agent navigates to `x.com/compose/post`, fills the textarea, clicks Post.
10. Agent reads the resulting URL from the page.
11. Agent appends `{ts, sourceItemId, destinationUrl, ...}` to `posted.jsonl`.
12. Agent uses the current harness's primary message delivery tool to send the publish-confirmation:

    ```
    [Repost-with-agent] ✅ Posted: linkedin-to-x
    Source: https://www.linkedin.com/feed/update/...
    → Destination: https://x.com/REEEthan_YT/status/...
    ```

That's the full v4 flow. No code on disk did any of it.

## Confirm every successful publish — non-negotiable

> Every successful post from this plugin MUST trigger a Telegram message to
> Ethan confirming the source URL and destination post URL. Silent publishes are a bug.
> (Ethan voice 5977 + 5978, 2026-05-01.)

This rule is enforced in `skills/repost-notify/SKILL.md` and replayed in
`skills/repost-run/SKILL.md` step 10, `skills/repost-backfill/SKILL.md`
step 6, plus every slash command body. Defense in depth.

If you (the running agent) trigger a publish through any non-skill path, you
MUST also fire a publish confirmation.

## Slash commands

- `/pair list` — list configured pairs.
- `/pair show <id>` — show full pair details + recent posts + audit.
- `/pair create` — walk through creating a new pair.
- `/pair edit <id>` — edit an existing pair.
- `/repost-run <pair-id>` — run a single pair end-to-end (single post).
- `/repost-run all` — iterate over every enabled live-approved listen-for-future pair.
- `/repost-backfill <pair-id> [--max N --interval M --allow-publish --resume]` — multi-post historical walk, newest-first.
- `/repost-setup-cron <pair-id>` — install a current-harness scheduler entry (OpenClaw cron preferred for OpenClaw workflows) to tick a listen-for-future pair on a schedule.

## Skills

- `skills/repost-pair-setup/` — create / edit pairs.
- `skills/repost-pair-list/` — list pairs.
- `skills/repost-pair-show/` — inspect one pair.
- `skills/repost-run/` — single-post end-to-end flow.
- `skills/repost-backfill/` — multi-post historical walk.
- `skills/repost-listen-for-future-setup/` — install scheduler.
- `skills/repost-history/` — tail posted.jsonl.
- `skills/repost-dedup/` — Layer 1 fuzzy-match algorithm reference.
- `skills/repost-dedup-semantic/` — Layer 2 semantic-similarity check (agent reasoning).
- `skills/repost-url-expand/` — shortener resolution.
- `skills/repost-notify/` — Telegram payload spec + non-negotiable rule.
- `skills/repost-learnings/` — per-pair institutional-memory file (read at
  start of every run, appended at the end of every run).

## State files

All state lives at `~/.repost-with-agent/`:

- `pairs.json` — array of pair configs (schemaVersion 4).
- `pairs/<id>/posted.jsonl` — append-only history of successful publishes.
- `pairs/<id>/audit.jsonl` — append-only audit events.
- `pairs/<id>/learnings.md` — per-pair institutional memory. The agent reads
  this at the start of every run and appends new quirks at the end. Quirks
  accumulate across scheduled ticks so the agent doesn't re-figure pagination
  caps / DOM changes / rate-limit signatures from scratch each time. Each
  entry has free-form prose plus optional structured sub-sections
  (`### Selectors`, `### Step playbook`, `### Quirks`) so the next run
  can follow a recipe verbatim.
- `pairs/<id>/backfill-state.json` — transient resume state for backfills.
- `pairs/<id>/logs/cron.log` — stdout/stderr from fallback launchd/crontab ticks when that scheduler path is explicitly used.

Full schemas: [`docs/state-files.md`](docs/state-files.md).

## Pair config example

```json
{
  "schemaVersion": 4,
  "pairs": [
    {
      "id": "linkedin-to-x",
      "name": "LinkedIn to X",
      "enabled": true,
      "mode": "live-approved",
      "runMode": "listen-for-future",
      "source": {
        "platform": "linkedin",
        "url": "https://www.linkedin.com/in/<handle>/recent-activity/all/",
        "profileUrl": "https://www.linkedin.com/in/<handle>"
      },
      "destination": {
        "platform": "x",
        "accountHint": "@<handle>",
        "accountDisplayName": "<visible account/page name>",
        "targetType": "profile",
        "profileUrl": "https://x.com/<handle>"
      },
      "schedule": {
        "kind": "cron",
        "tz": "Europe/London",
        "expression": "0 10 * * *",
        "everyHours": 24
      },
      "policy": {
        "maxItemsPerRun": 1,
        "minDelayBetweenPostsMinutes": 60,
        "blockOnUncertainDuplicate": true,
        "overlengthStrategy": "compact",
        "globalDedupeEnabled": true,
        "semanticDedupeEnabled": true,
        "semanticDedupeWindowSize": 30
      }
    }
  ]
}
```

## Safety modes

- `mode: "preview-only"` — never publishes. Default for new pairs.
- `mode: "approval-required"` — agent asks per-post before publishing.
- `mode: "live-approved"` — agent publishes without prompting. Required for scheduled live ticks.

New pairs default to `mode: preview-only` + `enabled: false`. That's
intentional. Don't flip without explicit user authorization.

For destinations where one login can post as multiple identities, set
`destination.targetType` (`profile`, `page`, or `group`) and
`destination.accountDisplayName`. The run skill must verify/switch to that
identity before typing the draft, and must stop rather than publish from the
wrong profile/page.

## Run modes

- `runMode: "listen-for-future"` — tail new posts on a schedule. Default.
- `runMode: "backfill"` — one-shot historical walk (newest-first).

## v3 → v4 migration

If you're upgrading from v3, ask the running agent to follow
`docs/migration-v3-to-v4.md`: back up `~/.repost-with-agent/pairs.json`, edit
it from `schemaVersion: 3` to `4`, and leave existing per-pair history files
(`posted.jsonl`, `audit.jsonl`, and `learnings.md`) untouched. There is
intentionally no repo-owned shell migration helper.

Full migration walkthrough: [`docs/migration-v3-to-v4.md`](docs/migration-v3-to-v4.md).

## Why a second rewrite?

v3.0.0 (shipped 30 minutes earlier) was already a strip-and-rewrite that
removed Playwright + API SDKs. But v3 kept a CLI orchestrator with an
"agent-task contract" — the CLI emitted typed JSON tasks for an external
agent to consume.

Ethan voice 6024 + 6026 (2026-05-01) clarified that even the CLI is
unnecessary: the harness already has all the tools needed; the only thing
missing is the playbook. v4 ships only the playbook.

## Per-platform notes

- [`docs/destinations/linkedin.md`](docs/destinations/linkedin.md)
- [`docs/destinations/x.md`](docs/destinations/x.md)
- [`docs/destinations/bluesky.md`](docs/destinations/bluesky.md)
- [`docs/destinations/threads.md`](docs/destinations/threads.md)
- [`docs/destinations/facebook.md`](docs/destinations/facebook.md)

## Safety contract

- No stealth, no CAPTCHA bypass, no 2FA bypass, no anti-detection guidance.
- Browser automation only operates on the user's transparent, logged-in sessions.
- Refuse to scrape or post on behalf of an account the user is not the operator of.
- New pairs default to preview-only + disabled.
- Live publishes always require either `mode: live-approved` (for scheduled live
  ticks) or explicit per-post user authorization (`mode: approval-required`).
- Dedupe is re-checked between every publish — both Layer 1 (string match)
  and Layer 2 (agent semantic check) must clear; uncertain matches are
  skipped unless explicitly overridden.

## License

MIT. See [`LICENSE`](LICENSE).


**Notification routing rule:** user-visible Repost notifications are not inherently Telegram-specific. Store the route in `~/.repost-with-agent/pairs.json` under `notification.delivery` (for example `channel`, `accountId`, `target`, optional `threadId`) using the current harness/chat metadata during setup. Scheduled runs must read that route and pass it explicitly to the harness message tool; never rely on a default account/bot, and never paste raw JSON/tool output into user-facing messages.
