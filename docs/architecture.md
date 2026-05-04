# Architecture (v4.0.0 — skill-only)

## TL;DR

Repost-with-agent v4 is a **skill-only plugin**. It ships zero code that does
the work. The running AI agent does everything using its current-harness
toolkit — Read, Edit, Write, Bash, browser automation, plugin:telegram:telegram.
OpenClaw runs should use OpenClaw's browser; Claude Code runs should use
Claude Code's browser MCP. Do not hand off to Claude Code just because it is
listed as one supported harness.

The plugin contains:

- A `.claude-plugin/marketplace.json` + `plugin.json` so Claude Code can install
  it as a directory-source plugin.
- An `openclaw.plugin.json` for OpenClaw.
- 10 `skills/<name>/SKILL.md` files that are step-by-step instructions for the
  agent.
- 4 `commands/*.md` slash command wrappers.
- A `scripts/install.sh` that registers the plugin path with both harnesses.
- `templates/` and `docs/` for state-file schemas, per-platform DOM hints, and
  this architecture page.

There is no `src/` TypeScript code. There is no MCP server. There is no CLI
binary. There is no `package.json` build chain. There are no node modules. The
only `package.json` field that matters is the `version` (for marketplace
metadata).

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

When the harness already provides Read, Edit, Write, Bash, a browser MCP, and
the Telegram plugin, the only thing missing for end-to-end reposting is the
**playbook** — the step-by-step "navigate here, scrape that, dedupe like so,
expand URLs, post here, log there, ping Ethan". That playbook is exactly what
this plugin's skills are.

Coding the playbook into TypeScript means:

- Two implementations to keep in sync (the code + the agent's understanding).
- Brittle DOM selectors hardcoded in source instead of called out in
  per-platform docs the agent reads at runtime.
- A bespoke "agent-task contract" boundary the agent has to learn (v3 had
  this).
- Build / install / dependency churn for something the agent can already do.

The skill-only design eliminates all of that. The agent reads the skill at
runtime. When LinkedIn changes a selector, the fix is a one-line edit in
`docs/destinations/linkedin.md`, not a rebuild + reinstall + push of a new
plugin version.

## What the running agent does at runtime

Concretely, when `/repost-run linkedin-to-x` is invoked:

1. **Slash command resolves to skill.** Claude Code / OpenClaw load
   `commands/run.md`, which dispatches to `skills/repost-run/SKILL.md`.
2. **Agent reads the skill.** The skill is just Markdown — the agent reads it
   like it would read any project doc.
3. **Agent reads pair config.** Native Read tool on `~/.repost-with-agent/pairs.json`.
4. **Agent navigates with the browser MCP.** chrome-devtools-mcp `navigate_page`
   to the LinkedIn profile URL. `take_snapshot` to extract the post list.
5. **Agent reasons about dedupe.** Reads `posted.jsonl` via Read tool.
   Compares `sourceItemId`s. Navigates to the X profile and scrapes recent
   posts. Fuzzy-matches in context.
6. **Agent expands URLs.** Native Bash `curl -sIL --max-time 5` per shortened URL.
7. **Agent drives the destination.** chrome-devtools-mcp `navigate_page`,
   `fill`, `click`. Reads the resulting URL from the page after submit.
8. **Agent appends history.** Native Bash `echo '<json>' >> posted.jsonl`.
9. **Agent Telegram-confirms.** plugin:telegram:telegram `reply` MCP tool.

No code in this plugin does any of those things. The skills tell the agent
what to do; the agent does it.

## Contrast with v3

| Aspect              | v3 (CLI + agent-task contract) | v4 (skill-only) |
| ------------------- | ------------------------------ | --------------- |
| `src/` code         | ~2 500 LOC TypeScript          | 0               |
| Build step          | `tsc → dist/`                  | None |
| Install dependency  | Node + tsx                     | Just bash + python (for install.sh JSON edits) |
| CLI binary          | `repost-with-agent`            | None |
| MCP server          | None                           | None |
| State location      | `~/.repost-with-agent/`        | `~/.repost-with-agent/` (unchanged) |
| Agent boundary      | typed JSON tasks via inbox files | Direct: agent uses native tools per skill |
| Per-platform logic  | TypeScript + skill hints       | Per-platform `docs/destinations/<p>.md` |
| URL expansion       | `src/core/url-expander.ts`     | `skills/repost-url-expand/SKILL.md` (curl via Bash) |
| Dedupe              | `src/core/dedupe.ts`           | `skills/repost-dedup/SKILL.md` (agent reasoning + grep) |
| Notify              | `src/core/notify.ts` HTTPS POST | `skills/repost-notify/SKILL.md` (plugin:telegram:telegram) |
| Cron implementation | CLI invoked from launchd       | Fresh agent subagent invoked from launchd |
| Schedule update     | `pair edit --schedule-kind cron --expression ...` | Edit `pairs.json` field, re-run `/repost-setup-cron` |

## How cron / launchd works

The cron / launchd entry doesn't run any of this plugin's code — there's no
plugin code to run. Instead, it invokes the **same harness chosen for the workflow**. OpenClaw
workflows should use OpenClaw scheduling/session tools; Claude Code invocations
are appropriate only for intentional Claude Code workflows. The fresh scheduled
agent:

1. Loads the plugin (from that harness's plugin registration, such as
   `~/.openclaw/openclaw.json` or `~/.claude/settings.json`).
2. Resolves the slash command → loads the skill.
3. Runs the skill end-to-end.
4. Exits when the skill is done.

The next cron tick spawns a fresh subagent. There is no daemon, no long-running
process, no leftover state in memory. Each tick is independent and idempotent.

This matches Ethan's intent in voice 6026: "yeah, I guess don't follow Agent
Bridge then. So yeah, skip the MCP. Subagent."

## Where the dedupe + URL-expand / etc. logic *lives*

Not in code. In Markdown:

- `skills/repost-dedup/SKILL.md` describes the fuzzy-match algorithm in prose.
- `skills/repost-url-expand/SKILL.md` describes the redirect-following procedure.
- `skills/repost-run/SKILL.md` describes the end-to-end flow that uses both.

The agent reads these at runtime and executes them with its native tools. The
algorithm is:

> normalize whitespace, lowercase, strip URLs, strip trailing punctuation,
> exact-normalized match OR ≥80-char prefix overlap

The agent can apply this directly via reasoning (for ≤20 candidates, which is
the typical case) or shell out to `sed` / `awk` if the candidate set is large
(50+ in a long backfill).

## Failure modes and recovery

- **Browser MCP not loaded** → skill body explicitly checks for it; if missing,
  it tells the user and stops. No silent fallthrough.
- **plugin:telegram:telegram not loaded** → skill writes
  `pair.publish.notify_skipped_unconfigured` to audit.jsonl and surfaces the
  silent publish to the user immediately.
- **Source / destination login expired** → `category: "needs-login"` audit
  event; user must re-login in the browser MCP profile.
- **Cron tick raced with a manual run** → both runs share `posted.jsonl` (file
  appends are atomic in practice for sub-line writes); the second run hits
  local dedupe and skips. No special locking needed at this scale.

## See also

- `docs/state-files.md` — formal state-file schemas.
- `docs/migration-v3-to-v4.md` — the second rewrite explained.
- `docs/destinations/<platform>.md` — per-platform DOM hints.
- `skills/*/SKILL.md` — the actual playbook.
