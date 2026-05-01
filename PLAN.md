# PLAN.md — Repost-with-agent

_Last updated: 2026-05-01 18:48 BST_

## Correct interpretation

Repost-with-agent is a portable agent-driven social/source-site → social/destination-site reposting workflow/skill/plugin.

- First concrete adapter: LinkedIn profile/activity → X account.
- Future shape: any supported source site/account/feed → any supported destination site/account/channel.
- The project was formerly the local `linkedin-to-x` repo; the local folder is now `~/Projects/Repost-with-agent`.
- The GitHub remote now points at `https://github.com/EthanSK/Repost-with-agent.git` after the public repo rename.

## User requirements captured

- [x] Do not call the app/repo LinkedIn-to-X anymore.
- [x] Rename local repo folder to `Repost-with-agent` without making a duplicate copy.
- [x] Rename package/app/CLI from `linkedin-to-x` to `repost-with-agent`.
- [x] Rename public GitHub repo from `linkedin-to-x` to `Repost-with-agent` after local rewrite is ready.
- [x] Keep LinkedIn → X as the first concrete adapter/example.
- [x] Make it generic: source social/site → destination social/site pairs.
- [x] Make it usable through an agent conversation, not just hand-edited `.env`.
- [x] Setup flow: ask for source website/account, ask for destination website/account, authenticate/test, preview, save pair, schedule.
- [x] Support multiple saved pairs.
- [x] Support cron/scheduled runs with slow/responsible cadence.
- [x] Keep persistent logs/history/learnings that future runs load.
- [x] Be compatible with OpenClaw.
- [x] Be compatible with Claude Code.
- [x] Ship as a public, user-friendly repo with README/setup docs.
- [x] Include a checklist and tick it off as work is done.
- [x] Avoid duplicate local copies; use this renamed repo as the single working copy.

## Archaeology findings from the old app

Old project behavior:

- Name/package: `linkedin-to-x`.
- Path before rename: `~/Projects/linkedin-to-x`.
- Runtime state: `~/.linkedin-to-x`.
- It scraped LinkedIn recent activity with Playwright and posted to X via API, optionally Facebook Pages.
- It used `.env`, a persistent Playwright profile, OAuth tokens, and `~/.linkedin-to-x/posted.md` as dedupe state.
- Commands included `auth`, `sync`, `list`, and `start`.
- The `start` command/continuous loop was brittle; prior history showed it ran once/exited in at least one flow.
- A duplicate post occurred on 2026-03-24: `https://x.com/i/status/2036422890271215716`.
- That duplicate triggered a debugging pass and later commit `9d37108 Fix deduplication bug causing duplicate cross-posts`.
- The old app had many point fixes: delay increased to 60s, lnkd.in resolution, line break/link extraction, skip reposts, long-post threading, Facebook support, count/snippet-based dedupe.

What to preserve:

- LinkedIn scraping learnings.
- X API/OAuth implementation ideas.
- Dry-run/list/sync command concepts.
- Persistent browser profile approach for sites without official APIs.
- Dedupe/history concept, but not the single global tracker design.
- Existing bug-history as regression tests where possible.

What to replace:

- Hardcoded LinkedIn→X model.
- `.env` as primary UX.
- Single global `posted.md` tracker.
- Snippet-only dedupe as the only identity mechanism.
- Any immediate/live posting default.
- Any framing around “human-like” deception or ban evasion.

## Architecture target

Repost-with-agent should have three layers:

1. **Core library** — pair config, state, audit logs, source/destination adapter interfaces, preview/run orchestration.
2. **CLI** — `repost-with-agent pair ...` commands for non-agent users, scheduled invocations, and local debugging.
3. **Agent-operated setup layer** — workspace templates plus OpenClaw/Claude Code instructions that make agents operate the queue/CLI/core instead of improvising repost logic.

### Proposed repo layout

```text
Repost-with-agent/
  package.json
  openclaw.plugin.json
  .claude-plugin/plugin.json
  README.md
  PLAN.md                       # working checklist kept public in-repo for this rewrite
  docs/
    architecture.md
    setup-flow.md
    safety.md
    migration.md
  examples/
    pairs.example.json
  templates/
    repost_with_agent_workspace/
      user-setup.json
      queue.jsonl
      state.json
      logs/
  scripts/
    init_repost_with_agent_workspace.py
  skills/
    repost-pair-setup/SKILL.md
    repost-run/SKILL.md
  commands/                     # Claude Code slash commands if useful
    pair.md
    preview.md
    run.md
  src/
    index.ts                    # CLI entry
    core/
      pair.ts
      store.ts
      audit-log.ts
      orchestrator.ts
      dedupe.ts
      policy.ts
    adapters/
      source.ts
      destination.ts
      sources/linkedin.ts
      sources/generic-web.ts
      destinations/x.ts
      destinations/generic-web.ts
    agent-facing/
      openclaw.ts
      claude-code.ts
```

## Pair setup UX

Agent flow:

1. “Let’s make a reusable repost pair. What source website/account should I watch?”
2. “Where should the posts go?”
3. “Do you want preview-only, approval-required, or live after preview passes?”
4. Check auth/login via OAuth or browser profile; never ask for passwords in chat.
5. Run a preview and show candidate source items.
6. Save pair name and schedule.
7. Future runs load pair config + logs/history before acting.

Commands/tools:

- `pair create`
- `pair list`
- `pair show <id>`
- `pair test <id>`
- `pair preview <id>`
- `pair run <id> --live` (approval/safety gated)
- `pair pause/resume <id>`
- `pair history <id>`
- `pair schedule <id>`

## Config/state/log design

Runtime state must live outside the public repo. Pair CLI state:

```text
~/.repost-with-agent/
  pairs.json
  pairs/<pair-id>/
    state.json
    audit.jsonl
    findings.jsonl
    drafts.jsonl
    posted.jsonl
    learnings.md
```

Queue workspace shape:

```text
repost_with_agent_workspace/
  user-setup.json        # accounts, browser profile, targets, publish/run policy
  queue.jsonl            # one queued repost item per line
  state.json             # completed/drafted/blocked/failed/skipped/locks
  logs/                  # concise run notes, proof URLs/screenshots when useful
```

Pair fields:

- `id`, `name`, `enabled`
- `source.type`, `source.url/account/feed`, `source.authRef`
- `destination.type`, `destination.account/page/channel`, `destination.authRef`
- `mode`: `preview-only`, `approval-required`, `live-approved`
- `schedule`: cron/every/manual, timezone, jitter
- `policy`: max items/run, min delay, prefer official API, require preview first
- `dedupe`: canonical source URL, source platform id, content hash, destination ids
- `state`: last run/result, health/auth status

## Safety / compliance guardrails

- Build responsible automation, not ban-evasion.
- No stealth, anti-detection, CAPTCHA/2FA bypass, or deceptive fake-human simulation.
- Preview-first by default.
- Prefer official APIs where available.
- Browser automation should be transparent and user-controlled.
- Live posting requires explicit saved approval state.
- Conservative max-items-per-run and delay policies to reduce spam/accidental duplicates.
- Audit every decision: found, skipped, previewed, posted, failed.

## Implementation plan

### Phase 1 — rename + foundation
- [x] Rename package metadata to `repost-with-agent`.
- [x] Rename CLI binary to `repost-with-agent` while preserving legacy alias if useful.
- [x] Add `openclaw.plugin.json`.
- [x] Add `.claude-plugin/plugin.json`.
- [x] Add `skills/repost-pair-setup/SKILL.md` and `skills/repost-run/SKILL.md`.
- [x] Add docs: architecture, setup flow, safety, migration.
- [x] Add examples/pairs.example.json.
- [x] Add queue workspace templates and initializer script.

### Phase 2 — pair core
- [x] Add pair types/schema.
- [x] Add runtime store under `~/.repost-with-agent`.
- [x] Add per-pair audit/history logs.
- [x] Add adapter interfaces.
- [x] Add preview/run orchestration skeleton.
- [x] Add CLI pair commands.

### Phase 3 — migrate LinkedIn→X
- [x] Wrap old LinkedIn scraper as a source adapter.
- [x] Wrap old X client as a destination adapter.
- [x] Move old tracker data to per-pair state or provide migration command.
- [x] Add duplicate-post regression checks based on the 2026-03-24 bug.
- [x] Keep dry-run/list behavior.

### Phase 4 — scheduling/integrations
- [x] Add OpenClaw skill instructions for pair setup/run.
- [x] Add OpenClaw-facing setup/run instructions for the reposting workflow.
- [x] Add Claude Code-facing setup/run commands for the reposting workflow.
- [x] Document OpenClaw cron setup.
- [x] Document Claude Code usage.

### Phase 5 — verify + publish
- [x] Run typecheck/build.
- [x] Review local diff for secrets.
- [x] Commit changes.
- [x] Rename GitHub repo to `Repost-with-agent`.
- [x] Push.
- [x] Update remote URL if GitHub rename changes it.

## Open questions

- Should the public package be lowercase `repost-with-agent` while GitHub repo is `Repost-with-agent`? Recommendation: yes.
- Also treat `repost_with_agent` as the user-facing/product alias when workspace names or natural language prefer underscores.
- For live posting, should first version require manual approval every run, or allow “live-approved” after first preview? Recommendation: default manual approval; support live-approved only explicitly.
- Should Facebook support stay in v1 or move to v2? Recommendation: keep legacy code if it still builds, but document as secondary/experimental and adapter-gated.
- Should the old `~/.linkedin-to-x` state be migrated automatically or only via `repost-with-agent migrate linkedin-to-x`? Recommendation: explicit migration command.

## Public repo note

- `PLAN.md` is intentionally tracked now. `.gitignore` was adjusted so this rewrite checklist stays public with the repo.
