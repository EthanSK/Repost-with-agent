# Repost-with-agent architecture

Repost-with-agent is a portable agent-operated reposting workflow/skill/plugin: saved source→destination pairs, queue workspaces, preview-first runs, and persistent repost history. Agents use the supplied files/CLI/instructions to operate a logged-in browser safely instead of improvising repost logic.

## Scope

- First production-quality pair: LinkedIn profile/activity → X account.
- Generic target: source social/site/feed → destination social/site/channel.
- Operable by OpenClaw and Claude Code, while keeping the cross-posting core independent.
- Queue workspace shape for agent-run projects: `user-setup.json`, `queue.jsonl`, `state.json`, `logs/`.
- Public repo, with private runtime state outside the repo.

Out of scope:

- Any non-reposting app/framework work.
- Stealth automation, ban evasion, anti-detection, CAPTCHA/2FA bypass, deceptive fake-human simulation.

## Layers

### 1. Core library

The core library owns deterministic behavior:

- Pair config schema.
- Runtime store.
- Audit/history logging.
- Source adapter interface.
- Destination adapter interface.
- Dedupe and policy checks.
- Preview/run orchestration.

Agents should call into this layer instead of inventing posting behavior from scratch each run.

### 2. CLI

The CLI is for local use, debugging, and scheduler invocations.

Implemented commands:

```bash
repost-with-agent pair create
repost-with-agent pair list
repost-with-agent pair show <pair-id>
repost-with-agent pair preview <pair-id>
repost-with-agent pair history <pair-id>
repost-with-agent migrate linkedin-to-x
```

Future commands can add `pair test`, `pair run`, pause/resume, and scheduler helpers once live publishing is fully policy-gated.

### 3. Agent-operated setup layer

The agent-facing layer teaches OpenClaw / Claude Code how to use the cross-posting core and CLI:

- how to ask the setup questions;
- when to preview first;
- how to save a pair;
- how to schedule a pair;
- how to inspect logs/history before acting;
- how to avoid unsafe/public actions without approval.

## OpenClaw-operated workflow

Ship lightweight OpenClaw metadata plus skills so OpenClaw can operate the reposting workflow.

Minimum useful OpenClaw v1:

- `openclaw.plugin.json` declares plugin identity, config schema, and skills roots.
- `skills/repost-pair-setup/SKILL.md` handles conversational pair creation.
- `skills/repost-run/SKILL.md` handles preview/run/history/scheduled runs.
- README documents OpenClaw cron commands for scheduled isolated runs.

Possible v1.1:

- Register native OpenClaw tools for pair operations:
  - `repost_pair_create`
  - `repost_pair_list`
  - `repost_pair_preview`
  - `repost_pair_run`
  - `repost_pair_history`
- Register command aliases if the plugin API surface is stable enough.

OpenClaw cron should run isolated jobs that invoke the CLI or plugin tool, load pair history, preview/post according to policy, and announce results.

## Claude Code-operated workflow

Ship a Claude Code-compatible command/skill shape for the same reposting workflow:

```text
.claude-plugin/plugin.json
skills/repost-pair-setup/SKILL.md
skills/repost-run/SKILL.md
commands/pair.md
commands/preview.md
commands/run.md
```

Claude Code users should be able to install/use the repo as a plugin and ask:

- “Create a repost pair.”
- “Preview my LinkedIn to X pair.”
- “Run this pair.”
- “Show history.”

The skills should delegate to the CLI/core instead of manually scraping/posting inside prompts.

## Pair setup UX

A good setup conversation:

1. Agent: “Let’s make a reusable repost pair. What source should I watch?”
2. User gives a website/account/feed.
3. Agent identifies a source adapter or marks it `generic-web` experimental.
4. Agent: “Where should reposts go?”
5. User gives destination website/account/channel.
6. Agent identifies destination adapter.
7. Agent checks auth/login state and explains any required login.
8. Agent runs preview only.
9. User approves saving the pair name/schedule.
10. Future runs load config + history + safety policy before doing anything.

## Runtime state

Runtime state must not live in the public repo.

Pair CLI state defaults to:

```text
~/.repost-with-agent/
  pairs.json
  pairs/<pair-id>/state.json
  pairs/<pair-id>/audit.jsonl
  pairs/<pair-id>/findings.jsonl
  pairs/<pair-id>/drafts.jsonl
  pairs/<pair-id>/posted.jsonl
  pairs/<pair-id>/learnings.md
```

Queue-based agent workspaces are user-owned directories created with:

```bash
python3 scripts/init_repost_with_agent_workspace.py <workspace-dir>
```

```text
repost_with_agent_workspace/
  user-setup.json
  queue.jsonl
  state.json
  logs/
```

`pairs.json` and `user-setup.json` store non-secret config. Auth material should be referenced by `authRef`, browser profile names, platform-native locations, OAuth token stores, or browser profiles.

## Adapter contract

Source adapter:

```ts
interface SourceAdapter {
  type: string;
  test(pair): Promise<AuthHealth>;
  fetchCandidates(pair): Promise<SourceItem[]>;
}
```

Destination adapter:

```ts
interface DestinationAdapter {
  type: string;
  test(pair): Promise<AuthHealth>;
  preview(item, pair): Promise<DraftPost>;
}
```

A future live-publish adapter extension should add `publish(...)` only after manual approval/live policy gates are explicit.

Each `SourceItem` needs stable identity fields:

- canonical source URL
- source platform ID if available
- normalized text/content hash
- timestamp if available
- media/link metadata

## Dedupe policy

Use layered dedupe, not snippet-only:

1. exact source platform ID;
2. canonical source URL;
3. normalized content hash;
4. destination result IDs;
5. optional fuzzy fallback only for preview warnings.

Never silently live-post an uncertain duplicate. If uncertain, preview and ask.

## Scheduler design

- Manual mode by default.
- Queue workspaces use `user-setup.json.run_policy` (`mode`, `schedule`, `timezone`, `max_items_per_run`, `min_interval_minutes`, `approval`).
- OpenClaw cron is first-class for OpenClaw users: schedule a prompt that invokes this skill/workspace or the CLI.
- OS cron/launchd examples can be documented for non-OpenClaw users.
- Scheduled runs should load pair/workspace history and policy.
- Default scheduled live behavior should be conservative: max 1 item/run, preview-first and approval-required until explicitly live-approved.
- Jitter can reduce spammy exact-timestamp behavior, but document it as load/spam-risk reduction — not detection evasion.

## Safety defaults

- `mode: preview-only` for new pairs.
- `requirePreviewBeforeFirstLiveRun: true`.
- `maxItemsPerRun: 1`.
- `preferOfficialApi: true`.
- `blockOnUncertainDuplicate: true`.
- `neverBypass2FAOrCaptcha: true`.
- `auditEveryDecision: true`.

## Migration from old linkedin-to-x

Old runtime:

```text
~/.linkedin-to-x/posted.md
~/.linkedin-to-x/x-tokens.json
~/.linkedin-to-x/*.log
```

Migration command should:

1. create default pair `linkedin-to-x` or `ethan-linkedin-to-x`;
2. preserve old posted IDs/snippets as per-pair posted history;
3. reference existing browser profile and OAuth/token locations without copying secrets into the repo;
4. write an audit entry that migration happened;
5. keep old files untouched unless user asks to archive/delete.
