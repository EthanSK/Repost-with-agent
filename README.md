# Repost-with-agent

Repost-with-agent (`repost_with_agent` in user-facing/workspace names) is a portable, preview-first agent workflow/skill/plugin for saved source → destination reposting.

The repo supplies setup files, queue/state/log templates, adapter-backed CLI commands, and run instructions for an agent operating a logged-in browser. It is not a standalone autonomous social-posting framework.

The first concrete adapter pair is LinkedIn source → X destination. The repo keeps the old working scraper/client code where practical, but the public direction is now generic pair setup, preview, history, workspace queues, and scheduled agent runs.

## Principles

- Preview first. New pairs default to `preview-only`.
- User controlled. No hidden posting, no stealth, no CAPTCHA/2FA bypass.
- Official APIs where possible.
- Agent-operated browser flows where APIs are unavailable, using a persistent profile the user controls.
- Multiple saved pairs with persistent history, audit logs, and learnings loaded every run.
- Usable through OpenClaw or Claude Code as the operator, without making the project about agent infrastructure.

## Current scope

Implemented in this foundation pass:

- package/CLI rename to `repost-with-agent`;
- legacy `linkedin-to-x` bin alias preserved;
- runtime store under `~/.repost-with-agent`;
- pair schema, per-pair paths, posted history, audit log, and learnings files;
- agent workspace initializer with `user-setup.json`, `queue.jsonl`, `state.json`, and `logs/`;
- adapter interfaces plus LinkedIn source and X destination wrappers;
- safe CLI pair commands:
  - `pair create`
  - `pair list`
  - `pair show <id>`
  - `pair preview <id>`
  - `pair history <id>`
  - `migrate linkedin-to-x`
- agent-facing setup files for OpenClaw and Claude Code that operate the reposting CLI/core.

Not implemented yet:

- conversational prompting inside the CLI itself;
- live pair publishing command;
- scheduling command that writes cron/launchd/OpenClaw schedules automatically.

## Install

```bash
npm install
npm run build
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

Default workspace policy is manual/approval-first: the agent may prepare previews/drafts, but must stop before public posting unless the current request and setup explicitly authorize live posting.

## Pair setup

Create a saved LinkedIn → X pair:

```bash
npx repost-with-agent pair create \
  --name "LinkedIn to X" \
  --source-type linkedin-profile-activity \
  --source-url "https://www.linkedin.com/in/example/recent-activity/all/" \
  --destination-type x-account \
  --destination-account "@example"
```

List pairs:

```bash
npx repost-with-agent pair list
```

Show one pair:

```bash
npx repost-with-agent pair show linkedin-to-x
```

Preview safely without posting:

```bash
npx repost-with-agent pair preview linkedin-to-x
```

Show audit/history:

```bash
npx repost-with-agent pair history linkedin-to-x
```

## X auth

If you want to prepare X OAuth2 tokens for future live posting support:

```bash
npx repost-with-agent auth
```

This stores tokens in `~/.repost-with-agent/x-tokens.json`. If new tokens are absent, the tool also checks the old legacy location `~/.linkedin-to-x/x-tokens.json`.

## Migration from `linkedin-to-x`

Create a saved legacy pair and import old tracker history:

```bash
npx repost-with-agent migrate linkedin-to-x \
  --source-url "https://www.linkedin.com/in/example/recent-activity/all/" \
  --destination-account "@example"
```

Migration behavior in this pass:

- creates a disabled `preview-only` pair;
- imports old `~/.linkedin-to-x/posted.md` entries into per-pair `posted.jsonl`;
- records an audit event with the known duplicate incident:
  - 2026-03-24 duplicate post: `https://x.com/i/status/2036422890271215716`
  - fix commit: `9d37108`
- leaves legacy files untouched.

## Scheduling

Scheduling is host-driven. Use `user-setup.json.run_policy` for queue workspaces, or pair `schedule` fields for pair workflows, then have OpenClaw cron/launchd/cron invoke the skill or CLI on that cadence.

Recommended flow:

1. create the pair;
2. preview it;
3. inspect history/learnings;
4. schedule preview/approval runs with `max_items_per_run: 1` unless the user deliberately chooses a different policy.

Do not schedule blind public posting by default.

## Agent-operated setup

This repo now ships lightweight OpenClaw and Claude Code integration files so an agent can operate the reposting workflow without inventing its own scraping/posting logic:

- `openclaw.plugin.json`
- `.claude-plugin/plugin.json`
- `skills/repost-pair-setup/SKILL.md`
- `skills/repost-run/SKILL.md`
- `commands/pair.md`
- `commands/preview.md`
- `commands/run.md`

These integrations are only for controlling the cross-posting workflow: create pairs, preview, inspect history, and later run/schedule safely. They are not a separate agent app/framework.

## Legacy commands

The old direct commands are still present for compatibility and are marked deprecated:

- `repost-with-agent sync`
- `repost-with-agent list`
- `repost-with-agent start`

Those preserve the old hardcoded LinkedIn → X/Facebook behavior and use the legacy tracker location (`~/.linkedin-to-x/posted.md`, overrideable with `LINKEDIN_TO_X_DATA_DIR`). New setup should use `pair` commands.

Facebook support is treated as legacy/experimental until a cautious destination adapter exists. Do not enable blind Facebook posting by default; keep it approval-gated and explicitly configured.

## Safety

- No stealth, ban evasion, or anti-detection logic.
- No CAPTCHA or 2FA bypass.
- No password collection in chat.
- Browser automation is only for transparent, user-controlled login sessions.
- Conservative cadence is for spam/duplicate reduction, not detection evasion.

See [docs/architecture.md](docs/architecture.md), [docs/setup-flow.md](docs/setup-flow.md), [docs/safety.md](docs/safety.md), and [docs/migration.md](docs/migration.md).
