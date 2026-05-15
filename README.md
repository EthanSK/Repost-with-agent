# Repost-with-agent (v4.5.7)

**GitHub Pages:** <https://ethansk.github.io/Repost-with-agent/>

A skill-only agent/OpenClaw-compatible plugin that drives the running agent
through cross-platform reposting. **No CLI, no MCP server, no platform SDKs,
no Playwright.** The plugin ships zero code that does the work — it ships
instructions (skills) and the agent's existing toolkit (Read, Edit, Write,
Bash, the current harness's browser automation, and the current harness's
configured message-delivery tool) does everything.

Works with any website the agent can safely operate through the logged-in
browser: sources, destinations, and compose flows are defined by pair config,
platform docs, per-pair `learnings.md`, and custom rules rather than a hardcoded
platform list. This repo ships documented/validated example surfaces for
LinkedIn, X, Bluesky, Threads, and Facebook.

That generic model still has real limits: no API keys, no stealth, no CAPTCHA /
2FA bypass, no private-inbox scraping unless explicitly authorized, no posting
where site policy or account ownership is unclear, and no assumption that a new
site's DOM will be stable. New websites need a preview validation pass, account
identity checks, destination-specific dedupe, and learnings/custom rules as the
agent discovers the safe flow. For OpenClaw runs, browser automation means
OpenClaw's own browser profile (`openclaw`, CDP port `18800`), not Ethan's
personal browser/profile.

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
6. `/repost-setup-cron` to install the default daily all-enabled-pairs sweep
   (`/repost-run all`). If you want something else, say so: per-pair jobs,
   subset jobs, dry/preview sweeps, custom cron expressions, and manual-only
   pairs are all valid user-owned configurations.
7. For historical source backfills, use source-item fanout semantics: one source
   item fans out to every enabled destination pair before the slot moves on.

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

## Exact text fidelity

Repost-with-agent must never reword Ethan's source posts. Public destination
post text preserves the original source wording exactly. The agent may only
remove source-platform UI artifacts outside the actual post body, such as
reaction counts or `...more`, and may replace forbidden source-platform wrapper
links such as `lnkd.in` with verified non-source targets. It must not summarize,
compact, paraphrase, improve, sanitize, normalize tone, fix grammar, or remove
phrasing because it seems awkward or inefficient. If exact text will not fit a
destination, the destination is skipped/blocked and Ethan is told; the agent does
not publish a rewritten version.

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

## Custom user skip rules

Before dedupe/publish, the agent also applies optional `customRules` from
`~/.repost-with-agent/pairs.json` plus append-only
`~/.repost-with-agent/considered.jsonl`. This is for user preference filters
that are not duplicate proof, e.g. “never repost X video/livestream promos
matching this topic.” A custom-rule skip appends `candidate.custom_rule.skipped`
to `considered.jsonl` and `pair.custom_rule.skipped` to the pair audit, but it
MUST NOT append to `posted.jsonl` or `global-posted.jsonl`. Those ledgers remain
reserved for successful publish / destination duplicate proof.

(See [`docs/architecture.md`](docs/architecture.md) for the long version.)

## Source-item fanout for backfills

A source-level backfill slot processes **one source item** and all enabled
destinations for that source together. For a LinkedIn source item, that means
LinkedIn→X, LinkedIn→Bluesky, LinkedIn→Threads, LinkedIn→Facebook, etc. are
planned/reconciled in one manifest. The source item is not complete just because
one destination posted. If any enabled destination is missing, unattempted, or
failed without an explicit block reason, the fanout is `partial` and the next
continuation should resume the same source item before selecting another item.

See [`skills/repost-source-fanout/SKILL.md`](skills/repost-source-fanout/SKILL.md),
[`docs/source-fanout.md`](docs/source-fanout.md), and
[`templates/source-fanout-manifest.json.template`](templates/source-fanout-manifest.json.template).

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
  publish confirmations to Ethan.

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
   load recent posts, scrape text + URLs + obvious media hints.
5. Agent applies custom user skip rules from `pairs.json` and
   `considered.jsonl`; preference skips do not touch publish ledgers.
6. Agent reads `~/.repost-with-agent/pairs/linkedin-to-x/posted.jsonl` and
   `global-posted.jsonl` to check local/global dedupe.
7. Agent navigates to the X profile and scrapes recent posts to check
   destination dedupe (fuzzy match: normalize whitespace, lowercase, strip
   URLs, ≥80-char prefix overlap), then runs Layer 2 semantic dedupe.
8. Agent picks the newest non-duplicate, non-rule-skipped item.
9. Agent expands shortened URLs (`lnkd.in`, `t.co`, `bit.ly`, etc.) via
   `curl -sIL` in Bash, and does **not** add the source platform permalink to
   the destination post body. Source URLs stay in state/audit/Telegram only.
10. Agent navigates to `x.com/compose/post`, fills the textarea, clicks Post.
11. Agent reads the resulting URL from the page.
12. Agent appends `{ts, sourceItemId, destinationUrl, ...}` to `posted.jsonl`
    and a publish proof to `global-posted.jsonl`.
13. Agent uses the current harness's primary message delivery tool to send the publish-confirmation (single-pair shape shown here; source fanout uses one aggregate message):

    ```
    [Repost-with-agent] ✅ Posted: linkedin-to-x
    Source: https://www.linkedin.com/feed/update/...
    → Destination: https://x.com/REEEthan_YT/status/...
    ```

That's the full v4 flow. No code on disk did any of it.

## Confirm every successful source item — non-negotiable

> Every successful source item from this plugin MUST trigger a user-facing
> message confirming the source URL and destination post URL(s). For source
> fanout / all-destination runs, send one message per source post containing all
> platform outcomes, not one message per platform. Silent publishes are a bug.
> (Ethan voice 5977 + 5978, 2026-05-01; aggregate fanout clarification 2026-05-06.)

This rule is enforced in `skills/repost-notify/SKILL.md` and replayed in
`skills/repost-run/SKILL.md` step 10, `skills/repost-backfill/SKILL.md`
step 6, `skills/repost-source-fanout/SKILL.md` step 6, plus every slash command
body. Defense in depth.

If you (the running agent) trigger a publish through any non-skill path, you
MUST also fire the correct confirmation shape: single-pair for single-pair runs,
or one aggregate source-item message for fanout/all-destination runs.

## Slash commands

- `/pair list` — list configured pairs.
- `/pair show <id>` — show full pair details + recent posts + audit.
- `/pair create` — walk through creating a new pair.
- `/pair edit <id>` — edit an existing pair.
- `/repost-run <pair-id>` — run a single pair end-to-end (single post).
- `/repost-run all` — iterate over every enabled `listen-for-future` pair in
  one sweep. The default scheduled live sweep publishes only `live-approved`
  pairs; preview/dry sweeps may include preview-only pairs but never publish.
- `/repost-backfill <pair-id> [--max N --interval M --allow-publish --resume]` — destination-specific historical walk, newest-first, only when the user explicitly asks for a single pair.
- `/repost-backfill source:<platform> [--max N --interval M --allow-publish --resume]` — source-item fanout walk; each source item fans out to all enabled destinations before the next item.
- `/repost-setup-cron` — by default, install one current-harness scheduler entry
  (OpenClaw cron preferred for OpenClaw workflows) that runs `/repost-run all`
  as a single sequential all-pairs sweep. On request, install separate per-pair
  jobs, named subset jobs, preview/dry jobs, or any custom current-harness
  schedule the user wants.

## Scheduling model: default, not a cage

The out-of-box scheduler shape is intentionally simple: one daily OpenClaw cron
job (or equivalent in the current harness) launches a fresh agent turn with
`/repost-run all`, and that agent sweeps enabled `listen-for-future` pairs
sequentially. For Ethan's current install, that is the intended default.

That default is **not** the product boundary. Repost-with-agent is a skill layer
over user-owned JSON state plus the host harness scheduler, so users may choose
any layout their harness can express:

- one all-enabled-pairs sweep daily, hourly, weekdays only, etc.;
- source-item fanout backfill slots, where each slot handles one source item across all enabled destinations and emits one aggregate outcome message;
- one cron job per pair, each using that pair's own cadence/timezone;
- subset jobs such as “professional accounts at 09:00” and “personal accounts
  at 18:00”;
- dry/preview scheduled checks that never publish, plus separate live jobs for
  explicitly `live-approved` pairs;
- manual-only pairs with `schedule.kind: "manual"` and no installed scheduler;
- custom natural-language scheduled prompts, as long as they still invoke the
  current harness, read the same `~/.repost-with-agent` state, and obey the
  publish-confirmation / aggregate fanout confirmation / dedupe rules.

For scheduled source backfills, the safe default is a source-item fanout job: one source item per slot, all enabled destinations, manifest written under `source-fanouts/`. Use destination-specific pair jobs only when the user explicitly asks for that narrower shape.

`pair.schedule` and optional top-level `schedulerJobs` metadata are advisory
configuration for agents and humans. The actual source of truth for timing is
the installed host scheduler entry (OpenClaw cron, launchd, system cron, or the
equivalent scheduler in the chosen harness). When the two disagree, inspect the
host scheduler before changing live behaviour.

## Skills

- `skills/repost-pair-setup/` — create / edit pairs.
- `skills/repost-pair-list/` — list pairs.
- `skills/repost-pair-show/` — inspect one pair.
- `skills/repost-run/` — single-post end-to-end flow.
- `skills/repost-backfill/` — multi-post historical walk.
- `skills/repost-source-fanout/` — source-item fanout contract for scheduled/source backfills.
- `skills/repost-listen-for-future-setup/` — install scheduler.
- `skills/repost-history/` — tail posted.jsonl.
- `skills/repost-dedup/` — Layer 1 fuzzy-match algorithm reference.
- `skills/repost-global-dedupe/` — cross-pair contentKey ledger.
- `skills/repost-custom-rules/` — custom user skip rules + considered state.
- `skills/repost-dedup-semantic/` — Layer 2 semantic-similarity check (agent reasoning).
- `skills/repost-url-expand/` — shortener resolution.
- `skills/repost-notify/` — Telegram payload spec + non-negotiable rule.
- `skills/repost-learnings/` — per-pair institutional-memory file (read at
  start of every run, appended at the end of every run).

## State files

All state lives at `~/.repost-with-agent/`:

- `pairs.json` — array of pair configs (schemaVersion 4), including optional `customRules`.
- `global-posted.jsonl` — append-only cross-pair publish/duplicate proof ledger.
- `considered.jsonl` — append-only custom-rule / not-post-worthy decisions.
- `schedulerJobs` (inside `pairs.json`, optional) — human/agent-readable scheduler intent for all-enabled, source-fanout, per-pair, subset, preview/dry, or custom jobs. The host scheduler remains the timing source of truth.
- `pairs/<id>/posted.jsonl` — append-only history of successful publishes.
- `pairs/<id>/audit.jsonl` — append-only audit events.
- `pairs/<id>/learnings.md` — per-pair institutional memory. The agent reads
  this at the start of every run and appends new quirks at the end. Quirks
  accumulate across scheduled ticks so the agent doesn't re-figure pagination
  caps / DOM changes / rate-limit signatures from scratch each time. Each
  entry has free-form prose plus optional structured sub-sections
  (`### Selectors`, `### Step playbook`, `### Quirks`) so the next run
  can follow a recipe verbatim.
- `pairs/<id>/backfill-state.json` — transient resume state for destination-specific backfills.
- `source-fanouts/<source-platform>/<safe-source-item-id>.json` — source-item fanout manifest recording every enabled destination outcome and resume data for partials.
- `pairs/<id>/logs/cron.log` — stdout/stderr from fallback launchd/crontab ticks when that scheduler path is explicitly used.

Full schemas: [`docs/state-files.md`](docs/state-files.md).

## Pair config example

```json
{
  "schemaVersion": 4,
  "customRules": [],
  "schedulerJobs": [
    {
      "id": "all-enabled-daily",
      "enabled": false,
      "scope": "all-enabled",
      "pairIds": [],
      "message": "/repost-run all",
      "publishMode": "live-approved-only",
      "schedule": {
        "kind": "cron",
        "tz": "Europe/London",
        "expression": "0 10 * * *",
        "everyHours": 24
      }
    },
    {
      "id": "linkedin-source-fanout-hourly",
      "enabled": false,
      "scope": "source-fanout",
      "sourcePlatform": "linkedin",
      "pairIds": [],
      "message": "Use Repost-with-agent. Run one LinkedIn source-item fanout backfill slot: choose the next eligible LinkedIn source item, enumerate all enabled LinkedIn destination pairs, post/skip/block every destination together, write the fanout manifest, send one aggregate user-facing message for the source item with all platform outcomes/reasons, and do not select another source item if any destination is partial.",
      "publishMode": "live-approved-only",
      "schedule": {
        "kind": "cron",
        "tz": "Europe/London",
        "expression": "0 * * * *",
        "everyHours": 1
      }
    }
  ],
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
        "overlengthStrategy": "skip",
        "textFidelity": "exact-source-body-only",
        "forbidSemanticRewrites": true,
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

## Documented example surfaces

The plugin is not limited to these websites. They are the currently documented /
validated examples that ship with the repo; new sites should get their own pair
config, preview validation, destination dedupe notes, and `learnings.md` updates
as the agent discovers the safe flow.

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
