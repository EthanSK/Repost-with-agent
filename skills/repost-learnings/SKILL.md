---
name: repost-learnings
description: Read + write the per-pair learnings.md file so the running agent builds up institutional knowledge over time and doesn't re-figure the same platform quirks every run. Use as a reference when running, backfilling, or showing a pair — and whenever you discover a quirk worth saving.
when_to_trigger: Another skill (`repost-run`, `repost-backfill`, `repost-listen-for-future-setup`, `repost-pair-show`) is about to start a run and needs to load prior learnings, OR the running agent just discovered a quirk / gotcha mid-run that should be remembered for next time.
---

# Repost Learnings

The agent maintains a free-form Markdown file at
`~/.repost-with-agent/pairs/<id>/learnings.md` that accumulates platform
quirks, account-specific gotchas, and DOM observations across runs. This is
the project's institutional-memory file: every run reads it up-front and
appends to it on exit.

> **Why this exists.** Without it, every cron tick re-figures the same DOM
> change / shortener-redirect quirk / rate-limit pattern from scratch. The
> learnings file is how the agent gets smarter at running this specific pair
> over time. (Ethan voice 6029, 2026-05-01: "Have instructions so the agent
> keeps a learnings.md file that makes it easier for subsequent things to
> happen faster, like weird quirks or stuff. So it doesn't have to figure it
> out every single time from scratch.")

This skill is a reference, not a top-level slash-command target. Other skills
link to it.

## Lifecycle

1. **Start of every run** (`repost-run`, `repost-backfill`, the cron-spawned
   subagent): Read `~/.repost-with-agent/pairs/<id>/learnings.md` if it
   exists. Treat it as up-front context — quirks to be aware of before you
   start scraping or composing. **Prioritize the most-recent entry's
   `### Selectors` and `### Step playbook` sub-sections — try those
   verbatim FIRST, before falling back to the platform's general
   `docs/destinations/<platform>.md` hints.** When a cached selector
   fails (DOM has shifted again), that's itself worth recording as a new
   entry at the end of this run with updated mechanics.
2. **During execution**: if you encounter a quirk, gotcha, or unexpected
   DOM / behavior, capture it as a draft note (in your reasoning, or in a
   scratch variable). Don't append to the file mid-run if you can avoid it —
   batch the writes at the end so a crash doesn't corrupt the file with a
   half-written entry.
3. **End of run**: Append any newly-discovered quirks to `learnings.md` with
   a timestamp + brief description. Use `>>` via Bash to be safe (append
   only — never rewrite existing entries).
4. **Stale-learning pruning**: if a learning is contradicted by a fresh
   observation (e.g., "Bluesky's compose button moved BACK to top-right"),
   append a NEW entry rather than editing the old one, but in the heading of
   the new entry mark the older one as superseded. Update the older entry's
   heading to add `[obsoleted YYYY-MM-DD]` — that's the only edit allowed
   to historical entries. Don't delete history; only annotate.

## File format

Plain Markdown. Top-of-file heading is `# <pair-id> learnings`. Each entry
is an `##` heading with the format:

```
## YYYY-MM-DD HH:MM — <one-line summary>

<2–5 sentences of free-form prose: what you saw, why it matters,
implication. Keep this short — the actionable "do this next time" detail
goes into the optional structured sections below, not into the prose.>

### Selectors  (optional)
- <element label>: `<CSS selector or accessibility path>` (<platform>, <where in flow>)
- ...

### Step playbook  (optional)
1. <imperative step using the selectors above>
2. ...

### Quirks  (optional)
- <one-line description of an edge case, race condition, or "skip if X">
- ...
```

Obsoleted entries get a suffix on the heading:

```
## 2026-04-15 09:30 — Bluesky compose button is in the sidebar [obsoleted 2026-05-12]
```

The prose paragraph stays free-form Markdown (inline code, bullet lists,
small snippets are all fine). The three `###` sub-sections are OPTIONAL,
appended only when relevant — but **strongly preferred** for any entry
that captures actionable mechanics, because they give the next run a
recipe to follow instead of mechanics to re-discover.

### Why the structured sections exist

Free-form prose is good for context ("LinkedIn moved the button"); it's
bad for mechanics ("here's the exact selector + click order to use next
time"). Splitting them lets future runs **grep + skim** for the actionable
parts without re-reading every prose paragraph. (Ethan voice 6083,
2026-05-01: "Make sure the reposting, the instructions for the learning
also say to add like selectors so it's just easier next time to quickly
follow the steps that they're having to figure out from scratch because
that saves a lot of time.")

### Section guidance

- **`### Selectors`** — one bullet per element. Format:
  `` `<label>`: `<selector>` (<platform>, <where>) ``. Use whatever
  selector form your browser MCP can re-use (CSS, ARIA path, text-based
  locator). When in doubt, prefer ARIA / role-based selectors — they
  survive cosmetic redesigns better than class chains.
- **`### Step playbook`** — numbered imperative steps that REFERENCE
  the selectors above by their label (not by re-quoting the selector
  string). The next run reads the playbook top-to-bottom and tries the
  steps verbatim FIRST, falling back to the platform's general
  `docs/destinations/<platform>.md` only when a step fails.
- **`### Quirks`** — one-liners for edge cases that don't fit a step
  ("skip reposts that have a 'Reposted by' header", "modal sometimes
  needs a 200ms sleep before accepting input", "scroll past the 60th
  item triggers a 'You're caught up' footer"). Anything the next run
  needs to *guard against* but that isn't a positive step.

Omit any section that has no content — don't write empty `### Selectors`
or "n/a" placeholders. An entry with only prose is still valid (e.g., a
behavioral observation that has no actionable selector yet).

## What to write down

**Save it** (signal):

- Persistent DOM changes — selectors that moved, buttons that were renamed,
  modals that no longer auto-focus.
- Pagination quirks specific to this account or platform — "LinkedIn
  recent-activity caps at ~100 historical posts for me", "X timeline
  unmounts off-screen tweets after the 5th scroll".
- Shortener / URL-expansion edge cases — "lnkd.in sometimes redirects to a
  login wall; fall back to the canonicalUrl in that case".
- Account-specific patterns — "this LinkedIn account auto-tags all
  reshares with `#repost`; strip that tag before mirroring to X".
- Rate-limit signatures — "destination starts returning 429-modal after
  ~3 posts in 10min from this account".
- Quirks of the destination dedupe — "X's `t.co` rewrites cause our
  dedupe-by-prefix to miss; we already strip URLs but watch for new
  shortener domains".
- Per-platform timing — "LinkedIn share modal needs 800ms after first
  `keydown` before it accepts more input".

**Don't save it** (noise):

- One-off transient errors that resolved on retry (`net::ERR_TIMEOUT`,
  random 503s).
- Anything already documented in `docs/destinations/<platform>.md` —
  that's the platform-default; the learnings file is for *deltas* off the
  default.
- Generic "the run succeeded" summaries — the audit log already covers
  that.
- Anything you're not at least 75% sure is reproducible. If it might be a
  one-off, leave it out; you can add it later if you see it again.
- Secrets, tokens, cookies, session data — never. The file is `0644`.

## Good entry example (with all three structured sections)

```markdown
## 2026-05-12 14:22 — LinkedIn recent-activity pagination cap dropped to ~60

Backfill run hit the end of `/recent-activity/all/` after ~60 posts loaded
(was ~100 in the docs). Scrolled 8× and got a "You're caught up" footer
instead of more posts. Likely a LinkedIn-side change. Treat the footer as
a hard stop and emit `pair.fetch.exhausted` rather than retrying.

### Selectors
- Profile feed list: `main ul.feed-shared-update-list` (linkedin, source scrape)
- Each post item: `ul.feed-shared-update-list > li` (linkedin, source scrape)
- Post permalink anchor: `a.update-components-actor__meta-link[href*="/feed/update/"]` (linkedin, per-post)
- Reposted-by header (skip these): `[data-test-reshared-mini-update-v2-header]` (linkedin, per-post)
- "You're caught up" footer: `div[data-finite-scroll-hotkey-context="FEED"] >> text="You're all caught up"` (linkedin, end-of-feed marker)
- Compose modal textbox: `div[role="textbox"][contenteditable="true"]` (linkedin, share modal)
- Compose modal Post button: `button.share-actions__primary-action` (linkedin, share modal)

### Step playbook
1. Navigate to `<source.url>` (`/in/<handle>/recent-activity/all/`).
2. Wait for `Profile feed list` to render.
3. Scroll the feed container 1× and wait 600ms for new items to mount.
4. For each visible `Each post item`:
   - If it contains a `Reposted-by header`, SKIP it (don't repost others' content).
   - Else extract `Post permalink anchor`'s `href` (canonical URL) + the post body text.
5. Repeat scroll until either (a) you have ≥ `--max` non-duplicate candidates, or
   (b) the `"You're caught up" footer` appears — that's a hard stop.
6. Filter the collected candidates against `posted.jsonl` (local dedupe).

### Quirks
- LinkedIn virtualizes the feed aggressively — scrape posts as you scroll, do not
  rely on all loaded posts staying in the DOM.
- `lnkd.in` shorteners in the post body must be expanded via `repost-url-expand`
  before publish, but during scrape leave them as-is (don't resolve mid-scrape).
- Backfill `--max` over ~60 will silently stop early once the footer appears;
  the fetch loop should treat that as exhaustion, not failure.
```

The prose at the top gives context. The selectors give the next run a
ready-made reference. The playbook gives a recipe the next run can follow
verbatim. The quirks block surfaces edge cases that don't fit a step.

Note that this entry intentionally **DUPLICATES some material** (selectors)
that's also in `docs/destinations/linkedin.md`. That's fine: the per-pair
file wins on conflict (it reflects the most-recent observed behavior),
and having the selectors in one grep-able place per pair beats forcing
the next run to cross-reference two files.

## Bad entry examples (do NOT write entries like these)

### Heartbeat (zero signal)

```markdown
## 2026-05-12 14:25 — Run worked

The run succeeded. Posted 1 item from LinkedIn to X. Telegram confirmed.
Nothing weird happened.
```

Why it's bad: zero signal. The audit log already records
`pair.publish.success` + `pair.publish.notify.success`. A future run gains
nothing from reading this entry.

### Vague prose with no actionable mechanics

```markdown
## 2026-05-12 14:25 — LinkedIn was being slow today

The compose modal took a while to open. Eventually it worked.
```

Why it's bad: no selector, no timing number, no step. The next run can't
do anything with "a while". If the issue was reproducible, the entry
should pin down the selector that was slow, the rough delay observed, and
add a `### Step playbook` step that adds a sleep there.

If a run was uneventful — write nothing. The file is for actionable
deltas, not heartbeats. **Entries without selectors / step playbooks / or
a sharply-described quirk are still considered low-value** even when
they're not pure heartbeats: free-form "the page was weird" prose is
what we're trying to avoid. Either pin down the actionable detail or
skip the entry.

## Append snippet (Bash)

Minimum (prose-only entry):

```bash
PAIR_ID="<id>"
LEARNINGS="$HOME/.repost-with-agent/pairs/$PAIR_ID/learnings.md"
TS="$(date -u +'%Y-%m-%d %H:%M')"
SUMMARY="<one-line summary>"
{
  printf '\n## %s — %s\n\n' "$TS" "$SUMMARY"
  printf '%s\n' "<2–5 sentences of prose.>"
} >> "$LEARNINGS"
```

Full (with structured sections — preferred whenever the entry has
actionable mechanics):

```bash
PAIR_ID="<id>"
LEARNINGS="$HOME/.repost-with-agent/pairs/$PAIR_ID/learnings.md"
TS="$(date -u +'%Y-%m-%d %H:%M')"
SUMMARY="<one-line summary>"
{
  printf '\n## %s — %s\n\n' "$TS" "$SUMMARY"
  printf '%s\n\n' "<2–5 sentences of prose: what you saw, why it matters, implication.>"

  printf '### Selectors\n'
  printf -- '- <label>: `<selector>` (<platform>, <where>)\n'
  printf -- '- ...\n\n'

  printf '### Step playbook\n'
  printf '1. <imperative step using the selectors above>\n'
  printf '2. ...\n\n'

  printf '### Quirks\n'
  printf -- '- <one-line edge case>\n'
} >> "$LEARNINGS"
```

Omit any `###` block that has no content rather than writing it empty.

Always use `>>`. Never rewrite the file. The only allowed edit to historical
entries is appending `[obsoleted YYYY-MM-DD]` to a heading — and even that
should be a targeted `Edit` call, not a rewrite of the file.

## Obsoleting a prior entry

When a fresh observation contradicts an older one:

1. Find the older entry's heading.
2. Use the `Edit` tool to add ` [obsoleted YYYY-MM-DD]` at the end of the
   heading. Don't touch the body.
3. Append a NEW entry at the bottom describing the fresh observation. Mention
   the older entry's date in the body (`Supersedes the 2026-04-15 entry.`).

This keeps a clean audit trail — future agents can see WHEN the platform
behavior changed, not just the latest state.

## Initial placeholder

The first time a pair has no learnings yet, the file should still exist as a
placeholder so the agent doesn't have to test for existence every run:

```markdown
# <pair-id> learnings

_No learnings recorded yet — the agent will append entries as it discovers
quirks during runs._
```

See `templates/learnings.md.template` for the canonical shape.

## See also

- `skills/repost-run/SKILL.md` — single-post flow that reads + writes learnings.
- `skills/repost-backfill/SKILL.md` — multi-post flow that batches learnings.
- `skills/repost-pair-show/SKILL.md` — surfaces recent learnings in pair output.
- `skills/repost-history/SKILL.md` — optional learnings tail.
- `docs/state-files.md` — formal state-file schemas (learnings.md is in there).
- `templates/learnings.md.template` — the placeholder shape.
