# Architecture (v4.5.3 — skill-only, current-harness first)

## TL;DR

Repost-with-agent v4 is a **skill-only plugin**. It ships zero code that does
the work. The running AI agent does everything using its current-harness
toolkit: Read, Edit, Write, Bash, browser automation, and Telegram/message
delivery.

OpenClaw runs should use OpenClaw's built-in browser and `message` /
Telegram-channel tooling. For Repost-with-agent, OpenClaw means OpenClaw's own
browser/profile (`profile: openclaw`, CDP port `18800`) — not Ethan's personal
browser/profile, Chrome relay, or `profile="user"`. Claude Code runs should use
`chrome-devtools-mcp` and `plugin:telegram:telegram`. Do not hand off to Claude
Code just because it is listed as one supported harness; the harness that
received the workflow owns it unless Ethan explicitly chooses another one.

The plugin contains:

- A `.claude-plugin/marketplace.json` + `plugin.json` so Claude Code and
  Claude-compatible loaders can install it as a directory-source plugin.
- An `openclaw.plugin.json` for OpenClaw-native plugin metadata.
- `skills/<name>/SKILL.md` files that are step-by-step instructions for the
  agent.
- `commands/*.md` slash command wrappers.
- `templates/` and `docs/` for state-file schemas, per-platform DOM hints, and
  this architecture page.

There is intentionally **no repo-owned runtime code** and no repo-owned shell
registration helper. Harness configuration should point at this directory as a
directory-source plugin; state migration, when needed, is a documented
agent-assisted file edit rather than a repo script.

There is no `src/` TypeScript code. There is no MCP server. There is no CLI
binary. There is no runtime `package.json` build chain. There are no node
modules. `package.json` is mostly marketplace metadata plus lightweight repo
validation scripts; no package script performs reposting.

## Why this design?

> "The whole point of this is a plugin we install into the existing agent
> harness we want to use it in, either OpenClaw or Claude Code. It's
> essentially just a skill for the existing harness. This isn't fucking a CLI
> that uses a new chat."
>
> — Ethan voice 6024, 2026-05-01

> "And even the cron job, etc., that's all just instructions for the harness
> to set up, etc. It's just essentially an interface, skill interface,
> whatever, for the harness to have instructions and how to manage and keep
> track of it. But it actually does all the hard work. We don't code anything
> in."
>
> — Ethan voice 6026, 2026-05-01

When the harness already provides file tools, Bash, browser automation, and
configured user-message delivery, the only missing piece for end-to-end reposting is
the **playbook** — the step-by-step "navigate here, scrape that, dedupe like
so, expand URLs, post here, log there, notify the user". That playbook is exactly
what this plugin's skills are.

Coding the playbook into TypeScript means:

- Two implementations to keep in sync (the code + the agent's understanding).
- Brittle DOM selectors hardcoded in source instead of called out in
  per-platform docs the agent reads at runtime.
- A bespoke "agent-task contract" boundary the agent has to learn (v3 had this).
- Build / install / dependency churn for something the agent can already do.

The skill-only design eliminates all of that. The agent reads the skill at
runtime. When LinkedIn changes a selector, the fix is a one-line edit in
`docs/destinations/linkedin.md`, not a rebuild + reinstall + push of a new
plugin version.

## What the running agent does at runtime

Concretely, when `/repost-run linkedin-to-x` is invoked:

1. **Slash command resolves to skill.** The harness loads `commands/run.md`,
   which dispatches to `skills/repost-run/SKILL.md`.
2. **Agent reads the skill.** The skill is just Markdown — the agent reads it
   like it would read any project doc.
3. **Agent reads pair config.** Native Read/file tool on
   `~/.repost-with-agent/pairs.json`.
4. **Agent navigates with current-harness browser automation.** OpenClaw uses
   its built-in browser; Claude Code uses `chrome-devtools-mcp`; other harnesses
   use their explicit browser adapter.
5. **Agent applies custom rules.** Reads optional `customRules` and
   `considered.jsonl` to drop user-blocked / not-post-worthy candidates before
   dedupe.
6. **Agent reasons about dedupe.** Reads `posted.jsonl`, scrapes destination
   recent posts, runs Layer 1 string matching, then Layer 2 semantic judgment.
7. **Agent expands URLs.** Native Bash `curl -sIL --max-time 5` per shortened
   URL.
8. **Agent drives the destination.** Uses current-harness browser click/fill
   tools, then reads the resulting destination URL after submit.
9. **Agent appends history.** Native Bash `echo '<json>' >> posted.jsonl` and
   `echo '<json>' >> global-posted.jsonl` for publish/catch-up proof. Pure
   custom-rule skips append only to `considered.jsonl` + pair audit.
10. **Agent notifies.** Uses `notification.delivery` with the current-harness
   message tool (OpenClaw `message`, Claude Code's configured channel tool, Slack/Discord/etc. equivalents).


**Notification routing rule:** user-visible Repost notifications are not inherently Telegram-specific. Store the route in `~/.repost-with-agent/pairs.json` under `notification.delivery` (for example `channel`, `accountId`, `target`, optional `threadId`) using the current harness/chat metadata during setup. Scheduled runs must read that route and pass it explicitly to the harness message tool; never rely on a default account/bot, and never paste raw JSON/tool output into user-facing messages.

No code in this plugin does any of those things. The skills tell the agent what
to do; the agent does it.

## Contrast with v3

| Aspect              | v3 (CLI + agent-task contract) | v4 (skill-only) |
| ------------------- | ------------------------------ | --------------- |
| `src/` code         | ~2 500 LOC TypeScript          | 0               |
| Build step          | `tsc → dist/`                  | None |
| Registration dependency | Node + tsx                | None — directory-source registration in harness config |
| CLI binary          | `repost-with-agent`            | None |
| MCP server          | None                           | None |
| State location      | `~/.repost-with-agent/`        | `~/.repost-with-agent/` (unchanged) |
| Agent boundary      | typed JSON tasks via inbox files | Direct: agent uses native tools per skill |
| Per-platform logic  | TypeScript + skill hints       | Per-platform `docs/destinations/<p>.md` |
| URL expansion       | `src/core/url-expander.ts`     | `skills/repost-url-expand/SKILL.md` (curl via Bash) |
| Dedupe              | `src/core/dedupe.ts`           | `skills/repost-dedup*.md` (agent reasoning + grep) |
| Notify              | `src/core/notify.ts` HTTPS POST | `skills/repost-notify/SKILL.md` (configured current-harness user-message delivery) |
| Scheduler           | CLI invoked from launchd       | Current harness scheduler invokes a fresh agent/subagent |
| Schedule update     | `pair edit --schedule-kind cron --expression ...` | Edit `pairs.json`, update/recreate the harness scheduler job |

## How scheduling works

The scheduler doesn't run any plugin code — there is no plugin code to run.
Instead, it invokes the **same harness chosen for the workflow**.

- **OpenClaw workflows:** default to `openclaw cron add ... --message "/repost-run all"` for one all-enabled-pairs sweep. If the user wants more control, install separate entries such as `--message "/repost-run <pair-id>"`, named subset prompts, or preview-only dry sweeps.
- **Claude Code / other explicit workflows:** use that harness's scheduler or a
  shell-invoked launchd/crontab fallback only when the user chose that harness.

The fresh scheduled agent:

1. Loads the plugin from that harness's plugin registration.
2. Resolves the slash command → loads the skill.
3. Runs the skill end-to-end.
4. Exits when the skill is done.

The next scheduled tick spawns a fresh agent/subagent. There is no daemon, no
long-running process, no leftover state in memory. Each tick is independent and
idempotent. The default one-sweep job is only the starter architecture; host
schedulers can run per-pair jobs, subsets, custom cadences, source-item fanout
backfill slots, or dry/preview jobs as long as each tick still reads the shared
`~/.repost-with-agent` state and obeys the same safety/dedupe/notification
rules.

For source-level historical backfills, the safe scheduling unit is a
**source-item fanout**: one selected source item plus every enabled destination
pair for that source. The run writes a manifest under
`~/.repost-with-agent/source-fanouts/<source-platform>/<source-item>.json` and
is `partial` unless every enabled destination is posted, already-posted/caught
up, skipped by rule/policy, or explicitly blocked with reason/nextAction. This
keeps a LinkedIn→all backfill from accidentally becoming four independent
per-destination jobs.

This matches Ethan's intent in voice 6026: "yeah, I guess don't follow Agent
Bridge then. So yeah, skip the MCP. Subagent."

## Where the custom rules + dedupe + URL-expand / etc. logic *lives*

Not in code. In Markdown:

- `skills/repost-custom-rules/SKILL.md` describes user preference skip rules
  and append-only `considered.jsonl` state.
- `skills/repost-dedup/SKILL.md` describes the Layer 1 fuzzy-match algorithm.
- `skills/repost-dedup-semantic/SKILL.md` describes Layer 2 semantic dedupe.
- `skills/repost-url-expand/SKILL.md` describes the redirect-following procedure.
- `skills/repost-run/SKILL.md` describes the end-to-end flow that uses them.

The agent reads these at runtime and executes them with its native tools. The
Layer 1 algorithm is:

> normalize whitespace, lowercase, strip URLs, strip trailing punctuation,
> exact-normalized match OR ≥80-char prefix overlap

The agent can apply this directly via reasoning (for ≤20 candidates, which is
the typical case) or shell out to `sed` / `awk` if the candidate set is large
(50+ in a long backfill).

## Failure modes and recovery

- **Browser automation not loaded** → skill body explicitly checks for it; if
  missing, it tells the user and stops. No silent fallthrough.
- **User-message delivery not configured/loaded** → skill writes
  `pair.publish.notify_skipped_unconfigured` to audit.jsonl and surfaces the
  silent publish to the user immediately.
- **Source / destination login expired** → `category: "needs-login"` audit
  event; user must re-login in the current harness browser profile.
- **Scheduled tick raced with a manual run** → both runs share `posted.jsonl`
  and the global cross-pair ledger (file appends are atomic in practice for
  sub-line writes); the second run hits local/global dedupe and skips.
- **User blocks a category after it was already posted once** → add a custom
  skip rule + considered entry going forward. Do not rewrite historical
  `posted.jsonl` / `global-posted.jsonl` proof lines.
- **Alternate pair route would double-post** → the global ledger's inherited
  `contentKey` is the guardrail; every pair checks destination-platform/account
  rows before compose.
- **Source fanout stopped after one destination** → the source fanout manifest
  remains `partial` with pending `pairIds` and resume data. The next source-level
  backfill continuation resumes that same source item before selecting another.

## See also

- `docs/state-files.md` — formal state-file schemas.
- `docs/source-fanout.md` — source-item fanout contract.
- `docs/migration-v3-to-v4.md` — the second rewrite explained.
- `docs/destinations/<platform>.md` — per-platform DOM hints.
- `skills/*/SKILL.md` — the actual playbook.
