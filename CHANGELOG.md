# Changelog

## Unreleased — production/OpenClaw readiness audit

### Added

- Added `skills/repost-custom-rules/SKILL.md` for user-configured skip rules that run after source scrape and before dedupe/publish.
- Added append-only `~/.repost-with-agent/considered.jsonl` state for not-post-worthy/custom-rule decisions, plus `templates/considered.jsonl.template` and `pair.custom_rule.skipped` audit schema.
- Seeded docs/schema support for Ethan's current `skip-x-ai-slop-machine-videos` rule: skip future X video/livestream candidates matching `vibe coding an ai slop machine #ai #programming #developer` without rewriting historical publish/global ledgers.

### Changed

- Added `policy.overlengthStrategy: "compact"` guidance/default for Ethan/OpenClaw: over-limit drafts should be rewritten shorter while preserving the original voice/essence before skipping.
- Generalized notification routing: Repost publish/test/failure notifications now use `notification.delivery` in `~/.repost-with-agent/pairs.json` (channel/account/target/thread metadata captured from the current harness), with Ethan's Telegram `clordlethird` route as instance config rather than a product-wide hard-code; never default accounts or raw JSON/tool dumps.
- Aligned README, templates, pair setup/list docs, migration notes, and state schema on the current conservative daily/default-24h cadence instead of stale every-5h examples.
- Documented clean marketplace packaging guidance so local ignored/private state is not bundled.
- Clarified preview proof logging with `pair.preview.success`, including schema and template sample, because scheduler setup checks for it before arming live ticks.
- Clarified `needs-account-switch` as a first-class publish failure category so account/profile mismatch blocks safely instead of posting from the wrong identity.
- Clarified backfill publish pacing so `policy.minDelayBetweenPostsMinutes` floors requested intervals and prevents accidental spam bursts.

## v4.4.0 — 2026-05-04 — Global cross-pair dedupe ledger

**Safety/dedupe fix.** Pairs no longer think only in their own `posted.jsonl`. Every publish-capable path now has an explicit global cross-pair ledger step so alternate routes do not double-post the same underlying content to the same destination.

### Added

- `skills/repost-global-dedupe/SKILL.md` — resolves/inherits a cross-pair `contentKey`, reads `~/.repost-with-agent/global-posted.jsonl`, and skips if any pair already got that content to this destination platform/account.
- `~/.repost-with-agent/global-posted.jsonl` state schema in `docs/state-files.md`.
- `pair.policy.globalDedupeEnabled` (default `true`) in templates/docs.
- `pair.dedupe.global_duplicate` audit event schema.
- `templates/global-posted.jsonl.template`.

### Changed

- `repost-run`, `repost-backfill`, `repost-dedup`, `repost-dedup-semantic`, `INSTRUCTIONS.md`, `README.md`, `AGENTS.md`, and `CLAUDE.md` now say every publish/catch-up proof must update the global ledger.
- Successful publishes now require both per-pair history append and global ledger append. Semantic/remote/global duplicate catch-ups also append global state when they prove destination state.
- Manifests/package version bumped to `4.4.0`, and the Claude-compatible manifest lists `repost-global-dedupe`.

### Why

Ethan explicitly clarified the important case: if LinkedIn→X creates or observes a post and another pair later treats that X post as source for Bluesky, direct X→Bluesky and LinkedIn→Bluesky must share global knowledge and not double-post. The global ledger makes all pairs look globally regardless of route.

## v4.3.1 — 2026-05-04 — OpenClaw first-class harness path

**Compatibility/documentation fix.** Keeps the plugin skill-only and agent-agnostic, but removes the remaining Claude Code default assumptions from the active OpenClaw path.

### Changed

- Manifests now describe Repost-with-agent as an agent/OpenClaw-compatible current-harness plugin instead of a Claude Code-first plugin.
- Runtime instructions now name OpenClaw's built-in browser and `message` / Telegram-channel delivery as first-class paths, with Claude Code's `chrome-devtools-mcp` + `plugin:telegram:telegram` as Claude-specific equivalents.
- Scheduler setup now prefers `openclaw cron add ... --message "/repost-run <pair-id>"` for OpenClaw workflows; launchd/crontab shell invocations are fallback paths only when a non-OpenClaw harness is explicitly chosen.
- README now documents directory-source install/update mechanics: normal repo edits and `git pull` do not require reinstall when the registered plugin path still points at this repo.
- Pair schema/docs now support `destination.targetType` and `destination.accountDisplayName` so one login can explicitly target the right profile/page/group.
- Run instructions now require reusing existing browser tabs where possible instead of opening duplicate platform tabs on every scheduled tick.
- Facebook, Bluesky, and Threads destination notes now require verifying or switching to the configured identity before typing a draft, and stopping with `needs-account-switch` rather than publishing from the wrong account.
- Removed legacy shell registration helpers; the repo now contains no executable config-helper path. Harness registration is documented as configuration-only.
- Removed the browser stealth research note so the repo stays aligned with transparent logged-in-session automation and no CAPTCHA / anti-detection bypass guidance.
- `openclaw.plugin.json` now uses the documented native manifest shape: empty strict `configSchema` plus `skills: ["skills"]`, with no unsupported legacy root-list fields.

### Safety

No posting code, platform API integration, MCP server, CLI runtime, shell registration helper, or browser-publishing action was added. This remains a Markdown skill/command plugin; the running agent performs the workflow with its native tools.

## v4.3.0 — 2026-05-01 — Layer 2 semantic dedupe (agent reasoning over destination)

**Additive change.** Adds a second dedupe layer on top of v4.2.0's existing
Layer 1 (exact `sourceItemId` lookup + fuzzy-string match against the
destination feed). Layer 2 has the running agent read the candidate draft
alongside the destination's most recent posts and use its OWN reasoning to
decide whether the candidate is "essentially the same announcement /
opinion / claim, different words." Catches paraphrased duplicates that
Layer 1's string-match cannot.

(Ethan voice 6106, 2026-05-01: *"It should make sure the agent actually
semantically looks and processes the content of the message and checks the
target destination and sees if there's a post with similar wording already
there. If because there is, then it shouldn't go through. So the ID thing
in the JSON files, etc., that's precise, and that's like layer one. But
layer two is it should check the semantics, and if there's something
already similar, it shouldn't post a duplicate. That'll be embarrassing."*)

### Why

v4.2.0 dedupe was string-only. A post like "Just shipped a new feature for
cross-posting between LinkedIn and X — agents do the work, no APIs, no
Playwright" and a candidate "We just launched our cross-poster from
LinkedIn to X. Pure agent-driven. No APIs needed." both make the same
announcement, but the strings are different enough that fuzzy-prefix
overlap won't catch the duplicate. The agent's existing semantic
understanding is the right tool to apply at this layer — no extra
infrastructure (no embeddings DB, no extra LLM call); the running agent
just looks at both texts and judges.

### Layer separation

| Layer | Skill | Method | Catches | Cost |
| ----- | ----- | ------ | ------- | ---- |
| 1 | `repost-dedup` | Exact `sourceItemId` match + fuzzy-string match (normalize + ≥80-char prefix overlap) | Verbatim and near-verbatim re-posts | Cheap (string ops) |
| 2 | `repost-dedup-semantic` | Agent reads candidate + recent destination posts, judges semantic redundancy | Paraphrased duplicates ("same point, different words") | One reasoning pass |

Both layers run in series. Layer 1 first as a quick filter; Layer 2 only
on Layer-1-clean candidates. **A candidate must pass BOTH to publish.**

### How the agent makes the judgment

For each candidate, the agent asks literally: *"Would a reader who has
already seen one of these existing destination posts find the candidate
redundant?"* Same announcement, same opinion, same claim, same
call-to-action implied → skip. Same theme but different specifics or a
different communicative function → proceed. **Lean conservative** — when
on the fence, skip; missed posts are cheap, embarrassing duplicates are
expensive.

The skill body documents three GOOD MATCH (skip) examples and three
WEAK MATCH (proceed) examples to anchor the agent's judgment.

### Added

- `skills/repost-dedup-semantic/SKILL.md` — new skill defining Layer 2.
  Worked examples for "skip" vs "proceed" decisions, the explicit
  judgment question, the procedure step-by-step, and the
  `pair.publish.semantic_duplicate` audit shape.
- `pair.policy.semanticDedupeEnabled` (default `true`) — pair-level
  toggle.
- `pair.policy.semanticDedupeWindowSize` (default `30`) — how many recent
  destination posts the agent compares the candidate against. Reuses the
  scrape Layer 1 already produced. Tune up for high-volume destinations
  (X power-users), down for low-volume (Substack-style).
- `pair.publish.semantic_duplicate` audit event — fired when Layer 2
  decides a candidate is a paraphrased duplicate. Fields: `pairId`,
  `sourceItemId`, `candidateExcerpt` (first 200 chars),
  `matchedExistingUrl`, `matchedExistingExcerpt` (first 200 chars),
  `agentReasoning` (1-3 sentence justification), `windowSize`.

### Changed

- `skills/repost-run/SKILL.md` — adds Step 4.5 "Layer 2 dedupe (semantic
  similarity, agent reasoning)" between Step 4 and Step 5. Documents
  reuse of the Step 4 destination scrape and the policy gate.
- `skills/repost-backfill/SKILL.md` — adds Step 5.5 documenting Layer 2,
  and updates Step 6's publish-loop ordering so Layer 2 runs per-iteration
  against the freshest destination state (catches in-loop publishes).
- `skills/repost-dedup/SKILL.md` — heading retitled "Layer 1", new
  "Layer separation" section explaining Layer 1 vs Layer 2 trade-offs and
  why both run in series.
- `templates/pairs.json.template` — adds `semanticDedupeEnabled: true` +
  `semanticDedupeWindowSize: 30` to the policy block.
- `docs/state-files.md` — adds the two new policy fields to the schema +
  field invariants, adds `pair.publish.semantic_duplicate` (with full
  field schema block) and `pair.dedupe.semantic_clean` (optional) to the
  audit-event taxonomy.
- `docs/destinations/{x,linkedin,bluesky,threads,facebook}.md` — adds a
  Layer 2 window-size guidance subsection per platform (high-volume vs
  low-volume cadence).
- `README.md`, `INSTRUCTIONS.md`, `CLAUDE.md`, `AGENTS.md` — version
  bumped to 4.3.0; "Two-layer dedupe" / "Project rules" sections rewritten
  to explain Layer 1 + Layer 2 separation, cite Ethan voice 6106, and
  document the conservative-on-fence stance.
- `package.json`, `.claude-plugin/plugin.json`, `openclaw.plugin.json` —
  version bumped to 4.3.0; manifest skill list now includes
  `skills/repost-dedup-semantic`.

### Backward compatibility

100% backward compatible. The two new `pair.policy` fields default to
`true` / `30` if absent, so existing v4.2.0 pair configs work unchanged.
Existing `posted.jsonl` and `audit.jsonl` files are untouched. Layer 1
behavior is unchanged. The only observable change for an existing pair is
that the agent now also runs the Layer 2 reasoning pass before publish —
which the user explicitly asked for.

If a user wants pure string-only dedupe (the v4.2.0 behavior), set
`pair.policy.semanticDedupeEnabled: false`.

## v4.2.0 — 2026-05-01 — Structured learnings.md entries (selectors + playbooks)

**Additive change.** Extends the v4.1.0 learnings.md format so each entry
can include three OPTIONAL structured sub-sections — `### Selectors`,
`### Step playbook`, and `### Quirks` — that turn institutional memory
from free-form prose into an actionable cache the next run can grep, skim,
and follow verbatim.

(Ethan voice 6083, 2026-05-01: "Make sure the reposting, the instructions
for the learning also say to add like selectors so it's just easier next
time to quickly follow the steps that they're having to figure out from
scratch because that saves a lot of time.")

### Why

v4.1.0 introduced the learnings.md lifecycle but only specified free-form
prose entries. That captured *context* well ("LinkedIn moved the button")
but didn't capture *mechanics* in a shape future runs could mechanically
follow. The next run still had to translate prose into selectors + click
order, which left most of the time-saving on the table.

v4.2.0 adds an explicit structured shape so each entry doubles as a
recipe: future runs read the cached selectors + step playbook FIRST and
fall back to `docs/destinations/<platform>.md` only when learnings.md is
silent or a cached selector misses. When a cached selector fails, that's
itself a quirk worth recording (DOM moved again).

### Entry shape

```markdown
## YYYY-MM-DD HH:MM — <one-line summary>

<2–5 sentences of prose: what you saw, why it matters, implication.>

### Selectors          (optional — STRONGLY preferred when applicable)
- <label>: `<selector>` (<platform>, <where in flow>)

### Step playbook     (optional — STRONGLY preferred when applicable)
1. <imperative step using the selectors above>

### Quirks            (optional)
- <one-line edge case / "skip if X" / timing note>
```

The three `###` sub-sections are OPTIONAL — omit any with no content
rather than writing them empty. Free-form prose-only entries stay valid
(useful for behavioral observations that don't yet have an actionable
selector). But entries WITHOUT selectors / step playbooks / a sharply-
described quirk are still considered low-value: the file is for
actionable deltas, not vague impressions.

### Read-priority for runs

When `repost-run` / `repost-backfill` reads learnings.md at the start of
a run, the priority is:

1. Most-recent entry's `### Selectors` + `### Step playbook` — try
   verbatim FIRST.
2. Most-recent entry's `### Quirks` — apply as guards / "skip if" rules.
3. Older entries — for superseding context (`Supersedes the YYYY-MM-DD entry.`).
4. `docs/destinations/<platform>.md` — fall back ONLY when learnings.md
   is silent, or when a cached selector fails to match the live DOM.

### Changed

- `skills/repost-learnings/SKILL.md` — extended file-format spec with the
  three optional `###` sub-sections, updated good/bad-entry examples
  (good entry now shows all three sections), expanded append snippet
  with both prose-only and full-structured forms, lifecycle step 1
  spells out the read-priority rule.
- `templates/learnings.md.template` — placeholder comment block now
  documents the structured shape with a worked example.
- `skills/repost-run/SKILL.md` — Step 1.5 explicitly tells the agent
  to try `### Selectors` + `### Step playbook` verbatim FIRST and fall
  back to `docs/destinations/<platform>.md` only on miss; Final step
  documents the structured-entry append shape.
- `skills/repost-backfill/SKILL.md` — same priority instruction in
  Step 1.5; Step 9 documents the structured-entry append shape.
- `docs/state-files.md` — `learnings.md` section now documents the
  three optional sub-sections + read-priority rule.
- `docs/destinations/{linkedin,x,bluesky,threads,facebook}.md` — top
  callout strengthened to "Read order: learnings.md FIRST, this doc
  second" with the explicit structured-section reference.
- `README.md`, `CLAUDE.md`, `AGENTS.md`, `INSTRUCTIONS.md` — version
  bumps + a one-paragraph mention of the structured entry shape and
  read-priority rule.
- `.claude-plugin/plugin.json`, `openclaw.plugin.json`, `package.json`
  — `version` bumped to 4.2.0.

### Preserved

- `pairs.json` schema — unchanged.
- `posted.jsonl` schema — unchanged.
- `audit.jsonl` event taxonomy — unchanged.
- The non-negotiable Telegram-confirm rule.
- The learnings.md lifecycle (read at start, append at end, mark obsolete
  via heading edit) — only the entry format inside is extended.
- All v4.0.0 / v4.1.0 skill names, slash command shapes, install paths,
  and state-file locations.

### Migration

No migration required. Existing free-form prose entries remain valid
(the new sub-sections are additive). The first time a run discovers a
quirk after upgrade, it appends an entry using the new shape; older
entries stay untouched. The existing `linkedin-to-x` pair's stub
`learnings.md` had no entries to migrate.

---

## v4.1.0 — 2026-05-01 — Per-pair learnings.md institutional memory

**Additive change.** Adds a per-pair `learnings.md` file pattern so the
running agent builds up platform-quirk knowledge over time and doesn't
re-figure DOM changes / pagination caps / rate-limit signatures from
scratch on every cron tick.

(Ethan voice 6029, 2026-05-01: "Have instructions so the agent keeps a
learnings.md file that makes it easier for subsequent things to happen
faster, like weird quirks or stuff. So it doesn't have to figure it out
every single time from scratch. It just builds up these learning files
over time and reads it every time it executes the cron job.")

### Lifecycle

For each pair `<id>`, the agent maintains
`~/.repost-with-agent/pairs/<id>/learnings.md`:

1. **Start of every run** (manual or cron): the agent reads `learnings.md`
   if it exists. Treats it as up-front context — quirks to be aware of
   before scraping or composing (e.g., "Bluesky's compose button moved to
   a sidebar 'New Post' button on mobile-narrow viewports", "X's
   profile-page recent-posts now require scrolling 4× before old posts
   appear", "LinkedIn's `lnkd.in/` shortener sometimes redirects to a
   login wall — fall back to canonicalUrl in that case").
2. **During execution**: the agent tracks any encountered quirks /
   gotchas / unexpected DOM behavior in its reasoning. It does NOT
   append to the file mid-run (a crash mid-write would corrupt the file).
3. **End of run**: the agent appends new findings to `learnings.md` with
   a timestamped `## YYYY-MM-DD HH:MM — <one-line summary>` heading
   followed by 2–5 sentences of detail. Append-only via `>>` in Bash.
4. **Stale-learning pruning**: if a fresh observation contradicts an
   older entry, the agent appends a NEW entry (rather than editing the
   old one), but adds ` [obsoleted YYYY-MM-DD]` to the older entry's
   heading via a targeted `Edit`. Don't delete history; only annotate.

### Added

- `skills/repost-learnings/SKILL.md` — full spec for the lifecycle,
  signal-vs-noise rules, and good/bad-entry examples. Other skills link
  to this one as a reference.
- `templates/learnings.md.template` — placeholder shape for new pairs:

  ```markdown
  # <pair-id> learnings

  _No learnings recorded yet — the agent will append entries as it
  discovers quirks during runs._
  ```

### Changed

- `skills/repost-run/SKILL.md` — added Step 1.5 (read `learnings.md`
  before scraping) and a Final step (append discovered quirks before
  exiting).
- `skills/repost-backfill/SKILL.md` — same pattern; Step 1.5 reads, new
  Step 9 batches the loop's discovered quirks at the end (avoids
  mid-loop append corruption).
- `skills/repost-listen-for-future-setup/SKILL.md` — explicit note that
  the cron-spawned subagent inherits the learnings-file lifecycle, so
  cron ticks accumulate institutional memory across invocations even
  though there's no shared in-memory state between them.
- `skills/repost-pair-show/SKILL.md` — output now includes a "Recent
  learnings (last 5)" section. `--full-learnings` flag dumps the entire
  file.
- `skills/repost-history/SKILL.md` — optional `--with-learnings` flag
  includes the last 3 learnings entries below the post-history tail.
- `docs/state-files.md` — `learnings.md` section expanded with full
  format spec, lifecycle, and surfaced-by table.
- `docs/destinations/<platform>.md` (linkedin, x, bluesky, threads,
  facebook) — each now opens with a callout that the per-platform DOM
  hints are STARTING points; the per-pair `learnings.md` may extend or
  override them as the agent discovers quirks specific to Ethan's
  account or recent UI changes. Per-pair file wins on conflict.
- `README.md`, `INSTRUCTIONS.md`, `AGENTS.md`, `CLAUDE.md` — short blurb
  in the architecture section about the learnings-file pattern.
- `.claude-plugin/plugin.json` — adds `skills/repost-learnings` to the
  declared skills array. Bumps `version` to 4.1.0.
- `openclaw.plugin.json` — bumps `version` to 4.1.0.
- `package.json` — bumps `version` to 4.1.0.

### Preserved

- `pairs.json` schema — unchanged. Learnings live in their own file, not
  embedded in pair config.
- `posted.jsonl` schema — unchanged. No audit-shape changes.
- `audit.jsonl` event taxonomy — unchanged. No new events for the
  learnings-file lifecycle (it's an internal agent housekeeping pattern,
  not a publish-pipeline state transition).
- The non-negotiable Telegram-confirm rule.
- All v4.0.0 skill names, slash command shapes, install paths, and
  state-file locations.

### Migration

No migration required. On first run after upgrade, the agent reads
`learnings.md`; if absent, it proceeds without prior context and seeds
the file as it discovers quirks. The placeholder stub (from
`templates/learnings.md.template`) can be created up-front for known
pairs to avoid the first-run no-file path:

```bash
mkdir -p ~/.repost-with-agent/pairs/<id>
cp templates/learnings.md.template ~/.repost-with-agent/pairs/<id>/learnings.md
sed -i '' "s/<pair-id>/<id>/g" ~/.repost-with-agent/pairs/<id>/learnings.md
```

The existing `linkedin-to-x` pair already had a placeholder
`learnings.md` from v3 — preserved untouched.

---

## v4.0.0 — 2026-05-01 — Skill-only plugin (second rewrite)

**Major architectural change.** Repost-with-agent is now a **skill-only plugin**.
There is **no CLI**, **no MCP server**, **no platform SDKs**, **no Playwright**.
The plugin ships zero code that does the work — it ships instructions (skills)
and the running agent's existing toolkit (Read, Edit, Write, Bash, browser
MCP, plugin:telegram:telegram) does everything.

(Ethan voice 6024 + 6026, 2026-05-01: "The whole point of this is a plugin we
install into the existing agent harness... It's essentially just a skill for
the existing harness. This isn't fucking a CLI that uses a new chat... we
don't code anything in.")

### Stripped (v3 → v4)

- `src/` entirely — every TypeScript file (CLI orchestrator,
  `agent-task-contract.ts`, `agent-runner.ts`, `orchestrator.ts`,
  `backfill.ts`, `scheduling.ts`, `notify.ts`, `dedupe.ts`, `truncate.ts`,
  `url-expander.ts`, `policy.ts`, `runtime.ts`, `types.ts`, `config.ts`,
  `index.ts`).
- `tests/` — all 8 regression suites. None of them apply to skill-driven flow.
- `tsconfig.json`, `package-lock.json`, `node_modules/`, `dist/`, `.env.example`.
- The `repost-with-agent` CLI binary (no more `bin` entry in `package.json`).
- `templates/repost_with_agent_workspace/` (legacy v2/v3 workspace template).
- `examples/`, `site/`, `.github/` workflows, `PLAN.md`.
- `commands/preview.md` (functionality folded into `commands/run.md`).
- `scripts/agent-bridge-handler.sh`, `scripts/init_repost_with_agent_workspace.py`,
  and the old v3 OpenClaw registration helper.
- `docs/WORKFLOW.md`, `docs/scheduling.md`, `docs/safety.md`,
  `docs/setup-flow.md`, `docs/migration-v2-to-v3.md`, the v3 versions of
  `docs/architecture.md`, `docs/migration.md`, `docs/url-expander.md`,
  `docs/screenshots/`.
- The "agent-task contract" boundary entirely — no more typed JSON tasks
  written to `~/.repost-with-agent/agent-tasks/`. The agent reads the skill
  and acts directly.

### Added

- `.claude-plugin/marketplace.json` — directory-source marketplace manifest
  (mirrors agent-bridge's pattern).
- 10 `skills/<name>/SKILL.md` files:
  - `repost-pair-setup` — create / edit pairs.
  - `repost-pair-list` — list pairs.
  - `repost-pair-show` — inspect one pair.
  - `repost-run` — single-post end-to-end flow.
  - `repost-backfill` — multi-post historical walk.
  - `repost-listen-for-future-setup` — install launchd plist / cron entry.
  - `repost-history` — tail posted.jsonl.
  - `repost-dedup` — fuzzy-match algorithm reference.
  - `repost-url-expand` — shortener resolution.
  - `repost-notify` — Telegram-confirm payload + non-negotiable rule.
- 4 `commands/*.md` slash command wrappers: `/pair`, `/repost-run`,
  `/repost-backfill`, `/repost-setup-cron`.
- `templates/pairs.json.template`, `posted.jsonl.template`,
  `audit.jsonl.template`.
- `docs/state-files.md` — formal schemas + audit-event taxonomy.
- `docs/architecture.md` — v4 architecture rationale (rewritten).
- `docs/migration-v3-to-v4.md` — second-rewrite changelog + rollback path.
- `docs/url-expander.md` — agent-facing reference (rewritten).
- `INSTRUCTIONS.md` — primer for the running agent.

### Changed

- `package.json` — bare metadata only. No `bin`, no `main`, no `scripts`, no
  dependencies, no devDependencies. Just name, version (4.0.0),
  description, license, keywords, repository, homepage.
- `.claude-plugin/plugin.json` — declares 10 skills + 4 commands. NO
  `mcpServers` section.
- `openclaw.plugin.json` — `runtime` block removed entirely; OpenClaw-native
  metadata declares skill directories only. NO `mcp` section.
- `pairs.json` schema — `schemaVersion` 3 → 4. Deprecated fields ignored
  (`policy.requirePreviewBeforeFirstLiveRun`, `policy.preferOfficialApi`,
  `dedupe.strategy`, `*.authRef`, `source.type`, `destination.type`).
  Added: `runMode` (default `"listen-for-future"`), `schedule.everyHours`
  (default 5), `policy.overlengthStrategy` (default `"skip"`).
- The Telegram-on-publish notifier is now enforced by skill bodies, not by
  a `notify.json` config file. Uses the running session's
  `plugin:telegram:telegram` plugin directly.
- Per-platform DOM hints in `docs/destinations/<platform>.md` rewritten as
  direct procedural prose for the running agent (no more "post-to-destination
  task" / "fetch-source task" vocabulary).
- README, CLAUDE.md, AGENTS.md fully rewritten for v4 architecture.

### Preserved

- `~/.repost-with-agent/pairs/<id>/posted.jsonl` history — UNTOUCHED. Schema
  identical between v3 and v4.
- `~/.repost-with-agent/pairs/<id>/audit.jsonl` — UNTOUCHED.
- `~/.repost-with-agent/pairs/<id>/learnings.md` — UNTOUCHED.
- The 11 entries in the legacy `linkedin-to-x` posted.jsonl survive
  unchanged.

### Migration

Register the v4 clone as a directory-source plugin in the target harness config,
then back up and migrate `~/.repost-with-agent/pairs.json` if it is still v3.

For v3 → v4 schema migration on `pairs.json`, see `docs/migration-v3-to-v4.md`.

### Non-negotiable rule (continued from v3)

> Telegram-confirm every successful publish. Silent publishes are a bug.
> (Ethan voice 5977 + 5978, 2026-05-01.)

In v4 this is enforced in the skill bodies (`repost-notify` is the primary
enforcement point; `repost-run` step 10 + `repost-backfill` step 6 explicitly
invoke it). The rule is restated verbatim in README, CLAUDE.md, AGENTS.md,
INSTRUCTIONS.md, openclaw.plugin.json, and every slash command body.

---

## v3.0.0 — 2026-05-02 — Strip-and-rewrite, agent-driven

**Major architectural change.** The CLI is now a thin orchestrator over JSON state; the agent (Claude Code via `chrome-devtools-mcp`, OpenClaw via its built-in browser tool) drives the user's logged-in browser to do the actual reposting. There is **no API path** and **no Playwright** in `src/`. (Ethan voice 6016 + 6018 + 6021, 2026-05-01.)

### Stripped (the v3 architectural sin to never reintroduce)

- `src/x-client.ts` (520 LOC X API).
- `src/linkedin-scraper.ts` (279 LOC Playwright).
- `src/facebook-client.ts` (Facebook Graph API).
- `src/adapters/{sources,destinations}/` (per-platform adapter classes).
- `src/legacy-commands.ts`, `src/tracker.ts` (legacy `linkedin-to-x` sync path).
- `playwright`, `dotenv` deps from `package.json`. The runtime now ships with `commander` only.
- The `auth`, `sync`, `list`, `start`, `migrate linkedin-to-x` CLI verbs (legacy / replaced by browser-driven flows + auto-migration).
- `docs/substack-investigation.md` (Substack dropped from v3 scope per Ethan voice 6021 — "not really social media").

### Added — agent-task contract

- `src/core/agent-task-contract.ts` — typed `AgentTask` / `AgentResult` union covering `fetch-source`, `post-to-destination`, `check-destination` across all platforms. Includes inbox file helpers (`writeAgentTask`, `readAgentTask`, `writeAgentResult`, `readAgentResult`) routing through `~/.repost-with-agent/agent-tasks/<correlation_id>.{task,result}.json`.
- `src/core/agent-runner.ts` — `runAgentTask(task, options)` dispatches via in-process handler callback (used by tests + inline-driven CLI flows) OR via filesystem inbox + stdout banner (decoupled invocation). The orchestrator is the only place that knows about agents; everywhere else just calls the runner.
- New `error-result` shape with `category` field (`needs-login` / `needs-config` / `rate-limit` / `platform-error` / `unknown`) so the orchestrator can route auth failures vs transient errors vs platform misconfig.

### Added — URL expander (Ethan voice 6018, 6021)

- `src/core/url-expander.ts` — follows shortener redirects to the final destination URL before publish.
  - Max 5 hops, 5-second timeout per request, fail-soft on any error (timeout / network / loop / hop-cap / missing Location).
  - HEAD first, fallback to GET on 405/501.
  - Loop detection (URL appears twice in chain).
  - Covers lnkd.in, t.co, bit.ly, buff.ly, goo.gl, tinyurl.com, ow.ly, rb.gy, is.gd, shorturl.at, tiny.cc, cutt.ly, youtu.be, fb.me, trib.al, plus any URL that issues a 30x.
- `expandUrlsInText(body)` substitutes every shortened URL in a block of text.
- New helper commands: `repost-with-agent urls expand <url>` and `repost-with-agent urls expand-text "<body>"`.
- Audit event `pair.publish.url_expanded` per substitution, with `{shortenedUrl, expandedUrl, hopCount}`.
- `tests/url-expander-regression.js` (new) — 12 sections covering single hop, multi-hop, MAX_HOPS cap, redirect loop, timeout fail-soft, network fail-soft, HEAD 405 → GET fallback, missing Location, expandUrlsInText substitution, isShortener helper, smoke test for every known shortener.

### Added — two run-modes (Ethan voice 6021)

- `pair.runMode` field on `PairRecord`:
  - `"backfill"` — walk back through historical posts. Run via `pair backfill <id>`. **Newest-first** ordering (was oldest-first in v2).
  - `"listen-for-future"` (default for migrated v2 pairs) — continuous tail. Host scheduler invokes `pair scheduled-run <id>` at the configured cadence. Always preview-only unless `--allow-publish` AND `pair.mode=live-approved`.
- `pair create --run-mode <mode>` and `pair edit --run-mode <mode>` flags.
- `orderNewestFirst` (replaces `orderOldestFirst`) — sorts by `publishedAt` descending, falls back to source-order ascending.

### Added — generic platform support

- `pair.source.platform` / `pair.destination.platform` — free-form string labels (e.g. `"linkedin"`, `"x"`, `"bluesky"`, `"threads"`, `"facebook"`). Replaces v2's `type` field (which was an adapter id).
- `pair create --source-platform <p> --destination-platform <p>` flags (replaces v2's `--source-type` / `--destination-type`).
- Platforms supported in v3.0.0: **LinkedIn, X, Bluesky, Threads, Facebook**.
- Default per-platform char caps in `DEFAULT_PLATFORM_MAX_LENGTH`: X=280, Bluesky=300, Threads=500, Facebook=63206, LinkedIn=3000. Override via `--overlength-strategy` on `pair post` / `pair backfill`.

### Added — overlength enforcement on `pair post`

- `pair post <id> --approve --overlength-strategy {skip|truncate}` — same semantics as `pair backfill`'s strategy. `skip` (default) refuses; `truncate` smart-shortens.
- New audit events: `pair.publish.overlength-blocked`, `pair.publish.truncated`.
- New scheduled-run outcome: `overlength-blocked`.

### Added — v2 → v3 pair migration

- One-shot migration on first read of a v2-shaped `pairs.json`:
  - Backs up the original to `~/.repost-with-agent/pairs.json.v2.bak`.
  - Translates `type` → `platform` for known v2 adapter ids (`linkedin-profile-activity` → `linkedin`, `x-account` → `x`, `facebook-page` → `facebook`, `bluesky-account` → `bluesky`, `threads-account` → `threads`).
  - Sets `runMode: "listen-for-future"` (preserves v2's only-mode-it-had semantics).
  - Stamps `schemaVersion: 3`.
- Verified locally on Ethan's existing `linkedin-to-x` pair: all 11 entries in `posted.jsonl` preserved untouched; pair loads cleanly; `pair show` / `pair history` work.
- See `docs/migration-v2-to-v3.md` for the full walkthrough.

### Added — agent-task-contract regression tests

- `tests/agent-task-contract-regression.js` (new) — 9 sections covering correlation-id format, inbox round-trip, error result type guard, summarizeTask formatting, in-process handler dispatch, runAgentTaskExpect type-mismatch throw, full preview/publish path with mock agent, agent-error-result-halts-publish.

### Changed

- `src/core/orchestrator.ts:previewPair()` and `publishNextForPair()` now take `PreviewOptions` / `PublishPairOptions` instead of source/destination adapter instances. The agent task handler is supplied via `options.agent.handler` for in-process tests OR omitted to use the inbox path.
- `src/core/backfill.ts:runBackfill()` similarly takes only `BackfillOptions` (no adapter args). The CLI no longer constructs / registers adapters.
- `src/core/scheduling.ts:runScheduled()` drops adapter args; passes through to `publishNextForPair`.
- `src/index.ts` simplified — removed `--source-type` / `--destination-type` flags (replaced with `--source-platform` / `--destination-platform`), removed legacy `auth | sync | list | start | migrate` verbs, added `--run-mode` flag on `pair create` / `pair edit`, added `--overlength-strategy` flag on `pair post`, added `urls expand | expand-text` helper subcommands.
- `tests/backfill-regression.js`, `tests/overlength-regression.js` rewritten to drive `runBackfill` via in-process agent task handler. All assertions preserved.
- `tests/dedupe-regression.js`, `tests/scheduling-regression.js`, `tests/notify-regression.js`, `tests/truncate-regression.js` unchanged (they exercise pure functions that didn't change).
- README / CLAUDE.md / AGENTS.md / openclaw.plugin.json / both `skills/*/SKILL.md` / all `commands/*.md` rewritten to reflect the v3 architecture and to describe the agent-task contract.
- `docs/architecture.md`, `docs/WORKFLOW.md`, `docs/setup-flow.md`, `docs/safety.md`, `docs/scheduling.md`, `docs/migration.md` rewritten / updated for v3.
- `docs/url-expander.md` (new), `docs/migration-v2-to-v3.md` (new), `docs/destinations/{linkedin,x,bluesky,threads,facebook}.md` (new) added.
- `examples/pairs.example.json` rewritten to v3 shape (`platform` + `runMode` + `schemaVersion: 3`).
- `.env.example` cut down to just the data-dir override and Telegram-notify fallback. v2's X / LinkedIn / Facebook / Playwright env vars are gone.
- OpenClaw registration notes updated to reflect v3 (no X auth flow / Playwright profile / browser-login walkthrough; just notify + pair create + schedule).
- Bumped `VERSION` to `3.0.0` in both `package.json` and `src/index.ts`.

### Removed

- All v2 API SDKs and Playwright. **Do not reintroduce.** The architectural sin to avoid.
- The `linkedin-to-x` legacy bin alias from `package.json`.
- The `pair migrate linkedin-to-x` command (auto-migration on read replaces it).

### Migration checklist for v2 users

1. Pull v3.0.0.
2. `npm install` (Playwright + dotenv are removed; commander only).
3. `npm run build`.
4. Run any `pair list` or `pair show` command — auto-migration runs once. Backup at `~/.repost-with-agent/pairs.json.v2.bak`.
5. Log into both source AND destination platforms inside the agent's persistent browser profile (chrome-devtools-mcp's profile or whichever your harness drives). v2's X OAuth tokens are now ignored.
6. Verify `pair history <id>` still shows existing `posted.jsonl` entries.
7. Verify `notify status` reports `source: file` (or `env`).
8. Re-create any `--source-type substack-publication` pairs as a different platform — Substack is dropped from v3 scope.
9. See `docs/migration-v2-to-v3.md`.

### Test results

All 8 regression suites green: `dedupe`, `scheduling`, `backfill`, `notify`, `truncate`, `overlength`, `url-expander`, `agent-task-contract`. No live network or browser interactions.

---

## v2.6.0 — 2026-05-02

### Fixed — LinkedIn pagination cap

- `linkedin-profile-activity` source adapter no longer caps at ~10 items regardless of `--pages N`. Previously `fetchPage` set `hasMore = (allItems.length > start + slice.length)` which evaluated false on page 1 when the slice exactly equaled the loaded count, so the backfill caller (`fetchAllPages`) bailed before ever requesting page 2. The fix bumps the per-call scroll budget to `1 + ⌈totalNeeded / pageSize⌉ * 4` (so `--pages 2 --max 20` triggers ~9 scrolls instead of 6) and reports `hasMore = (slice.length === pageSize)` — i.e. trust the caller's `--pages N` request whenever we filled a full slice. Live `pair backfill linkedin-to-x --dry-run --pages 2 --max 20` now surfaces 20 candidates instead of 10. Fix in `src/adapters/sources/linkedin.ts`.

### Added — Overlength draft strategy

- New optional `maxLength` field on `DestinationAdapter`. Adapters that have a meaningful per-post char cap (X = 280 classic) declare it; adapters that handle threading internally (X Premium auto-thread) MAY omit. See `src/adapters/destination.ts`.
- `pair backfill <id> --overlength-strategy {skip|truncate}` controls what happens at plan time when a draft exceeds `destination.maxLength`:
  - `skip` (default; safer): the candidate is dropped from the publish loop. Plan + audit record `skip-too-long` decision.
  - `truncate`: the draft is smart-shortened with the new `truncate(draft, maxLength)` helper (sentence-boundary → word-boundary → hard-cut, then ellipsis). The truncated draft is what the live publish actually sends; trailing whitespace + leftover punctuation before the ellipsis is stripped.
- New audit events:
  - `pair.backfill.skipped_overlength` — emitted at plan time per skipped candidate, with `pairId`, `sourceItemId`, `draftChars`, `destinationMaxLength`, `strategy`.
  - `pair.backfill.truncated` — emitted at plan time per truncated candidate, with `originalDraftChars` + `truncatedDraftChars`.
  - `pair.backfill.publish.end` for truncated items now records `truncated: true`, `originalDraftChars`, `finalDraftChars`.
  - `pair.backfill.start` and `pair.backfill.plan` carry the chosen `overlengthStrategy` + `destinationMaxLength` for cross-state debugging.
- `BackfillResult.totals` gains `skippedOverlength` + `truncated` counters. CLI text + JSON outputs updated.
- New regression suites:
  - `tests/truncate-regression.js` — 11 sections covering empty input, exact-length match, sub-cap no-op, sentence-boundary cut, word-boundary fallback, hard-cut for single long token, trailing-punctuation strip, output-never-exceeds-cap across multiple cap sizes, `originalChars` tracking, pathological `maxLength <= 1`, multi-sentence cut.
  - `tests/overlength-regression.js` — 5 sections covering: skip-strategy filters at plan time + emits `skipped_overlength` audit; truncate-strategy publishes ≤maxLength output with `truncated: true` flag in `publish.end` audit; no-`maxLength` adapters bypass the strategy; pure-function `buildBackfillPlan` skip + truncate decisions.

### Changed

- Bumped `VERSION` to `2.6.0` in both `package.json` and `src/index.ts`.

## v2.5.0 — 2026-05-01

### Added — Backfill mode

- New `pair backfill <id>` CLI command. Walks back through historical source posts (paginated), cross-checks both `posted.jsonl` AND the destination platform itself for already-posted items, and publishes anything missing on a staggered schedule.
- Default policy: 2 pages, max 20 publishes, 10-minute interval between posts, oldest-first ordering, plan-only unless `--allow-publish` is passed (which requires `pair.mode=live-approved`).
- Source-adapter pagination: new optional `fetchPage(pair, { page, pageSize, cursor })` method. Adapters that don't implement it fall back to single-page `fetchCandidates()`. The LinkedIn adapter scrolls proportionally to the requested page so deeper pages surface more posts.
- Destination-side dedupe: new optional `findExistingPost(draft, pair)` method on `DestinationAdapter`. The X adapter implements it via the `/2/users/:id/tweets` endpoint with fuzzy normalized matching (whitespace-collapse, lowercase, trailing-punctuation strip, ≥80-char prefix overlap). Lookup failures degrade gracefully — they're audit-logged but never block a publish.
- Live progress: one tail-friendly stdout line per state transition (`[backfill] start`, `... fetched ... item(s)`, `... plan: N candidate(s) ...`, `... #K publish.start ...`, `... complete ...`).
- Audit events: `pair.backfill.{start, plan, skip.local, skip.destination, skip.already-in-run, wait, publish.start, publish.end, complete, error}`. Each carries the full context (item id, source URL, destination check result, scheduled-at, posted-at, etc.).
- Idempotent restart: a `~/.repost-with-agent/pairs/<id>/backfill-state.json` file records every publish in the current run. Killing and restarting the backfill picks up where it left off — items already in `posted.jsonl` are filtered at plan time, items recorded in the resume state are skipped with `skip-already-published-in-run`. The state file is removed on clean completion.
- Telegram-on-publish guarantee from the project's non-negotiable notify rule is wired into the backfill publish-success branch (same pattern as `publishNextForPair`).
- New regression suite `tests/backfill-regression.js` (12 assertions across 6 async test cases): plan ordering (oldest-first), pagination boundary, local-dedupe filter, mocked destination-dedupe filter, cap enforcement, idempotent restart, interval scheduling math, auth-failure halts the run.

### Added — Telegram-on-publish notifier (parallel landing)

- New `repost-with-agent notify { configure | status | test }` CLI subcommand for setting up a `~/.repost-with-agent/notify.json` file (mode `0600`) or wiring the `REPOST_TELEGRAM_BOT_TOKEN` + `REPOST_TELEGRAM_CHAT_ID` env vars.
- `notifyPublishSuccess()` is called from every publish path right after destination confirmation + `posted.jsonl` write. Failures are logged + audit-recorded but never roll back the publish.
- New `tests/notify-regression.js`.

### Changed

- Bumped `VERSION` to `2.5.0` in both `package.json` and `src/index.ts`.

## v2.3.0 — 2026-05-01

- Deterministic per-tick `pair scheduled-run <id>` runner with min-delay enforcement.
- `pair schedule <id>` renders launchd plist + crontab line + OpenClaw cron command + direct shell invocation.
- `pair edit`, `pair unschedule` CLI commands.

## v2.2.0 — 2026-04-30

- First end-to-end live `pair post --approve` test — published to https://x.com/REEEthan_YT/status/2050303942857310541.

## Earlier

- Pair-based architecture, source/destination adapters, dedupe layer, audit log, Playwright LinkedIn scrape.
