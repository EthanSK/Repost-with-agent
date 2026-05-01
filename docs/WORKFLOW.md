# Repost-with-agent — end-to-end workflow

This is the definitive walkthrough of how Repost-with-agent actually runs, from one-time setup to a live `pair post --approve`. It complements [architecture.md](architecture.md) (the layer model) and [setup-flow.md](setup-flow.md) (the conversational pair-creation script). If something here disagrees with the README, the README wins — open an issue or PR.

## Mental model in one sentence

Repost-with-agent saves named **pairs** of `(source → destination, policy, schedule)`. The CLI / agent operates the pair through a logged-in browser profile and OAuth tokens you control. Every preview is read-only. Every publish requires `--approve` plus a non-`preview-only` mode plus a clean dedupe re-check.

## Non-negotiable rule — Telegram-confirm every successful publish

> Every successful post from this tool MUST trigger a Telegram message to Ethan confirming what was posted, the source URL, and the destination URL. The CLI does this automatically via the configured `notify.telegram` channel. If you are an agent operating on this repo and you trigger a publish through any non-CLI path (direct API call, scripted action, etc.) you MUST also fire a Telegram confirmation. Silent publishes are a bug. (Ethan voice 5977 + 5978, 2026-05-01.)

Wire it up once, before the first live run:

```bash
repost-with-agent notify configure --bot-token <TELEGRAM_BOT_TOKEN> --chat-id <CHAT_ID> --test
```

Audit events: `notify.publish.success` (good), `notify.publish.failure` + `pair.publish.notify_failed` (post landed, ping didn't), `pair.publish.notify_skipped_unconfigured` (silent publish — fix immediately).

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
   - **Immediately fires the Telegram-on-publish notifier** via `src/core/notify.ts:notifyPublishSuccess()`. Emits `notify.publish.success` on delivery, `notify.publish.failure` + `pair.publish.notify_failed` on failure, or `pair.publish.notify_skipped_unconfigured` if no notify config is wired up. Notify failures never roll back the publish.
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

## Backfill mode — walk back through history

Per-pair runs (`pair post`, `pair scheduled-run`) only ever consider the latest candidate. To publish a *batch* of historical items the destination is missing, use `pair backfill`:

```bash
# Plan-only (default, safe to run any time):
npx repost-with-agent pair backfill linkedin-to-x \
  --max 20 --pages 2 --interval-minutes 10

# Live publish a batch (requires pair.mode=live-approved):
npx repost-with-agent pair backfill linkedin-to-x \
  --max 20 --pages 2 --interval-minutes 10 --allow-publish
```

Flags:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--max <N>` | `20` | Maximum number of items to publish in this run. |
| `--pages <P>` | `2` | Number of source pages to fetch. |
| `--page-size <N>` | `10` | Hint for source page size (LinkedIn adapter scrolls extra times to surface deeper pages). |
| `--interval-minutes <M>` | `10` | Minutes between successive publishes (eg `--max 20 --interval-minutes 10` ⇒ ~3.5 hours total). |
| `--allow-publish` | off | Permit live publishing. Requires `pair.mode=live-approved`. Without this flag, the backfill always runs as a plan-only dry-run. |
| `--dry-run` | implicit | Force plan-only (default when `--allow-publish` is not passed). |
| `--json` | off | Emit a single JSON object on stdout summarizing the run. |

What backfill does, in order:

1. **Source pagination** — calls `sourceAdapter.fetchPage()` for each page (1..P), de-duplicating items that appear on consecutive pages.
2. **Oldest-first ordering** — re-sorts the combined item set chronologically forward, so the earliest missing posts go up first.
3. **Local dedupe** — drops any item whose `sourceItemId` / `canonicalUrl` / `contentHash` already appears in `posted.jsonl`.
4. **Plan** — caps the remaining items to `--max` and stamps each with a scheduled-at time `--interval-minutes` apart, starting at "now".
5. **Audit-log the plan** — emits `pair.backfill.plan` with the candidate count + plan totals.
6. **For each scheduled item:**
   - Re-check local dedupe (race-safe).
   - **Destination dedupe** — call `destinationAdapter.findExistingPost(draft, pair)`; if the platform already has an equivalent post, skip + record a `posted.jsonl` entry tagged `importedFrom: "backfill-destination-dedupe"` so future runs short-circuit.
   - Wait until the scheduled time.
   - Confirm destination auth health.
   - Publish, persist to `posted.jsonl`, fire the Telegram notify, and update the resume state.
7. **Run summary** — emits `pair.backfill.complete` with `{ considered, published, skippedLocal, skippedDestination, skippedAlreadyInRun, failed, dryRunSkipped }`.

### Idempotency / resume

Backfill writes a small `~/.repost-with-agent/pairs/<id>/backfill-state.json` file recording every publish in the current run. If the process is killed mid-run and restarted with the same flags:

- Items already in `posted.jsonl` are filtered out at plan time.
- Any item ID/URL/contentHash recorded in `backfill-state.json` is skipped with `skip-already-published-in-run`.
- The state file is removed when the run completes successfully with no failures.

### Audit events

Each backfill emits these structured events into `~/.repost-with-agent/pairs/<id>/audit.jsonl`:

| Event | Emitted at |
| --- | --- |
| `pair.backfill.start` | Run start with options snapshot. |
| `pair.backfill.plan` | After source fetch + local dedupe; carries candidate count. |
| `pair.backfill.skip.local` | Item filtered by local dedupe (race-time re-check). |
| `pair.backfill.skip.destination` | Item already on the destination platform. |
| `pair.backfill.skip.already-in-run` | Item skipped because the resume-state already records it. |
| `pair.backfill.wait` | Waiting until the next scheduled-at timestamp. |
| `pair.backfill.publish.start` | Publish call about to begin. |
| `pair.backfill.publish.end` | Publish call finished (success / failure / auth-failure). |
| `pair.backfill.complete` | Run finished with totals + dry-run flag. |
| `pair.backfill.error` | Fatal phase error (eg source fetch threw). |

Tail live ticks with:

```bash
tail -f ~/.repost-with-agent/pairs/linkedin-to-x/audit.jsonl
```

Each line of the tail is one JSON event; pipe through `jq -c` for terminal-friendly viewing.

### Live progress to stdout

Backfill also writes a one-line-per-state-transition stream to stdout, designed for `tail -f`-style monitoring. Sample lines:

```text
[backfill] start pair=linkedin-to-x max=20 pages=2 interval=10m dryRun=false allowPublish=true
[backfill] fetched 18 item(s) across 2 page(s) (page sizes: 10, 8)
[backfill] plan: 17 candidate(s) to publish, 1 skipped by local dedupe, posted history has 4 entries
[backfill]   #1 page=2 scheduledAt=2026-05-02T12:00:00.000Z chars=387 https://www.linkedin.com/feed/update/urn:li:activity:7400000000000000001/
[backfill] #1 wait 0s until 2026-05-02T12:00:00.000Z
[backfill] #1 publish.start https://www.linkedin.com/feed/update/urn:li:activity:7400000000000000001/ chars=387
[backfill] #1 publish.end OK https://x.com/i/status/2050000000000000001
[backfill] #2 wait 600s until 2026-05-02T12:10:00.000Z
[backfill] #2 skip (destination) https://x.com/i/status/2050000000000000050
[backfill] complete published=15 skippedLocal=1 skippedDestination=2 skippedAlready=0 failed=0 duration=8400123ms
```

### Cross-state dedupe (most important new piece)

The destination adapter's `findExistingPost(draft, pair)` does a **fuzzy** match between the *transformed* destination text and the recent destination history. The X adapter:

- Uses the `/2/users/:id/tweets` endpoint (max 100 most recent) via OAuth 2.0.
- Strips the trailing source URL on both sides before comparing (X collapses URLs to t.co aliases that would never match the LinkedIn URL exactly).
- Normalizes by collapsing whitespace, lowercasing, stripping trailing punctuation/`/` on URLs.
- Matches on exact-normalized OR ≥80-character prefix overlap (catches edits that trimmed/extended the post by a few characters).
- Returns `{ exists: false }` (not "skip") on lookup failure, so a transient X API error never blocks a legitimate publish — but the failure is recorded in the audit log.

Adapters that don't implement `findExistingPost` (e.g. future Substack adapter without a `/posts` endpoint) gracefully fall back to local-only dedupe; the `pair.backfill.plan` event records `destinationLookupSupported: false` so you can audit what protection level a given run had.

### Plan output (sample)

```json
{
  "pairId": "linkedin-to-x",
  "pairName": "Legacy LinkedIn to X",
  "generatedAt": "2026-05-02T12:00:00.000Z",
  "options": { "max": 20, "pages": 2, "pageSize": 10, "intervalMinutes": 10, "allowPublish": false },
  "totalConsidered": 18,
  "skippedLocal": 1,
  "postedHistoryCount": 4,
  "destinationLookupSupported": true,
  "candidates": [
    {
      "index": 0,
      "sourceItemId": "https://www.linkedin.com/feed/update/urn:li:activity:7400000000000000001/",
      "canonicalUrl": "https://www.linkedin.com/feed/update/urn:li:activity:7400000000000000001/",
      "page": 2,
      "draftChars": 387,
      "draftPreview": "Long-form post about my latest experiment with agent-driven reposting...",
      "scheduledAt": "2026-05-02T12:00:00.000Z",
      "decisionAtPlan": "publish"
    },
    /* ... 16 more ... */
  ]
}
```

### Sample `pair.backfill.publish.end` audit event

```jsonc
{
  "at": "2026-05-02T12:00:08.342Z",
  "pairId": "linkedin-to-x",
  "event": "pair.backfill.publish.end",
  "details": {
    "index": 0,
    "sourceItemId": "https://www.linkedin.com/feed/update/urn:li:activity:7400000000000000001/",
    "canonicalUrl": "https://www.linkedin.com/feed/update/urn:li:activity:7400000000000000001/",
    "decision": "published",
    "destinationUrl": "https://x.com/i/status/2050000000000000001",
    "destinationId": "2050000000000000001",
    "scheduledAt": "2026-05-02T12:00:00.000Z",
    "startedAt": "2026-05-02T12:00:00.041Z",
    "finishedAt": "2026-05-02T12:00:08.342Z",
    "durationMs": 8301
  }
}
```

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
