# State files (v4.5.3)

All Repost-with-agent state lives at `~/.repost-with-agent/`. Repo files do not
touch this state directly; runtime reposting is skill-only. The running agent
reads / writes state via its native Read / Edit / Write / Bash tools as part of
the skill workflows.

```
~/.repost-with-agent/
├── pairs.json                          # all pair configs (schemaVersion 4)
├── global-posted.jsonl                 # append-only cross-pair destination ledger
├── considered.jsonl                    # append-only custom-rule / not-post-worthy decisions
├── source-fanouts/                     # source-item fanout manifests for scheduled/source backfills
│   └── <source-platform>/
│       └── <safe-source-item-id>.json
├── pairs.json.bak.<unix-ts>            # backups produced by manual migration / pair-edit
├── pairs.json.v3.bak                   # one-time backup of the v3 file
└── pairs/
    └── <pair-id>/
        ├── posted.jsonl                # append-only history (one JSON object per line)
        ├── audit.jsonl                 # append-only audit events
        ├── learnings.md                # free-form notes for the agent
        ├── backfill-state.json         # transient: backfill resume state
        └── logs/
            ├── cron.log                # fallback launchd/crontab logs when that scheduler path is used
            └── notify-errors.log       # Telegram delivery errors (when present)
```

## `pairs.json` (schemaVersion 4)

```json
{
  "schemaVersion": 4,
  "notification": {
    "delivery": {
      "harness": "openclaw | claude-code | other",
      "channel": "telegram | slack | discord | ...",
      "accountId": "<harness account/bot id, optional when the harness has only one>",
      "target": "<chat/user/channel destination id>",
      "threadId": "<optional thread/topic id>"
    },
    "payloadStyle": "short-human",
    "noRawToolOutput": true
  },
  "customRules": [
    {
      "id": "skip-x-ai-slop-machine-videos",
      "enabled": true,
      "action": "skip",
      "scope": {
        "sourcePlatform": "x"
      },
      "match": {
        "anyOf": [
          { "sourceItemIds": ["2051336931150123230"] },
          {
            "semanticSimilarToAny": ["vibe coding an ai slop machine #ai #programming #developer"],
            "mediaTypesAny": ["video", "livestream", "live"],
            "treatUnknownMediaAsMatch": true
          }
        ]
      },
      "reason": "Block X video/livestream promos about vibe-coding an AI slop machine.",
      "examples": []
    }
  ],
  "schedulerJobs": [
    {
      "id": "all-enabled-daily",
      "enabled": true,
      "scope": "all-enabled | pair | subset | source-fanout | custom",
      "pairIds": [],
      "message": "/repost-run all",
      "publishMode": "live-approved-only | preview-only",
      "schedule": {
        "kind": "manual | cron | every",
        "tz": "Europe/London",
        "expression": "0 10 * * *",
        "everyHours": 24,
        "everyMinutes": 1440
      },
      "host": {
        "kind": "openclaw-cron | launchd | crontab | other",
        "jobName": "repost-with-agent.all.daily"
      }
    }
  ],
  "pairs": [
    {
      "id": "linkedin-to-x",
      "name": "LinkedIn to X",
      "enabled": true,
      "mode": "preview-only | approval-required | live-approved",
      "runMode": "listen-for-future | backfill",
      "source": {
        "platform": "<site-key, e.g. linkedin | x | bluesky | threads | facebook | your-site>",
        "url": "https://www.linkedin.com/in/<handle>",
        "profileUrl": "https://www.linkedin.com/in/<handle>"
      },
      "destination": {
        "platform": "<site-key, e.g. linkedin | x | bluesky | threads | facebook | your-site>",
        "accountHint": "@<handle>",
        "accountDisplayName": "<visible account/page name>",
        "targetType": "profile | page | group",
        "profileUrl": "https://x.com/<handle>"
      },
      "schedule": {
        "kind": "manual | cron | every",
        "tz": "Europe/London",
        "expression": "0 10 * * *",
        "everyHours": 24,
        "everyMinutes": 1440
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
      },
      "createdAt": "<ISO-8601>",
      "updatedAt": "<ISO-8601>"
    }
  ]
}
```

### Field invariants

- `notification.delivery` — optional but strongly recommended for scheduled/live runs. It records the user-facing notification route the setup agent captured from the current harness/chat. For OpenClaw this maps directly to `message(action="send", channel=delivery.channel, accountId=delivery.accountId, target=delivery.target, threadId=delivery.threadId?, message=<short payload>)`; other harnesses map the same abstract fields to their own user-message tool. Do not rely on a default account/bot when multiple accounts exist.
- `notification.payloadStyle: "short-human"` and `notification.noRawToolOutput: true` mean publish pings are concise human summaries, never raw JSON/tool/audit dumps.
- `customRules` — optional top-level user preference filters that run after source scrape and before dedupe/publish. Enabled `action: "skip"` rules append to `considered.jsonl` + per-pair audit and must NOT append to `posted.jsonl` / `global-posted.jsonl` because a preference skip is not destination proof. Pair-specific `pair.customRules` may also be used for one-off destination rules. See `skills/repost-custom-rules/SKILL.md`.
- `schedulerJobs` — optional top-level scheduler metadata for humans/agents. It can describe the default all-enabled sweep, separate per-pair jobs, subset jobs, source-item fanout backfill jobs, preview/dry jobs, or custom current-harness scheduled prompts. It is **advisory**: the installed host scheduler entry (OpenClaw cron, launchd, crontab, etc.) remains the operational source of truth for timing. If absent, scheduling still works via `/repost-setup-cron`. Suggested fields:
  - `id` — stable human/job id, e.g. `all-enabled-daily` or `linkedin-to-x-hourly`.
  - `scope` — `all-enabled`, `pair`, `subset`, `source-fanout`, or `custom`.
  - `pairIds` — explicit ids for `pair`/`subset` scopes; empty for `all-enabled` or source fanout auto-enumeration.
  - `sourcePlatform` — optional source key for `source-fanout` jobs, e.g. `linkedin`.
  - `message` — the current-harness prompt/slash command the scheduler runs, e.g. `/repost-run all`, `/repost-run linkedin-to-x`, or a source-fanout prompt.
  - `publishMode` — `live-approved-only` for unattended live jobs, or `preview-only` for dry jobs that must never publish.
  - `schedule` — same shape as pair schedules (`manual`, `cron`, or `every`).
  - `host` — optional installed scheduler hint (`kind`, `jobName`, `jobId`) for later inspection/removal.
- `id` — kebab-case, unique. Default form: `<source-platform>-to-<destination-platform>`.
- `enabled` — `false` for new pairs by default. Schedulers ignore disabled pairs.
- `mode`:
  - `preview-only` — never publishes. Default. Scheduled preview/dry jobs may still inspect and draft.
  - `approval-required` — agent asks user per-post before publishing; unattended schedulers treat it as preview-only.
  - `live-approved` — agent publishes without per-post prompting. Required for unattended scheduled live ticks.
- `runMode`:
  - `listen-for-future` — tail new posts on a schedule. Default.
  - `backfill` — historical walk (newest-first). Source-level scheduled backfill jobs use a source-item fanout manifest; destination-specific pair backfills use `pairs/<id>/backfill-state.json`.
- `policy.overlengthStrategy`:
  - `skip` — when the live destination composer UI explicitly indicates overlength/cutoff, skip instead of publishing. This is the Ethan/OpenClaw default and the only safe default.
- `policy.textFidelity: "exact-source-body-only"` and `policy.forbidSemanticRewrites: true` mean public destination text must preserve the original source wording exactly. The agent may only remove source-platform UI artifacts outside the real post body and replace forbidden source-platform wrapper links with verified non-source targets. It must not summarize, compact, paraphrase, improve, sanitize, normalize tone, fix grammar, truncate, or otherwise reword Ethan's post. If exact text will not fit, skip/block and notify Ethan.
- `policy.blockOnUncertainDuplicate` — when `true` (default), uncertain dedupe results are treated as "do not publish".
- `policy.globalDedupeEnabled` — when `true` (default), every publish-capable
  path reads `global-posted.jsonl`, resolves a cross-pair `contentKey`, and
  skips if the same content has already reached this destination platform/account
  from any pair. Use this to prevent alternate routes like LinkedIn→X→Bluesky
  and direct X→Bluesky from double-posting the same item.
- `destination.targetType` — optional identity type for destinations where a
  login can publish as multiple identities. Defaults to `profile`; use `page`
  for Facebook pages and `group` for Facebook groups.
- `destination.accountDisplayName` — optional visible account/page name. The
  run skill uses it, alongside `accountHint`, to verify or switch the active
  posting identity before composing.
- `policy.semanticDedupeEnabled` — when `true` (default), Layer 2 semantic
  dedupe runs after Layer 1 fuzzy-string match clears a candidate. When
  `false`, only Layer 1 runs and the candidate publishes immediately on
  Layer 1 clear. See `skills/repost-dedup-semantic/SKILL.md` for the
  reasoning algorithm.
- `policy.semanticDedupeWindowSize` — positive integer (default `30`).
  How many recent destination posts the Layer 2 semantic check compares
  the candidate against. Reuses the destination scrape Layer 1 already
  produced. Tune up for high-volume destinations (X power-users) and
  down for low-volume destinations (Substack-style); 30 is a sweet spot
  for most accounts.
- `schedule` — advisory per-pair schedule intent. `kind: "manual"` means no automatic pair-specific job should be installed unless another custom job explicitly includes the pair. `kind: "cron"` uses `expression`; `kind: "every"` uses `everyHours` or `everyMinutes`. Defaults to daily (`everyHours: 24`) for listen-for-future pairs. The default all-enabled sweep may ignore per-pair cadence in favor of its own global schedule; custom per-pair jobs should honor the pair schedule. Source-level backfill schedules should be represented as top-level `schedulerJobs` with `scope: "source-fanout"`. The host scheduler is the source of truth for actual timing.

### Migration from v3

The v3 schema had `schemaVersion: 3` plus these v3-specific fields that v4
doesn't use anymore:

- `policy.requirePreviewBeforeFirstLiveRun` — v4 enforces this naturally via the safety modes.
- `policy.preferOfficialApi` — v4 has no API path. Field is ignored if present.
- `dedupe.strategy` — v4 hardcodes the algorithm in the `repost-dedup` skill. Field is ignored if present.
- `source.authRef`, `destination.authRef` — v4 uses the current harness browser profile, no auth refs.
- `source.type`, `destination.type` — replaced by `source.platform` / `destination.platform`.

The migration is a one-shot transformation: change `schemaVersion` from 3 to 4,
ensure `runMode` exists (default `"listen-for-future"`), add `schedule.everyHours`
if missing (default 24), optionally add `schedulerJobs: []`, and drop the deprecated fields. The original v3 file is
backed up to `~/.repost-with-agent/pairs.json.v3.bak`.

## `global-posted.jsonl`

Append-only NDJSON. Each line is one global proof/catch-up record shared by all
pairs. It complements each pair's local `posted.jsonl`; it does not replace it.
The global ledger is what lets every pair check whether another pair already
posted the same underlying content to this destination.

Schema:

```json
{
  "ts": "<ISO-8601>",
  "event": "global.publish.success | global.publish.catchup | global.publish.semantic_duplicate | global.publish.remote_duplicate | global.publish.malformed | global.publish.deleted",
  "pairId": "<pair-id>",
  "contentKey": "<sourcePlatform:sourceItemId or canonical URL key>",
  "sourcePlatform": "<platform>",
  "sourceItemId": "<platform-specific source id>",
  "canonicalSourceUrl": "<source post URL>",
  "destinationPlatform": "<platform>",
  "destinationAccountHint": "<configured destination account/page hint>",
  "destinationUrl": "<published/matched destination post URL>",
  "destinationId": "<destination platform id>",
  "draftText": "<text posted or matched>",
  "status": "posted | caught-up | skipped-duplicate | posted-malformed | deleted-malformed | deleted-runaway | deleted-source-url-leak",
  "note": "<optional>"
}
```

Invariants:

- Append-only. NEVER rewrite existing lines.
- `contentKey` is the cross-pair identity for the underlying content.
- If a candidate source URL/ID matches a previous line's destination URL/ID, the
  candidate inherits that previous line's `contentKey`. This preserves lineage
  across hops such as LinkedIn→X→Bluesky.
- The same `contentKey` may have one live-success row per destination
  platform/account. A second **live-success** row for the same destination is a
  duplicate and should be skipped.
- Dedupe must evaluate the latest same-destination verdict, not mere row
  existence. `global.publish.deleted`, `deleted-*`, `global.publish.malformed`,
  `posted-malformed`, `needsRepost`, and `needsRemediation` rows remove or
  quarantine stale proof and do not count as live duplicate proof.

## `considered.jsonl`

Append-only NDJSON. Each line records a candidate the agent considered and
rejected for a user-configured custom-rule reason. It is global state because
custom rules often apply to a source item regardless of destination. It does
not replace per-pair audit, and it must not be treated as proof that the item
exists on any destination.

Schema:

```json
{
  "ts": "<ISO-8601>",
  "event": "candidate.custom_rule.skipped",
  "ruleId": "<customRules[].id>",
  "pairId": "<optional pair id when destination-specific>",
  "sourcePlatform": "x",
  "sourceItemId": "<source platform item id>",
  "canonicalSourceUrl": "<source post URL>",
  "destinationPlatform": "<optional destination platform>",
  "destinationAccountHint": "<optional destination account hint>",
  "candidateExcerpt": "<first 200 chars of candidate text>",
  "mediaTypes": ["video"],
  "status": "skipped-rule",
  "reason": "<human reason from the rule>",
  "note": "<optional migration/context note>"
}
```

Invariants:

- Append-only. NEVER rewrite existing lines.
- Read before dedupe; if a candidate is already present with
  `status: "skipped-rule"`, drop it from the publish set before URL expansion
  or compose.
- Do NOT append to `posted.jsonl` or `global-posted.jsonl` for a pure
  custom-rule skip. Those files mean publish/duplicate proof; this file means
  user preference / not-post-worthy.
- Pair runs that newly skip a candidate should also append
  `pair.custom_rule.skipped` to that pair's `audit.jsonl` for traceability.

## `source-fanouts/<source-platform>/<safe-source-item-id>.json`

Source-item fanout manifests make source-level backfill slots resumable and
prevent an agent from treating one destination success as whole-source-item
completion.

Schema:

```json
{
  "schemaVersion": 1,
  "createdAt": "<ISO-8601>",
  "updatedAt": "<ISO-8601>",
  "status": "in-progress | complete | soft-failed | blocked | partial",
  "runKind": "scheduled-backfill-source-fanout | manual-source-fanout | dry-run-source-fanout",
  "source": {
    "platform": "linkedin",
    "sourceItemId": "urn:li:activity:7000",
    "canonicalSourceUrl": "https://www.linkedin.com/feed/update/urn:li:activity:7000/",
    "publishedAt": "<ISO-8601>",
    "textHash": "sha256:<normalized-source-text-hash>",
    "excerpt": "<first 200 chars>"
  },
  "destinations": [
    {
      "pairId": "linkedin-to-x",
      "destinationPlatform": "x",
      "destinationAccountHint": "@<handle>",
      "status": "planned | attempting | posted | already-posted | caught-up | skipped-rule | skipped-by-policy | blocked | failed | soft-failed | unattempted | needs-repost | deleted-malformed | deleted-runaway",
      "terminal": false,
      "destinationUrl": "<published-or-matched URL when known>",
      "destinationId": "<platform id when known>",
      "category": "needs-login | needs-config | needs-account-switch | rate-limit | platform-error | unknown",
      "reason": "<human reason>",
      "nextAction": "<resume/user/platform action>",
      "failureType": "browser-timeout | selector-missing | rate-limit | platform-5xx | tool-error | live-proof-timeout | needs-login | needs-config | public-side-effect-uncertain | unknown",
      "rootCause": "<best concise root cause when status is failed/soft-failed/blocked>",
      "failureFingerprint": "<pairId>:<failureType>:<rootCause-slug>",
      "consecutiveFailureCount": 1,
      "failureThreshold": 3,
      "safeToContinue": true,
      "proof": {
        "localPosted": true,
        "globalPosted": true,
        "notified": true
      }
    }
  ],
  "resume": {
    "sourceItemId": "urn:li:activity:7000",
    "canonicalSourceUrl": "https://www.linkedin.com/feed/update/urn:li:activity:7000/",
    "pendingPairIds": ["linkedin-to-facebook"],
    "blockedPairIds": [],
    "nextAction": "Resume this same source item before selecting another source item."
  }
}
```

Invariants:

- One manifest records one source item and every enabled destination pair in
  scope at fanout start.
- `complete` is allowed only when every enabled destination has terminal status
  and none is blocked.
- `blocked` is allowed only when every enabled destination is terminal and at
  least one destination is explicitly blocked with `category`, `reason`, and
  `nextAction`.
- `soft-failed` is allowed only when every non-terminal destination is safe to
  defer, has `status: "soft-failed"`, includes `failureType`, `rootCause`,
  `failureFingerprint`, `consecutiveFailureCount`, `failureThreshold`, and
  `safeToContinue: true`, and the same-fingerprint count is still below
  threshold. The queue may advance, but the source item is not complete.
- `partial` is required when any enabled destination is `planned`, `attempting`,
  `failed`, `unattempted`, `needs-repost`, `deleted-malformed`,
  `deleted-runaway`, missing from the manifest, or `blocked` without a complete
  reason/nextAction.
- A scheduled backfill continuation must resume a `partial`, `blocked`,
  `in-progress`, `needs-repost`, deleted, or malformed earlier manifest before
  selecting a different source item, unless that earlier item was explicitly
  skipped/cancelled with proof. It may advance past `soft-failed` only while the
  failure streak is below threshold and `safeToContinue` remains true.
- Successful destination publishes still append to the pair's `posted.jsonl`,
  `audit.jsonl`, and `global-posted.jsonl`; the fanout manifest is an
  orchestration/result ledger, not a replacement for publish proof.
- If a platform creates a public post but the mandatory live-text proof gate
  fails, the destination is blocked with `category: "live-text-mismatch"` and
  quarantine proof is appended as `posted-malformed` / `global.publish.malformed`
  only to prevent accidental duplicate reposts. It is not success proof.

See `skills/repost-source-fanout/SKILL.md` and `docs/source-fanout.md`.

## `pairs/<id>/posted.jsonl`

Append-only NDJSON. Each line is one JSON object representing one successful
publish, plus rare `posted-malformed` quarantine rows for public posts that were
created by the platform but failed the mandatory live-text proof gate. Quarantine
rows prevent accidental duplicate reposts; they are not success proof. Schema:

```json
{
  "ts": "<ISO-8601>",
  "sourceItemId": "<platform-specific id>",
  "canonicalSourceUrl": "<full URL of the source post>",
  "destinationUrl": "<full URL of the published destination post>",
  "destinationId": "<platform-specific id>",
  "draftText": "<the exact text observed live or matched>",
  "intendedDraftText": "<optional; required for posted-malformed rows>",
  "status": "<optional; posted-malformed for quarantine rows>",
  "needsRemediation": "<optional boolean>",
  "note": "<optional, e.g. 'caught-up via destination dedupe'>"
}
```

Invariants:

- Append-only. NEVER rewrite an existing line.
- Order is the order of successful publishes plus quarantine rows.
- Rows with `status: "posted-malformed"`, `needsRemediation`, `needsRepost`,
  `deleted-malformed`, `deleted-runaway`, or any `deleted-*` status block stale
  success proof but must not be reported as successful destination proof; they
  require repair/repost or an explicit skip/accept decision.
- `sourceItemId` is the dedupe grouping key. A candidate is a local duplicate
  only when the newest row for that source item is live-success proof; row
  existence alone is not duplicate proof.
- The file is human-tail-able (`tail -10`) without breaking the agent's reads.

## `pairs/<id>/audit.jsonl`

Append-only NDJSON. Each line is one audit event. Schema:

```json
{
  "ts": "<ISO-8601>",
  "event": "<event-name>",
  "pairId": "<id>",
  "...event-specific fields...": "..."
}
```

### Event names

| Event                                   | Meaning |
| --------------------------------------- | ------- |
| `pair.run.start`                        | Manual or scheduled tick begins. |
| `pair.run.end`                          | Tick ended. Includes `outcome: "published" \| "no_new_items" \| "skipped" \| "error"`. |
| `pair.fetch.start`                      | Browser automation started scraping the source. |
| `pair.fetch.success`                    | Source scraped successfully. Includes `candidateCount`. |
| `pair.fetch.failed`                     | Source scrape failed. Includes `category` (`needs-login` etc.) + `error`. |
| `pair.dedupe.local`                     | Local dedupe completed. Includes `duplicates`, `survivors`. |
| `pair.dedupe.remote`                    | Destination scrape + fuzzy-match completed. Includes `duplicates`, `survivors`. |
| `pair.dedupe.global_duplicate`          | Global ledger found the same `contentKey` already posted/caught-up for this destination by any pair. |
| `pair.dedupe.uncertain`                 | Destination scrape failed; candidates left undecided. Includes reason. |
| `pair.dedupe.semantic_clean`            | (Optional) Layer 2 semantic dedupe ran and cleared the candidate. Includes `candidateExcerpt`, `windowSize`, `candidatesCompared`. |
| `pair.custom_rule.skipped`              | Candidate matched a user custom skip rule before dedupe/publish. Includes `ruleId`, `sourceItemId`, `canonicalSourceUrl`, `candidateExcerpt`, `mediaTypes`, and `reason`. Also append a matching `candidate.custom_rule.skipped` line to `considered.jsonl` unless already present. |
| `pair.preview.success`                  | Preview/draft was prepared without publishing. Includes `sourceItemId`, `canonicalSourceUrl`, `draftChars`, and `wouldPublish`. Scheduler setup may use this as proof a dry run worked before enabling live ticks. |
| `pair.publish.semantic_duplicate`       | **Layer 2 semantic dedupe match — candidate skipped pre-publish.** Includes `pairId`, `sourceItemId`, `candidateExcerpt` (first 200 chars), `matchedExistingUrl`, `matchedExistingExcerpt` (first 200 chars), `agentReasoning` (1-3 sentence justification), `windowSize` (number of destination posts compared). See `skills/repost-dedup-semantic/SKILL.md`. |
| `pair.publish.start`                    | About to drive the destination compose flow. |
| `pair.publish.url_expanded`             | One shortened URL was expanded. Includes `from`, `to`. |
| `pair.publish.url_expand_failed`        | One URL expansion failed. Includes `url`, `error`. |
| `pair.publish.compacted`                | Deprecated/for historical rows only. Current policy forbids compacting or rewording public post text. |
| `pair.publish.truncated`                | Deprecated/for historical rows only. Current policy forbids truncating public post text. |
| `pair.publish.skipped_overlength`       | Exact draft exceeded destination length/cutoff limits, so the destination was skipped/blocked instead of reworded. |
| `pair.publish.success`                  | Destination confirmed the post and the live-post text proof gate matched the intended draft. Includes `sourceItemId`, `destinationUrl`. |
| `pair.publish.live_text_mismatch`       | Platform created a public post, but the live destination text did not match the intended draft after allowed normalization. Append `posted-malformed` quarantine proof, block the destination with `category: "live-text-mismatch"`, and do not emit success. |
| `pair.publish.failed`                   | Compose flow failed. Includes `category`, `error`. Categories include `needs-login`, `needs-config`, `needs-account-switch`, `rate-limit`, `platform-error`, and `unknown`. |
| `pair.publish.notify.success`           | Telegram-confirm delivered. |
| `pair.publish.notify.failure`           | Telegram-confirm failed. Includes error. **The post itself stayed up.** |
| `pair.publish.notify_skipped_unconfigured` | User-message delivery not configured/loaded. **Treat as a silent-publish alert.** |
| `pair.run.no_new_items`                 | Run completed; nothing new to publish. |
| `pair.backfill.would_publish`           | Dry-run hit on a candidate. |
| `pair.backfill.published`               | Backfill loop publish succeeded. |
| `pair.backfill.skipped_now_duplicate`   | Re-check between publishes found the candidate had been posted by another path. |
| `source.fanout.start`                   | Source-item fanout began. Includes `sourcePlatform`, `sourceItemId`, `canonicalSourceUrl`, and the complete enabled `destinationPairIds` list. |
| `source.fanout.destination`             | One enabled destination reached a manifest status (`posted`, `already-posted`, `caught-up`, `skipped-rule`, `skipped-by-policy`, `blocked`, `failed`, `soft-failed`, `unattempted`). |
| `source.fanout.destination.soft_failed` | A destination failure was classified as safe to defer under the failure-streak threshold. Includes `failureType`, `rootCause`, `failureFingerprint`, `consecutiveFailureCount`, `failureThreshold`, and `safeToContinue`. |
| `source.fanout.failure_streak.blocked`  | The same failure fingerprint reached the threshold, so the source-level queue must stop until fixed/skipped. |
| `source.fanout.complete`                | Every enabled destination for the source item reached terminal non-blocked status. |
| `source.fanout.blocked`                 | Every enabled destination is terminal, but one or more destinations are explicitly blocked with reason/nextAction. |
| `source.fanout.soft_failed`             | The source item has deferred safe failures under threshold; the queue may continue but repair data remains. |
| `source.fanout.partial`                 | At least one enabled destination is missing, unattempted, failed, planned, or blocked without a complete next action. Includes resume data. |

### `source.fanout.partial` schema

```json
{
  "ts": "<ISO-8601>",
  "event": "source.fanout.partial",
  "sourcePlatform": "linkedin",
  "sourceItemId": "urn:li:activity:7000",
  "canonicalSourceUrl": "https://www.linkedin.com/feed/update/urn:li:activity:7000/",
  "destinationPairIds": ["linkedin-to-x", "linkedin-to-bluesky", "linkedin-to-threads", "linkedin-to-facebook"],
  "terminalPairIds": ["linkedin-to-x", "linkedin-to-bluesky", "linkedin-to-threads"],
  "pendingPairIds": ["linkedin-to-facebook"],
  "blockedPairIds": [],
  "manifestPath": "~/.repost-with-agent/source-fanouts/linkedin/urn-li-activity-7000.json",
  "nextAction": "Resume linkedin-to-facebook for this same source item before selecting another LinkedIn item."
}
```

### `pair.dedupe.global_duplicate` schema

```json
{
  "ts": "<ISO-8601>",
  "event": "pair.dedupe.global_duplicate",
  "pairId": "<id>",
  "sourceItemId": "<candidate source id>",
  "canonicalSourceUrl": "<candidate source URL>",
  "contentKey": "<resolved global content key>",
  "matchedPairId": "<pair that already handled it>",
  "matchedDestinationPlatform": "<destination platform>",
  "matchedDestinationUrl": "<existing destination URL>",
  "reason": "same contentKey already posted/caught-up for this destination"
}
```

### `pair.custom_rule.skipped` schema

Custom rule matched before dedupe/publish. The candidate is not published, and
this event is paired with a `candidate.custom_rule.skipped` line in
`considered.jsonl` unless that considered record already existed.

```json
{
  "ts": "<ISO-8601>",
  "event": "pair.custom_rule.skipped",
  "pairId": "<id>",
  "ruleId": "skip-x-ai-slop-machine-videos",
  "sourceItemId": "<candidate source id>",
  "canonicalSourceUrl": "<candidate source URL>",
  "candidateExcerpt": "<first 200 chars>",
  "mediaTypes": ["video"],
  "reason": "<human reason from the rule>",
  "wouldPublishWithoutRule": false
}
```

A pure custom-rule skip is user preference state, not destination proof: do not
append to `posted.jsonl` or `global-posted.jsonl`.

### `pair.preview.success` schema

Preview/draft prepared without publishing. Useful as the pre-flight proof that
source scrape, dedupe, URL expansion, and length checks worked before a pair is
armed for scheduled live ticks.

```json
{
  "ts": "<ISO-8601>",
  "event": "pair.preview.success",
  "pairId": "<id>",
  "sourceItemId": "<candidate source id>",
  "canonicalSourceUrl": "<candidate source URL>",
  "draftChars": 153,
  "wouldPublish": true
}
```

### `pair.publish.semantic_duplicate` schema

Layer 2 (semantic) dedupe match — candidate skipped pre-publish. Full
field shape:

```json
{
  "ts": "<ISO-8601>",
  "event": "pair.publish.semantic_duplicate",
  "pairId": "<id>",
  "sourceItemId": "<candidate sourceItemId>",
  "candidateExcerpt": "<first 200 chars of candidate draft>",
  "matchedExistingUrl": "<destination URL of the matched existing post>",
  "matchedExistingExcerpt": "<first 200 chars of the matched existing post>",
  "agentReasoning": "<1-3 sentence justification — why these are the same communicative content>",
  "windowSize": 30
}
```

Emitted by `skills/repost-dedup-semantic/SKILL.md` when the agent decides a
candidate is a paraphrased duplicate of an existing destination post. The
candidate is NOT published, and a catch-up entry is appended to
`posted.jsonl` so the same candidate isn't re-evaluated next tick.

## `pairs/<id>/learnings.md`

Per-pair institutional-memory file. Free-form Markdown that the running
agent reads at the start of every run + appends to at the end of every run.
The point: the agent doesn't have to re-figure platform quirks from scratch
on each scheduled tick — quirks accumulate here over time. (Ethan voice 6029,
2026-05-01.)

### Format

Each entry is free-form prose followed by **three OPTIONAL structured
sub-sections** — `### Selectors`, `### Step playbook`, and `### Quirks`.
The structured sections turn the file into an actionable cache the next
run can grep + skim, instead of forcing it to re-read prose paragraphs.

```markdown
# <pair-id> learnings

## YYYY-MM-DD HH:MM — <one-line summary>

<2–5 sentences of prose: what you saw, why it matters, implication.>

### Selectors          (optional — STRONGLY preferred when applicable)
- <label>: `<selector>` (<platform>, <where in flow>)

### Step playbook     (optional — STRONGLY preferred when applicable)
1. <imperative step using the selectors above>
2. ...

### Quirks            (optional)
- <one-line edge case / "skip if X" / timing note>

## YYYY-MM-DD HH:MM — <next entry>

<body — same shape>

## YYYY-MM-DD HH:MM — <obsoleted entry> [obsoleted YYYY-MM-DD]

<original body — left intact, never deleted>
```

- Top-of-file H1: `# <pair-id> learnings`.
- Each entry is an `##` heading with timestamp + summary, followed by 2-5
  sentences of prose context.
- The three `###` sub-sections (`Selectors`, `Step playbook`, `Quirks`)
  are OPTIONAL. Omit any with no content rather than writing them empty.
  Strongly preferred whenever the entry captures actionable mechanics —
  they let future runs follow a recipe instead of re-discovering it.
- Append-only via `>>` in Bash. The only allowed edit to a historical entry
  is a targeted `Edit` that adds ` [obsoleted YYYY-MM-DD]` to the heading
  when a fresh observation contradicts it.
- See `templates/learnings.md.template` for the placeholder stub used on
  first run.

### Read-priority for runs

When `repost-run` / `repost-backfill` reads this file at the start of a
run, it should:

1. Try the most-recent entry's `### Selectors` + `### Step playbook`
   verbatim FIRST (those are a recipe a prior run already verified).
2. Apply the entry's `### Quirks` block as guards / "skip if" rules.
3. Fall back to `docs/destinations/<platform>.md` defaults only when
   learnings.md is silent on a step, or when a cached selector fails
   to match the live DOM (record the new selector at end of run).

### Lifecycle

1. **Start of every run** (`repost-run`, `repost-backfill`, the scheduler-spawned
   subagent): read the file, treat as up-front context.
2. **During execution**: track quirks in reasoning, don't append mid-run.
3. **End of run**: append any newly-discovered quirks with a timestamped
   `##` heading.
4. **Stale-learning pruning**: contradictions are appended (not edited);
   older entries get an `[obsoleted YYYY-MM-DD]` suffix on their heading.

### Surfaced by

- `repost-pair-show` — last 5 entries under "Recent learnings".
- `repost-history` — last 3 entries when `--with-learnings` is passed.
- Full skill spec: `skills/repost-learnings/SKILL.md`.

## `pairs/<id>/backfill-state.json`

Transient resume file. Created at the start of a backfill run, deleted on
clean completion. Schema:

```json
{
  "startedAt": "<ISO-8601>",
  "max": 10,
  "intervalMinutes": 60,
  "completedSourceItemIds": ["urn:li:activity:7000", "..."],
  "skippedSourceItemIds": ["urn:li:activity:6999"]
}
```

## File-mode invariants

- `pairs.json` mode: `0644` (default umask). Contains no secrets — Telegram
  bot tokens etc. live in the current harness's message-delivery config,
  not in this plugin.
- `global-posted.jsonl` mode: `0644`.
- `considered.jsonl` mode: `0644`.
- `posted.jsonl` mode: `0644`.
- `audit.jsonl` mode: `0644`.
- `learnings.md` mode: `0644`.

## See also

- `templates/pairs.json.template` — example v4 pair config.
- `templates/posted.jsonl.template` — example posted history shape.
- `templates/global-posted.jsonl.template` — example global ledger proof shape.
- `templates/considered.jsonl.template` — example custom-rule skip state.
- `templates/source-fanout-manifest.json.template` — example source-item fanout manifest.
- `skills/repost-global-dedupe/SKILL.md` — global ledger algorithm and schema.
- `skills/repost-custom-rules/SKILL.md` — custom user rules + considered state.
- `skills/repost-source-fanout/SKILL.md` — source-item fanout procedure and status rules.
- `templates/audit.jsonl.template` — example audit event sequence.
- `templates/learnings.md.template` — placeholder shape for new pairs.
- `skills/repost-learnings/SKILL.md` — full spec for the learnings.md
  lifecycle + signal-vs-noise rules.
- `docs/source-fanout.md` — operator-facing source-item fanout contract.
- `docs/architecture.md` — why this state shape, why no daemon.
- `docs/migration-v3-to-v4.md` — how the v3 → v4 schema migration works.
