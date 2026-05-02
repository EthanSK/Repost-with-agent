# State files (v4.0.0)

All Repost-with-agent state lives at `~/.repost-with-agent/`. The plugin
ships ZERO code that touches these files at install time — the running agent
reads / writes them via its native Read / Edit / Write tools as part of the
skill workflows.

```
~/.repost-with-agent/
├── pairs.json                          # all pair configs (schemaVersion 4)
├── pairs.json.bak.<unix-ts>            # backups produced by install.sh / pair-edit
├── pairs.json.v3.bak                   # one-time backup of the v3 file
└── pairs/
    └── <pair-id>/
        ├── posted.jsonl                # append-only history (one JSON object per line)
        ├── audit.jsonl                 # append-only audit events
        ├── learnings.md                # free-form notes for the agent
        ├── backfill-state.json         # transient: backfill resume state
        └── logs/
            ├── cron.log                # stdout+stderr from the launchd / cron tick
            └── notify-errors.log       # Telegram delivery errors (when present)
```

## `pairs.json` (schemaVersion 4)

```json
{
  "schemaVersion": 4,
  "pairs": [
    {
      "id": "linkedin-to-x",
      "name": "LinkedIn to X",
      "enabled": true,
      "mode": "preview-only | approval-required | live-approved",
      "runMode": "listen-for-future | backfill",
      "source": {
        "platform": "linkedin | x | bluesky | threads | facebook",
        "url": "https://www.linkedin.com/in/<handle>",
        "profileUrl": "https://www.linkedin.com/in/<handle>"
      },
      "destination": {
        "platform": "linkedin | x | bluesky | threads | facebook",
        "accountHint": "@<handle>",
        "profileUrl": "https://x.com/<handle>"
      },
      "schedule": {
        "kind": "manual | cron",
        "tz": "Europe/London",
        "expression": "0 */5 * * *",
        "everyHours": 5
      },
      "policy": {
        "maxItemsPerRun": 1,
        "minDelayBetweenPostsMinutes": 60,
        "blockOnUncertainDuplicate": true,
        "overlengthStrategy": "skip | truncate",
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

- `id` — kebab-case, unique. Default form: `<source-platform>-to-<destination-platform>`.
- `enabled` — `false` for new pairs by default. Cron / launchd ignores disabled pairs.
- `mode`:
  - `preview-only` — never publishes. Default.
  - `approval-required` — agent asks user per-post before publishing.
  - `live-approved` — agent publishes without per-post prompting. Required for cron-driven ticks.
- `runMode`:
  - `listen-for-future` — tail new posts on a schedule. Default.
  - `backfill` — one-shot historical walk (newest-first).
- `policy.overlengthStrategy`:
  - `skip` — drafts exceeding destination char cap are skipped. Default.
  - `truncate` — drafts are shrunk to `(cap − 24)` chars + `… <source URL>` suffix.
- `policy.blockOnUncertainDuplicate` — when `true` (default), uncertain dedupe results are treated as "do not publish".
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
- `schedule.everyHours` — positive integer; used by `repost-listen-for-future-setup` to compute the launchd `StartInterval` in seconds.

### Migration from v3

The v3 schema had `schemaVersion: 3` plus these v3-specific fields that v4
doesn't use anymore:

- `policy.requirePreviewBeforeFirstLiveRun` — v4 enforces this naturally via the safety modes.
- `policy.preferOfficialApi` — v4 has no API path. Field is ignored if present.
- `dedupe.strategy` — v4 hardcodes the algorithm in the `repost-dedup` skill. Field is ignored if present.
- `source.authRef`, `destination.authRef` — v4 uses the browser MCP profile, no auth refs.
- `source.type`, `destination.type` — replaced by `source.platform` / `destination.platform`.

The migration is a one-shot transformation: change `schemaVersion` from 3 to 4,
ensure `runMode` exists (default `"listen-for-future"`), add `schedule.everyHours`
if missing (default 5), drop the deprecated fields. The original v3 file is
backed up to `~/.repost-with-agent/pairs.json.v3.bak`.

## `pairs/<id>/posted.jsonl`

Append-only NDJSON. Each line is one JSON object representing one successful
publish. Schema:

```json
{
  "ts": "<ISO-8601>",
  "sourceItemId": "<platform-specific id>",
  "canonicalSourceUrl": "<full URL of the source post>",
  "destinationUrl": "<full URL of the published destination post>",
  "destinationId": "<platform-specific id>",
  "draftText": "<the exact text we published>",
  "note": "<optional, e.g. 'caught-up via destination dedupe'>"
}
```

Invariants:

- Append-only. NEVER rewrite an existing line.
- Order is the order of successful publishes.
- `sourceItemId` is the dedupe key — if a candidate's `sourceItemId` already
  appears in any line, it's a local duplicate.
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
| `pair.run.start`                        | Manual or cron tick begins. |
| `pair.run.end`                          | Tick ended. Includes `outcome: "published" \| "no_new_items" \| "skipped" \| "error"`. |
| `pair.fetch.start`                      | Browser MCP started scraping the source. |
| `pair.fetch.success`                    | Source scraped successfully. Includes `candidateCount`. |
| `pair.fetch.failed`                     | Source scrape failed. Includes `category` (`needs-login` etc.) + `error`. |
| `pair.dedupe.local`                     | Local dedupe completed. Includes `duplicates`, `survivors`. |
| `pair.dedupe.remote`                    | Destination scrape + fuzzy-match completed. Includes `duplicates`, `survivors`. |
| `pair.dedupe.uncertain`                 | Destination scrape failed; candidates left undecided. Includes reason. |
| `pair.dedupe.semantic_clean`            | (Optional) Layer 2 semantic dedupe ran and cleared the candidate. Includes `candidateExcerpt`, `windowSize`, `candidatesCompared`. |
| `pair.publish.semantic_duplicate`       | **Layer 2 semantic dedupe match — candidate skipped pre-publish.** Includes `pairId`, `sourceItemId`, `candidateExcerpt` (first 200 chars), `matchedExistingUrl`, `matchedExistingExcerpt` (first 200 chars), `agentReasoning` (1-3 sentence justification), `windowSize` (number of destination posts compared). See `skills/repost-dedup-semantic/SKILL.md`. |
| `pair.publish.start`                    | About to drive the destination compose flow. |
| `pair.publish.url_expanded`             | One shortened URL was expanded. Includes `from`, `to`. |
| `pair.publish.url_expand_failed`        | One URL expansion failed. Includes `url`, `error`. |
| `pair.publish.truncated`                | Draft exceeded char cap; truncate strategy applied. |
| `pair.publish.skipped_overlength`       | Draft exceeded char cap; skip strategy applied. |
| `pair.publish.success`                  | Destination confirmed the post. Includes `sourceItemId`, `destinationUrl`. |
| `pair.publish.failed`                   | Compose flow failed. Includes `category`, `error`. |
| `pair.publish.notify.success`           | Telegram-confirm delivered. |
| `pair.publish.notify.failure`           | Telegram-confirm failed. Includes error. **The post itself stayed up.** |
| `pair.publish.notify_skipped_unconfigured` | Telegram plugin not loaded. **Treat as a silent-publish alert.** |
| `pair.run.no_new_items`                 | Run completed; nothing new to publish. |
| `pair.backfill.would_publish`           | Dry-run hit on a candidate. |
| `pair.backfill.published`               | Backfill loop publish succeeded. |
| `pair.backfill.skipped_now_duplicate`   | Re-check between publishes found the candidate had been posted by another path. |

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
on each cron tick — quirks accumulate here over time. (Ethan voice 6029,
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

1. **Start of every run** (`repost-run`, `repost-backfill`, the cron-spawned
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
  "intervalMinutes": 10,
  "completedSourceItemIds": ["urn:li:activity:7000", "..."],
  "skippedSourceItemIds": ["urn:li:activity:6999"]
}
```

## File-mode invariants

- `pairs.json` mode: `0644` (default umask). Contains no secrets — Telegram
  bot tokens etc. live in the `plugin:telegram:telegram` plugin's own config,
  not in this plugin.
- `posted.jsonl` mode: `0644`.
- `audit.jsonl` mode: `0644`.
- `learnings.md` mode: `0644`.

## See also

- `templates/pairs.json.template` — example v4 pair config.
- `templates/posted.jsonl.template` — example posted history shape.
- `templates/audit.jsonl.template` — example audit event sequence.
- `templates/learnings.md.template` — placeholder shape for new pairs.
- `skills/repost-learnings/SKILL.md` — full spec for the learnings.md
  lifecycle + signal-vs-noise rules.
- `docs/architecture.md` — why this state shape, why no daemon.
- `docs/migration-v3-to-v4.md` — how the v3 → v4 schema migration works.
