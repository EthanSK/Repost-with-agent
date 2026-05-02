# Repost-with-agent

Agent-driven, browser-based reposting. The CLI is a thin orchestrator over JSON state; the agent (Claude Code via `chrome-devtools-mcp`, OpenClaw via its built-in browser tool) drives the user's logged-in browser to do the actual cross-posting.

v3.0.0 (2026-05-01) is a deliberate strip-and-rewrite. There is **no API path** (no `@atproto/api`, no Threads Graph, no twitter SDK, no facebook-nodejs-business-sdk) and **no Playwright** in `src/`. Platform names (`linkedin`, `x`, `bluesky`, `threads`, `facebook`) are free-form string labels in pair config; the agent reads them at task-execution time and picks the right URL templates and DOM selectors.

> **The whole project is just instructions for an agent.** (Ethan voice 6016, 2026-05-01.)

---

> **Important — Telegram-confirm every successful publish — non-negotiable.** Every successful post from this tool MUST trigger a Telegram message to Ethan confirming what was posted, the source URL, and the destination URL. The CLI does this automatically via the configured `notify.telegram` channel. If you are an agent operating on this repo and you trigger a publish through any non-CLI path you MUST also fire a Telegram confirmation. Silent publishes are a bug. Wire it up once, before the first live publish:
>
> ```bash
> repost-with-agent notify configure --bot-token <TELEGRAM_BOT_TOKEN> --chat-id <CHAT_ID> --test
> ```
>
> (Ethan voice 5977 + 5978, 2026-05-01.)

---

## Agent setup guide

> **For an AI agent (Claude Code / OpenClaw) provisioning this for a new user.** Read this section top-to-bottom and execute. Stop and ask the user only on the explicit checkpoints.

### 1. Prereqs

- Node 18+ (`node --version`).
- macOS / Linux. Windows works but isn't routinely tested.
- An agent harness with a working browser MCP:
  - **Claude Code**: `chrome-devtools-mcp` (preferred) or `claude-in-chrome` plugin connected.
  - **OpenClaw**: built-in browser tool enabled.
- The user logged into source AND destination platforms inside the agent's persistent browser profile. The agent CANNOT log in for the user.

### 2. Install

```bash
git clone https://github.com/EthanSK/Repost-with-agent.git
cd Repost-with-agent
./scripts/install-for-openclaw.sh    # works for Claude Code too — name is historical
```

The script: runs `npm install` (commander only — no Playwright, no API SDKs), builds the TypeScript, smoke-tests `npx repost-with-agent --version`, creates `~/.repost-with-agent/`, prints the OpenClaw plugin id + skills root.

For Claude Code plugin install:

```bash
ln -s "$PWD/.claude-plugin" ~/.claude/plugins/repost-with-agent
```

### 3. Wire up Telegram notify (do this FIRST)

```bash
repost-with-agent notify configure --bot-token <TELEGRAM_BOT_TOKEN> --chat-id <CHAT_ID> --test
repost-with-agent notify status     # MUST report `Resolved source: file` (or `env`)
```

If the test message doesn't land, fix this BEFORE flipping any pair to live. Without it, every live publish prints a loud WARN and writes a `pair.publish.notify_skipped_unconfigured` audit event but the post WILL still go out — that's a project bug, not a feature.

### 4. Persistent browser login (one-time, human required)

The agent CANNOT log in for the user. Have the human:

1. Open the agent's persistent browser profile.
2. Log into the source platform (LinkedIn / X / Bluesky / Threads / Facebook). Handle 2FA / CAPTCHA inline.
3. In the same profile, log into the destination platform.

Stop and ping the user if either login challenge appears at runtime. **Never bypass CAPTCHA / 2FA / phone verification.**

### 5. Create the first pair

```bash
npx repost-with-agent pair create \
  --source-platform linkedin \
  --source-url "https://www.linkedin.com/in/<you>/recent-activity/all/" \
  --destination-platform x \
  --destination-account "@<your-handle>" \
  --run-mode listen-for-future \
  --mode preview-only
```

New pairs default to `mode: preview-only` and `enabled: false`. This is intentional. Run a successful preview before flipping mode to `approval-required` or `live-approved`.

Supported `--source-platform` and `--destination-platform` values: `linkedin`, `x`, `bluesky`, `threads`, `facebook`. The fields are free-form strings, so adding a new platform is a matter of writing `docs/destinations/<platform>.md` and teaching the agent the URL templates.

### 6. Preview the pair

```bash
npx repost-with-agent pair preview <pair-id>
```

What happens:

1. CLI loads the pair config.
2. Orchestrator emits a `[agent-task fetch-source ...]` banner. The task JSON is also written to `~/.repost-with-agent/agent-tasks/<correlation_id>.task.json`.
3. The agent (you) reads the task and uses its browser MCP to navigate to `pair.source.url`, scroll until enough posts load, scrape post text + canonical URL.
4. The agent writes a `fetch-source-result` to `<correlation_id>.result.json`. The orchestrator picks it up.
5. CLI prints the draft + dedupe decision + warnings.

Posts nothing. Audit-logs to `~/.repost-with-agent/pairs/<pair-id>/audit.jsonl`.

### 7. Approval-required publish

```bash
npx repost-with-agent pair edit <pair-id> --mode live-approved --enable
npx repost-with-agent pair post <pair-id> --approve
```

The command re-runs preview, re-checks dedupe at post-time (race-safe), refuses if the top candidate is `uncertain` unless you also pass `--allow-uncertain`, and refuses on `preview-only` mode. On success it appends to `posted.jsonl`, fires Telegram notify, and emits `pair.publish.success`.

Drafts that exceed the destination's char cap (X=280, Bluesky=300, Threads=500, Facebook=63206, LinkedIn=3000) are blocked at publish time by default. Pass `--overlength-strategy truncate` to opt in to smart truncation (sentence-boundary / word-boundary / hard-cut + ellipsis).

### 8. Backfill (newest-first walk-back)

```bash
npx repost-with-agent pair backfill <pair-id> --pages 2 --max 20 --interval-minutes 10 --dry-run
npx repost-with-agent pair backfill <pair-id> --pages 2 --max 20 --interval-minutes 10 --allow-publish
```

v3.0.0 ordering: **newest-first** (Ethan voice 6021). Cross-state dedupe runs against both `posted.jsonl` AND the destination platform itself (via a `check-destination` agent task). Idempotent restart — the resume state file lets a killed backfill pick up where it left off. See [docs/WORKFLOW.md](docs/WORKFLOW.md).

### 9. Sanity checklist before handing back to the user

- [ ] `npx repost-with-agent pair list` shows the new pair.
- [ ] `npx repost-with-agent pair preview <id>` succeeds without auth errors.
- [ ] `~/.repost-with-agent/pairs/<id>/posted.jsonl` exists (or is empty if first run).
- [ ] `audit.jsonl` has a `pair.created` and `pair.preview` entry.
- [ ] **`repost-with-agent notify status` reports `source: file` (or `env`), not `none`.**
- [ ] Cron / launchd / OpenClaw schedule (if requested) is registered with `--allow-publish` only when the user explicitly authorizes live posting.

---

## v3.0.0 architecture in two paragraphs

The CLI is a thin orchestrator over `~/.repost-with-agent/pairs.json`, per-pair `posted.jsonl`, and an audit log. The orchestrator emits typed `AgentTask` JSON (kinds: `fetch-source`, `post-to-destination`, `check-destination`) and consumes typed `AgentResult` JSON. The agent fulfils each task by driving the user's logged-in browser via its own browser MCP. Tasks are delivered via stdout banners + filesystem inbox at `~/.repost-with-agent/agent-tasks/`, OR via an in-process callback (used by tests + inline-driven CLI flows).

Two run-modes (Ethan voice 6021): **`backfill`** walks back through historical posts newest-first; **`listen-for-future`** runs as a continuous tail via the host scheduler (`pair scheduled-run`). Both modes share the same agent-task contract; only the orchestration loop differs. Drafts pass through a fail-soft URL expander before publish (5-hop, 5-second, lnkd.in / t.co / bit.ly / etc.) — see [docs/url-expander.md](docs/url-expander.md).

Full layer model: [docs/architecture.md](docs/architecture.md). Per-platform DOM hints: [docs/destinations/](docs/destinations/).

## Terminology

| Term | Meaning |
| --- | --- |
| **Pair** | A saved (source platform, destination platform, policy, schedule, run-mode) record stored in `~/.repost-with-agent/pairs.json`. Identified by a slug like `linkedin-to-x`. |
| **Source platform** | Free-form string label (e.g. `linkedin`, `x`, `bluesky`). The agent reads it and picks the right URL templates / DOM selectors. |
| **Destination platform** | Same as above, on the publish side. |
| **Run mode** | `backfill` (walk-back, newest-first) or `listen-for-future` (continuous tail via host scheduler). |
| **Pair mode** | One of `preview-only` (default; refuses to publish), `approval-required` (publishes only with explicit `--approve`), `live-approved` (publishes with `--approve`; required for unattended scheduled runs). |
| **Agent task** | A typed JSON message the CLI hands to the agent (`fetch-source`, `post-to-destination`, `check-destination`). Each carries a `correlation_id`; the agent echoes it back in the matching `AgentResult`. |
| **Preview** | Read-only run: emit `fetch-source` task, consume result, dedupe-check, build draft. Posts nothing. Always idempotent. |
| **Approve** | A human / authorized agent setting `--approve` on `pair post`. Without it the orchestrator returns `needs-approval` and writes nothing. |
| **Publish** | The actual destination call (a `post-to-destination` agent task). Only happens when (a) mode is not `preview-only`, (b) `--approve` is set, (c) dedupe re-check at post-time is clean, (d) overlength check passes. |
| **`posted.jsonl`** | Per-pair history at `~/.repost-with-agent/pairs/<id>/posted.jsonl`. One JSON line per published item. The dedupe layer reads this on every preview / post. |
| **`audit.jsonl`** | Per-pair audit log. Records every `pair.preview`, `pair.publish.*`, `pair.created`, `pair.scheduled.*`, `pair.backfill.*` event. |
| **URL expander** | Pre-publish helper that follows shortener redirects (lnkd.in / t.co / bit.ly / etc.) up to 5 hops with a 5-second per-hop timeout. Fail-soft. |
| **Learnings** | A free-form Markdown file at `~/.repost-with-agent/pairs/<id>/learnings.md` loaded before every preview / run. |

## Principles

- Preview first. New pairs default to `preview-only`.
- User controlled. No hidden posting, no stealth, no CAPTCHA / 2FA bypass.
- Agent's browser MCP > custom Playwright stack. The same logged-in profile the user maintains for ad-hoc browsing IS the profile the reposting tool uses.
- No platform API SDKs. The whole point of v3 is delegation to the agent's browser.
- Multiple saved pairs with persistent history, audit logs, and learnings loaded every run.
- Usable through Claude Code or OpenClaw without the project becoming an "agent framework".

## Install

```bash
npm install
npm run build
```

Or use the one-shot installer:

```bash
./scripts/install-for-openclaw.sh
```

The CLI is:

```bash
npx repost-with-agent --help
```

## Runtime state

```text
~/.repost-with-agent/
  pairs.json                                # All pair configs
  pairs.json.v2.bak                         # One-shot v2 → v3 backup (only if migration ran)
  notify.json                               # Telegram bot token + chat id (mode 0600)
  agent-tasks/<correlation_id>.task.json     # CLI → agent
  agent-tasks/<correlation_id>.result.json   # agent → CLI
  pairs/<pair-id>/
    audit.jsonl
    drafts.jsonl
    findings.jsonl
    posted.jsonl
    state.json
    backfill-state.json                     # Resume state during a backfill
    learnings.md
    logs/                                   # launchd stdout / stderr
```

## Pair commands

```bash
npx repost-with-agent pair create --source-platform <p> --destination-platform <p> ...
npx repost-with-agent pair list
npx repost-with-agent pair show <id>
npx repost-with-agent pair preview <id>
npx repost-with-agent pair history <id>
npx repost-with-agent pair post <id> --approve [--allow-uncertain] [--overlength-strategy truncate]
npx repost-with-agent pair backfill <id> --max 20 --pages 2 --interval-minutes 10 \
    [--allow-publish] [--overlength-strategy skip|truncate]
npx repost-with-agent pair scheduled-run <id> [--allow-publish] [--json]
npx repost-with-agent pair schedule <id> [--apply launchd] [--allow-publish]
npx repost-with-agent pair unschedule <id>
npx repost-with-agent pair edit <id> --mode <m> --run-mode <m> --schedule-kind <k> ...
```

## Notify commands

```bash
npx repost-with-agent notify configure --bot-token <T> --chat-id <C> [--test] [--disable]
npx repost-with-agent notify status
npx repost-with-agent notify test [--pair-id <id>]
```

**Telegram-confirm every successful publish — non-negotiable.** See §3 of the Agent setup guide for the full contract.

## URL expander

```bash
npx repost-with-agent urls expand <url>                                    # follow one URL
npx repost-with-agent urls expand-text "Check out https://lnkd.in/abc"     # expand every URL in text
```

5 hops max, 5-second timeout per request, fail-soft. See [docs/url-expander.md](docs/url-expander.md).

## Migration from v2

v2-shaped `pairs.json` is auto-migrated on first read of any pair command. The original is backed up to `~/.repost-with-agent/pairs.json.v2.bak`; the migration injects `platform` labels into `source` / `destination`, sets `runMode: "listen-for-future"`, stamps `schemaVersion: 3`. Existing `posted.jsonl` history is preserved untouched.

See [docs/migration-v2-to-v3.md](docs/migration-v2-to-v3.md) for the full walkthrough including auth-state changes (the v2 X OAuth tokens are now ignored — log in via the browser instead).

## Scheduling

Scheduling is host-driven. Repost-with-agent does not run a daemon — OpenClaw cron / launchd / system cron fires the tick and invokes a deterministic CLI entry point that runs preview-or-publish under the saved policy.

Per-tick CLI entry point (host scheduler should call this):

```bash
repost-with-agent pair scheduled-run <pair-id> [--allow-publish] [--json]
```

Helpers to wire up the host scheduler:

```bash
repost-with-agent pair schedule <pair-id>            # render launchd plist + crontab line + openclaw cron command
repost-with-agent pair schedule <pair-id> --apply launchd
repost-with-agent pair unschedule <pair-id>
repost-with-agent pair edit <pair-id> --schedule-kind cron --schedule-expression "0 10 * * 1-5" --timezone Europe/London
```

See [docs/scheduling.md](docs/scheduling.md) for the outcome taxonomy, audit-log format, cron-to-launchd translation rules, and the full safety matrix.

Scheduled ticks default to **preview-only**. `--allow-publish` is opt-in AND requires `pair.mode === "live-approved"`.

## Agent-bridge integration

Repost-with-agent is reachable via [agent-bridge](https://github.com/EthanSK/agent-bridge) so a Claude / OpenClaw session on one machine can drive a Repost-with-agent install on another.

| Verb | Maps to |
| --- | --- |
| `list` | `pair list` |
| `show <id>` | `pair show <id>` |
| `preview <id>` | `pair preview <id>` |
| `history <id>` | `pair history <id>` |
| `scheduled-run <id>` | `pair scheduled-run <id> --json` (always preview-only over the bridge) |
| `schedule <id>` | `pair schedule <id>` (read-only render of scheduling artifacts) |
| `status` | env summary + pair count |
| `safe-publish <id>` | refuses; emits a JSON `needs-approval` stub asking the local operator to run the publish themselves |

The handler is deliberately read-only / approval-gated. **No remote machine can publish on your behalf.**

## Agent-operated setup files

```
openclaw.plugin.json
.claude-plugin/plugin.json
skills/repost-pair-setup/SKILL.md
skills/repost-run/SKILL.md
commands/pair.md
commands/preview.md
commands/run.md
scripts/install-for-openclaw.sh
scripts/agent-bridge-handler.sh
```

These integrations are only for controlling the cross-posting workflow: create pairs, preview, inspect history, run / schedule safely. They are not a separate agent app / framework.

## Safety

- No stealth, ban evasion, or anti-detection logic.
- No CAPTCHA or 2FA bypass.
- No password collection in chat.
- Browser automation is only for transparent, user-controlled login sessions.
- Conservative cadence is for spam / duplicate reduction, not detection evasion.
- Live posting requires explicit `--approve`; the orchestrator re-checks dedupe at post-time.

See [docs/safety.md](docs/safety.md), [docs/WORKFLOW.md](docs/WORKFLOW.md), [docs/scheduling.md](docs/scheduling.md), [docs/architecture.md](docs/architecture.md), [docs/url-expander.md](docs/url-expander.md), [docs/migration-v2-to-v3.md](docs/migration-v2-to-v3.md).

## License

MIT. See [LICENSE](LICENSE).
