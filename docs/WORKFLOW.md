# Repost-with-agent — end-to-end workflow

This is the definitive walkthrough of how Repost-with-agent actually runs, from one-time setup to a live `pair post --approve`. It complements [architecture.md](architecture.md) (the layer model) and [setup-flow.md](setup-flow.md) (the conversational pair-creation script). If something here disagrees with the README, the README wins — open an issue or PR.

## Mental model in one sentence

Repost-with-agent saves named **pairs** of `(source → destination, policy, schedule)`. The CLI / agent operates the pair through a logged-in browser profile and OAuth tokens you control. Every preview is read-only. Every publish requires `--approve` plus a non-`preview-only` mode plus a clean dedupe re-check.

## One-time setup (per machine, per user)

1. **Clone and install.**
   ```bash
   git clone https://github.com/EthanSK/Repost-with-agent.git
   cd Repost-with-agent
   ./scripts/install-for-openclaw.sh   # idempotent; works for Claude Code too
   ```
   Verifies Node + npm, runs `npm install`, builds TypeScript, smoke-tests the CLI, creates `~/.repost-with-agent/`.
2. **Persistent browser profile, logged in by a human.** Repost-with-agent never logs the user in itself — no CAPTCHA / 2FA / phone-number bypass. Open the Playwright profile dir and complete LinkedIn + X logins manually:
   ```bash
   npx playwright open --user-data-dir=$PLAYWRIGHT_PROFILE_DIR https://www.linkedin.com/
   # then in the same profile:
   npx playwright open --user-data-dir=$PLAYWRIGHT_PROFILE_DIR https://x.com/
   ```
   Default profile dirs: `~/.claude/playwright-profile/` (Claude Code) or `~/.openclaw/playwright-profile/` (OpenClaw). Override via `PLAYWRIGHT_PROFILE_DIR`.
3. **(Optional) X OAuth 2.0 token.** Required for the `pair post --approve` live publish path on X (the OAuth1 env-var path also works if you prefer).
   ```bash
   npx repost-with-agent auth          # opens browser for X OAuth 2.0 PKCE
   ```
   Tokens land at `~/.repost-with-agent/x-tokens.json`.
4. **(Optional) Host plugin install.**
   - Claude Code: symlink `.claude-plugin/` into `~/.claude/plugins/repost-with-agent` (or use `/plugins`).
   - OpenClaw: `openclaw plugins register $PWD/openclaw.plugin.json`.
5. **(Optional) Agent-bridge.** If you want a remote agent (Claude / OpenClaw / Codex on another machine) to drive this install, the existing `bridge_send_message` channel + `scripts/agent-bridge-handler.sh` is enough — no separate MCP server. The handler is read-only / approval-gated by design (`safe-publish` returns a `needs-approval` JSON stub instead of publishing). See [README.md "Agent-bridge integration"](../README.md#agent-bridge-integration).

## Per-pair setup (once per source→destination relationship)

```bash
npx repost-with-agent pair create \
  --name "LinkedIn to X" \
  --source-type linkedin-profile-activity \
  --source-url "https://www.linkedin.com/in/<you>/recent-activity/all/" \
  --destination-type x-account \
  --destination-account "@<you>"
```

What that does:

- Slugifies the name into a `pair-id` (`linkedin-to-x`).
- Creates `~/.repost-with-agent/pairs.json` (if missing) and appends the new record.
- Creates `~/.repost-with-agent/pairs/<id>/` with empty `audit.jsonl`, `posted.jsonl`, `findings.jsonl`, `drafts.jsonl`, `state.json`, and a starter `learnings.md`.
- Defaults to **`mode: preview-only`** and **`enabled: false`**. Intentional.
- Writes a `pair.created` audit event.

Optional one-time migration if you ran the legacy `linkedin-to-x` tool:

```bash
npx repost-with-agent migrate linkedin-to-x \
  --source-url "https://www.linkedin.com/in/<you>/recent-activity/all/" \
  --destination-account "@<you>"
```

This imports `~/.linkedin-to-x/posted.md` into the new per-pair `posted.jsonl` so old posts don't re-publish. Legacy files stay untouched.

## Per-post workflow (the actual repost loop)

1. **Preview** — read-only. Always run this first.
   ```bash
   npx repost-with-agent pair preview linkedin-to-x
   ```
   Internally `previewPair()` in `src/core/orchestrator.ts`:
   - Calls source adapter `test()` and `fetchCandidates()` in parallel with destination `test()`.
   - Loads `learnings.md` and `posted.jsonl`.
   - Slices candidates to `policy.maxItemsPerRun` (default 1).
   - For each candidate, calls destination `preview()` to draft the post text and `decidePreviewStatus()` to flag `new` / `duplicate` / `uncertain`.
   - Writes a `pair.preview` audit event.
   - Output: auth health, candidate list, drafted post text, dedupe decision, warnings. Posts nothing.
2. **Inspect history if anything looks off.**
   ```bash
   npx repost-with-agent pair history linkedin-to-x
   ```
   Tails the last 10 published items + last 10 audit events.
3. **Flip pair mode when ready to live-publish.** New pairs are `preview-only`. Edit `~/.repost-with-agent/pairs.json` and set `"mode": "approval-required"` (or use a future `pair edit` command). `live-approved` is reserved for trusted operator-driven runs and means the same gate: `--approve` is still required.
4. **Live publish (approval-gated).**
   ```bash
   npx repost-with-agent pair post linkedin-to-x --approve
   ```
   `publishNextForPair()` then:
   - Re-runs preview.
   - Refuses if the top candidate is `duplicate`.
   - Refuses if the top candidate is `uncertain` unless you also pass `--allow-uncertain`.
   - Refuses if `--approve` was not passed (returns `needs-approval`).
   - Refuses if pair mode is `preview-only`.
   - Re-loads `posted.jsonl` right before posting and re-checks dedupe (race-safe).
   - Re-runs destination `test()` and refuses if auth health is not `ok`.
   - Calls destination `publish()`. On success, appends to `posted.jsonl` (`sourceItemId`, `canonicalUrl`, `contentHash`, `destinationId`, `postedAt`, `summary`) and writes `pair.publish.success`.
   - On failure, writes `pair.publish.failed` and exits 2.

## Scheduling (host-driven, optional)

Repost-with-agent does not run a scheduler. Host schedulers (OpenClaw cron, system cron, launchd, …) fire the tick and call a deterministic CLI entry point:

```bash
repost-with-agent pair scheduled-run <pair-id> [--allow-publish] [--json]
```

Wire up the host scheduler with the helpers in [docs/scheduling.md](scheduling.md). Quick path:

```bash
# 1. record the desired cadence on the pair
repost-with-agent pair edit linkedin-to-x \
  --schedule-kind cron \
  --schedule-expression "0 10 * * 1-5" \
  --timezone Europe/London

# 2. render artifacts (launchd plist + crontab line + openclaw cron command)
repost-with-agent pair schedule linkedin-to-x

# 3a. macOS: install + load the launchd plist
repost-with-agent pair schedule linkedin-to-x --apply launchd
launchctl load ~/Library/LaunchAgents/com.repost-with-agent.linkedin-to-x.plist

# 3b. OpenClaw: paste the printed `openclaw cron add ...` command
```

Each tick writes `pair.scheduled.start` and `pair.scheduled.end` audit events with `outcome` / `reason` / `candidateCount` / `durationMs` / `sourceUrl` / `destinationTarget`. Tail them with `tail -f ~/.repost-with-agent/pairs/<pair-id>/audit.jsonl`.

Scheduled ticks default to preview-only. `--allow-publish` is opt-in and requires `pair.mode === "live-approved"`. For `pair post --approve` runs, the recommendation is to keep them human-triggered until you have enough audit-log confidence in the dedupe decisions.

## Cross-machine (agent-bridge)

A Claude / OpenClaw session on machine A can drive Repost-with-agent on machine B over agent-bridge:

```text
bridge_send_message({
  machine: "<paired-machine>",
  target: "claude-code" | "openclaw/<account>",
  message: "/repost preview linkedin-to-x"
})
```

The receiving agent reads `scripts/agent-bridge-handler.sh` and runs the matching verb. Verbs: `list`, `show <id>`, `preview <id>`, `history <id>`, `status`, `safe-publish <id>` (refuses; emits an `needs-approval` JSON stub). **No remote machine can publish on your behalf** — `pair post --approve` is local-operator-only.

## Where the website lives

Source: `site/index.html` + `site/styles.css`.
Deployed: https://ethansk.github.io/Repost-with-agent/ (GitHub Pages, Actions-built from `.github/workflows/pages.yml`).

## File map at a glance

```text
Repost-with-agent/
├─ src/
│  ├─ index.ts                          # CLI entry — `repost-with-agent ...`
│  ├─ config.ts                         # env vars, OAuth token store
│  ├─ core/
│  │  ├─ orchestrator.ts                # previewPair() + publishNextForPair()
│  │  ├─ dedupe.ts                      # decidePreviewStatus() + contentHash()
│  │  ├─ policy.ts                      # DEFAULT_POLICY
│  │  ├─ runtime.ts                     # ~/.repost-with-agent state IO
│  │  └─ types.ts
│  ├─ adapters/
│  │  ├─ source.ts | destination.ts     # adapter interfaces
│  │  ├─ sources/linkedin.ts            # linkedin-profile-activity
│  │  └─ destinations/x.ts              # x-account (test+preview+publish)
│  ├─ linkedin-scraper.ts               # Playwright scrape of /recent-activity/all/
│  ├─ x-client.ts                       # OAuth1 + OAuth2 PKCE post helpers
│  ├─ tracker.ts                        # legacy markdown tracker (read-only for migration)
│  └─ legacy-commands.ts                # deprecated `sync`/`list`/`start` paths
├─ scripts/
│  ├─ install-for-openclaw.sh           # one-shot installer
│  ├─ agent-bridge-handler.sh           # /repost <verb> dispatcher
│  └─ init_repost_with_agent_workspace.py
├─ skills/{repost-pair-setup,repost-run}/SKILL.md
├─ commands/{pair,preview,run}.md
├─ templates/repost_with_agent_workspace/
├─ examples/pairs.example.json
├─ tests/dedupe-regression.js
├─ docs/{architecture,migration,safety,setup-flow,WORKFLOW}.md
├─ site/                                # GitHub Pages site
├─ openclaw.plugin.json
├─ .claude-plugin/plugin.json
└─ package.json
```

## Successful live test post (proof)

2026-05-01 — first end-to-end live publish via `pair post --approve` from the `linkedin-to-x` pair: https://x.com/REEEthan_YT/status/2050303942857310541. The corresponding `posted.jsonl` row + `pair.publish.success` audit entry are in the live `~/.repost-with-agent/pairs/linkedin-to-x/` runtime state. The exercised format is captured by the third assertion block in `tests/dedupe-regression.js` so the dedupe layer can never re-publish that same content.
