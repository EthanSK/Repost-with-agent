# Repost-with-agent

Preview-first agent reposting. Saved source → destination pairs, persistent history, real dedupe, no stealth, no ban evasion.

The agent does the reposting through a logged-in browser profile the user controls. This repo supplies the schema, dedupe, audit logs, learnings, adapters, CLI, and host integrations (Claude Code, OpenClaw, agent-bridge). It is *not* a standalone autonomous social-posting framework.

The first concrete adapter pair is LinkedIn source → X destination.

---

## Agent setup guide

> **For an AI agent (Claude Code / OpenClaw) provisioning this for a new user.** Read this section top-to-bottom and execute. Stop and ask the user only on the explicit checkpoints.

### 1. Prereqs

- Node 18+ (`node --version`).
- macOS / Linux. Windows works but isn't routinely tested.
- A persistent browser profile dir for the agent to drive Playwright against. Default is `~/.claude/playwright-profile/` for Claude Code, `~/.openclaw/playwright-profile/` for OpenClaw. Override via `PLAYWRIGHT_PROFILE_DIR`.

### 2. Install

```bash
git clone https://github.com/EthanSK/Repost-with-agent.git
cd Repost-with-agent
./scripts/install-for-openclaw.sh    # works for Claude Code too — name is historical
```

The script: runs `npm install`, builds the TypeScript, smoke-tests `npx repost-with-agent --version`, creates `~/.repost-with-agent/`, prints the OpenClaw plugin id + skills root.

For Claude Code plugin install, point at `.claude-plugin/plugin.json`:

```bash
# in your Claude Code plugin root or via /plugins:
ln -s "$PWD/.claude-plugin" ~/.claude/plugins/repost-with-agent
```

### 3. Environment variables

Copy `.env.example` to `.env` and fill what you need:

| Var | Purpose |
| --- | --- |
| `LINKEDIN_PROFILE_URL` | The `/recent-activity/all/` URL of the LinkedIn account to mirror. |
| `PLAYWRIGHT_PROFILE_DIR` | Persistent browser profile path (must already be logged into LinkedIn). |
| `X_CLIENT_ID` / `X_CLIENT_SECRET` | X OAuth 2.0 PKCE app — only needed if using `repost-with-agent auth` for API-based posting. |
| `X_CHAR_LIMIT` | `25000` for X Premium, `280` otherwise. |
| `REPOST_DATA_DIR` | Override `~/.repost-with-agent` if needed. |
| `FACEBOOK_*` | Optional, deprecated path. Default off. |

### 4. Persistent browser login (one-time, human required)

The agent CANNOT log in for the user. The persistent profile must already have valid sessions for both source and destination. Have the human:

1. Open the Playwright profile dir manually (`npx playwright open --user-data-dir=$PLAYWRIGHT_PROFILE_DIR https://www.linkedin.com/`).
2. Log into LinkedIn (handle 2FA / CAPTCHA).
3. In the same profile, log into `https://x.com/`.

Stop and ping the user if either login challenge appears at runtime. **Never bypass CAPTCHA / 2FA / phone verification.**

### 5. Create the first pair

```bash
npx repost-with-agent pair create \
  --name "LinkedIn to X" \
  --source-type linkedin-profile-activity \
  --source-url "https://www.linkedin.com/in/<you>/recent-activity/all/" \
  --destination-type x-account \
  --destination-account "@<you>"
```

New pairs default to `mode: preview-only` and `enabled: false`. This is intentional. The agent must run a successful preview before suggesting `pair edit` to flip mode to `approval-required`.

### 6. Dedupe baseline import (one-time, if migrating)

If the user previously ran the legacy `linkedin-to-x` tool, import its history so old posts don't re-publish:

```bash
npx repost-with-agent migrate linkedin-to-x \
  --source-url "https://www.linkedin.com/in/<you>/recent-activity/all/" \
  --destination-account "@<you>"
```

This creates a *separate* legacy pair, imports `~/.linkedin-to-x/posted.md` into per-pair `posted.jsonl`, and leaves the old files untouched. Verify with:

```bash
npx repost-with-agent pair history linkedin-to-x
```

The dedupe layer matches on `sourceItemId` → `canonicalUrl` → `contentHash`. All three must miss for an item to be considered new. See `src/core/dedupe.ts`.

### 7. Dry run / preview

```bash
npx repost-with-agent pair preview <pair-id>
```

Outputs auth health, candidate list, drafted post text, dedupe decision (`new` / `duplicate` / `uncertain`), and any warnings. Posts nothing. Audit-logs to `~/.repost-with-agent/pairs/<pair-id>/audit.jsonl`.

### 8. Approval-required publish

The agent never auto-publishes. To live-publish the next eligible candidate:

```bash
npx repost-with-agent pair post <pair-id> --approve
```

Mode must be `approval-required` or `live-approved`. The command re-runs preview, re-checks dedupe at post-time (race-safe), and refuses if the top candidate is `uncertain` unless you also pass `--allow-uncertain`. On success it appends to `posted.jsonl` with `sourceItemId`, `canonicalUrl`, `contentHash`, `destinationId`, `postedAt`, `summary`.

### 9. Telegram notifications (optional, host-driven)

Repost-with-agent itself does not send Telegram. If you're running it under OpenClaw or Claude Code with the Telegram channel plugin, schedule the cron with `--announce` and the host will deliver each run's stdout to the user's Telegram chat. See "Scheduling".

### 10. Sanity checklist before handing back to the user

- [ ] `npx repost-with-agent pair list` shows the new pair.
- [ ] `npx repost-with-agent pair preview <id>` succeeds without auth errors.
- [ ] `~/.repost-with-agent/pairs/<id>/posted.jsonl` exists (or is empty if first run).
- [ ] `audit.jsonl` has a `pair.created` and `pair.preview` entry.
- [ ] Cron / launchd / OpenClaw schedule (if requested) is registered with `max_items_per_run: 1` and `approval: manual` unless the user explicitly asked for live.

---

## Terminology

| Term | Meaning |
| --- | --- |
| **Pair** | A saved (source, destination, policy, schedule) record stored in `~/.repost-with-agent/pairs.json`. Identified by a slug like `linkedin-to-x`. |
| **Source** | Where content is fetched from. Currently: `linkedin-profile-activity`. The source adapter scrapes via the persistent Playwright profile. |
| **Destination** | Where content is published. Currently: `x-account`. The destination adapter uses X OAuth 2.0 (PKCE) tokens stored in `~/.repost-with-agent/x-tokens.json`. |
| **Adapter** | The thin per-platform layer that exposes `test()`, `fetchCandidates()`, `preview()`, `publish()`. Lives under `src/adapters/sources/` and `src/adapters/destinations/`. Add a new platform = add a new adapter. |
| **Preview** | Read-only run: auth check + candidate fetch + draft + dedupe decision. Posts nothing. Always idempotent. |
| **Approve** | A human / authorized agent setting `--approve` (and optionally `--allow-uncertain`) on `pair post`. Without it the orchestrator returns `needs-approval` and writes nothing. |
| **Publish** | The actual destination call. Only happens when (a) mode is not `preview-only`, (b) `--approve` is set, (c) dedupe re-check at post-time is clean, (d) destination auth health is `ok`. |
| **`posted.jsonl`** | Per-pair history at `~/.repost-with-agent/pairs/<id>/posted.jsonl`. One JSON line per published item. Schema: `sourceItemId`, `canonicalUrl`, `contentHash`, `destinationType`, `destinationId`, `postedAt`, `summary`. The dedupe layer reads this on every preview / post. |
| **`audit.jsonl`** | Per-pair audit log at `~/.repost-with-agent/pairs/<id>/audit.jsonl`. Records every `pair.preview`, `pair.publish.*`, `pair.created`, etc. event. Useful for debugging duplicates and run failures. |
| **Dedupe baseline** | The set of `posted.jsonl` entries an agent / migration has loaded into the pair before its first live run. Critical: any new candidate with a matching `sourceItemId`, `canonicalUrl`, or normalized `contentHash` is rejected before the destination call. |
| **`accountHint`** | Human-readable destination identifier (e.g. `@example`) stored on the pair. Not the auth credential — auth lives in `authRef` plus the OAuth token store. |
| **Pair mode** | One of `preview-only` (default; refuses to publish), `approval-required` (publishes only with explicit `--approve`), `live-approved` (publishes with `--approve`; reserved for trusted operator-driven runs). |
| **Workspace** | An optional user-owned directory created by `scripts/init_repost_with_agent_workspace.py`. Holds `user-setup.json`, `queue.jsonl`, `state.json`, `logs/`. Use this when you want queue-driven runs instead of pair-driven runs. |
| **Run policy** | Schedule + concurrency knobs on a pair or workspace: `max_items_per_run`, `min_interval_minutes`, `approval`, `mode`. Read by the host scheduler, not by the CLI itself. |
| **Learnings** | A free-form Markdown file at `~/.repost-with-agent/pairs/<id>/learnings.md` loaded before every preview / run. Record duplicate patterns, formatting quirks, platform cautions there. |

---

## Principles

- Preview first. New pairs default to `preview-only`.
- User controlled. No hidden posting, no stealth, no CAPTCHA / 2FA bypass.
- Official APIs where possible.
- Agent-operated browser flows where APIs are unavailable, using a persistent profile the user controls.
- Multiple saved pairs with persistent history, audit logs, and learnings loaded every run.
- Usable through OpenClaw or Claude Code as the operator, without making the project about agent infrastructure.

## Install

```bash
npm install
npm run build
```

Or use the one-shot installer:

```bash
./scripts/install-for-openclaw.sh
```

The public CLI is:

```bash
npx repost-with-agent --help
```

Legacy alias still works:

```bash
npx linkedin-to-x --help
```

## Runtime state

Public repo files stay in the repo. Runtime state stays outside it:

```text
~/.repost-with-agent/
  pairs.json
  x-tokens.json
  pairs/<pair-id>/
    audit.jsonl
    drafts.jsonl
    findings.jsonl
    posted.jsonl
    state.json
    learnings.md
```

Legacy runtime state stays at `~/.linkedin-to-x/`; migration imports from it without deleting or archiving it.

## Agent workspace template

For queue-based agent runs, create a user-owned workspace outside the repo:

```bash
python3 scripts/init_repost_with_agent_workspace.py ~/repost_with_agent_workspace
```

That creates:

```text
repost_with_agent_workspace/
  user-setup.json   # accounts, browser profile, target platforms, publish/run policy
  queue.jsonl       # one queued repost item per line
  state.json        # completed/drafted/blocked/failed/skipped tracking
  logs/             # concise proof and run notes
```

Default workspace policy is manual / approval-first: the agent may prepare previews / drafts, but must stop before public posting unless the current request and setup explicitly authorize live posting.

## Pair commands

```bash
npx repost-with-agent pair create ...      # see Agent setup guide §5
npx repost-with-agent pair list
npx repost-with-agent pair show <id>
npx repost-with-agent pair preview <id>
npx repost-with-agent pair history <id>
npx repost-with-agent pair post <id> --approve [--allow-uncertain]
```

## X auth

If you want to prepare X OAuth2 tokens for live posting:

```bash
npx repost-with-agent auth
```

Tokens stored in `~/.repost-with-agent/x-tokens.json`. If new tokens are absent, the tool also checks the legacy location `~/.linkedin-to-x/x-tokens.json`.

## Migration from `linkedin-to-x`

```bash
npx repost-with-agent migrate linkedin-to-x \
  --source-url "https://www.linkedin.com/in/<you>/recent-activity/all/" \
  --destination-account "@<you>"
```

Behavior:

- creates a disabled `preview-only` pair;
- imports old `~/.linkedin-to-x/posted.md` entries into per-pair `posted.jsonl`;
- records an audit event with the known duplicate incident: 2026-03-24 duplicate post `https://x.com/i/status/2036422890271215716`, fix commit `9d37108`;
- leaves legacy files untouched.

## Scheduling

Scheduling is host-driven. Use `user-setup.json.run_policy` for queue workspaces, or pair `schedule` fields for pair workflows, then have OpenClaw / cron / launchd invoke the skill or CLI on that cadence.

Recommended flow:

1. create the pair
2. preview it
3. inspect history / learnings
4. schedule preview / approval runs with `max_items_per_run: 1` unless the user deliberately chooses a different policy

Do not schedule blind public posting by default.

### OpenClaw cron example

```bash
openclaw cron add \
  --name "Repost-with-agent preview" \
  --cron "0 10 * * 1-5" \
  --tz "Europe/London" \
  --session isolated \
  --message "Use the repost-with-agent skill. In ~/Projects/Repost-with-agent, inspect the saved pair/workspace state, run preview/history only, respect manual approval, max 1 item, and report candidates/blockers. Do not publish publicly unless the saved policy and current instruction explicitly authorize live posting." \
  --announce
```

For a queue workspace, make the workspace path explicit in the message:

```bash
openclaw cron add \
  --name "Repost workspace preview" \
  --cron "0 10 * * *" \
  --tz "Europe/London" \
  --session isolated \
  --message "Use the repost-with-agent skill with ~/repost_with_agent_workspace. Read user-setup.json, queue.jsonl, state.json, and logs; process at most 1 eligible item; stop at draft/preview when publish_mode or approval is manual; update state/logs; announce the result." \
  --announce
```

Inspect:

```bash
openclaw cron list
openclaw cron show <job-id>
openclaw cron runs --id <job-id>
```

## Agent-bridge integration

Repost-with-agent is reachable via [agent-bridge](https://github.com/EthanSK/agent-bridge) so a Claude / OpenClaw session on one machine can drive a Repost-with-agent install on another.

**Pattern:** the remote agent receives a natural-language `/repost <verb> [args]` message and routes it to `scripts/agent-bridge-handler.sh`, which wraps the safe subset of CLI commands. There is no separate MCP server — the existing `bridge_send_message` channel + a shell handler is enough.

From the calling side:

```text
bridge_send_message({
  machine: "<paired-machine>",
  target: "claude-code" | "openclaw/<account>",
  message: "/repost preview linkedin-to-x"
})
```

The receiving agent reads `scripts/agent-bridge-handler.sh` and runs the matching verb:

| Verb | Maps to |
| --- | --- |
| `list` | `pair list` |
| `show <id>` | `pair show <id>` |
| `preview <id>` | `pair preview <id>` |
| `history <id>` | `pair history <id>` |
| `status` | env summary + pair count |
| `safe-publish <id>` | refuses; emits a JSON `needs-approval` stub asking the local operator to run the publish themselves |

The handler is deliberately read-only / approval-gated. **No remote machine can publish on your behalf.** A live publish always needs the local operator to run `pair post <id> --approve` directly.

## Agent-operated setup files

The repo ships lightweight host integration so an agent can drive the workflow without re-implementing scraping / posting:

- `openclaw.plugin.json`
- `.claude-plugin/plugin.json`
- `skills/repost-pair-setup/SKILL.md`
- `skills/repost-run/SKILL.md`
- `commands/pair.md`
- `commands/preview.md`
- `commands/run.md`
- `scripts/install-for-openclaw.sh`
- `scripts/agent-bridge-handler.sh`

These integrations are only for controlling the cross-posting workflow: create pairs, preview, inspect history, run / schedule safely. They are not a separate agent app / framework.

## Legacy commands

Old direct commands are still present for compatibility and are marked deprecated:

- `repost-with-agent sync`
- `repost-with-agent list`
- `repost-with-agent start`

These preserve the old hardcoded LinkedIn → X / Facebook behavior and use the legacy tracker location (`~/.linkedin-to-x/posted.md`, overrideable with `LINKEDIN_TO_X_DATA_DIR`). New setup should use `pair` commands.

Facebook support is treated as legacy / experimental until a cautious destination adapter exists. Do not enable blind Facebook posting by default; keep it approval-gated and explicitly configured.

## Safety

- No stealth, ban evasion, or anti-detection logic.
- No CAPTCHA or 2FA bypass.
- No password collection in chat.
- Browser automation is only for transparent, user-controlled login sessions.
- Conservative cadence is for spam / duplicate reduction, not detection evasion.
- Live posting requires explicit `--approve`; the orchestrator re-checks dedupe at post-time.

See [docs/architecture.md](docs/architecture.md), [docs/setup-flow.md](docs/setup-flow.md), [docs/safety.md](docs/safety.md), [docs/migration.md](docs/migration.md).

## License

MIT. See [LICENSE](LICENSE).
