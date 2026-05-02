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
   start scraping or composing.
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

<2–5 sentences of detail. What you saw, why it matters, what to do about it
next time. Be specific about DOM selectors, URLs, or pagination behavior.>
```

Obsoleted entries get a suffix on the heading:

```
## 2026-04-15 09:30 — Bluesky compose button is in the sidebar [obsoleted 2026-05-12]
```

That's all the structure. The body of each entry is free-form Markdown —
inline code blocks, bullet lists, even a small code snippet are all fine.

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

## Good entry example

```markdown
## 2026-05-12 14:22 — LinkedIn recent-activity pagination cap dropped to ~60

Backfill run hit the end of `/recent-activity/all/` after ~60 posts loaded
(was ~100 in the docs). Scrolled 8× and got a "You're caught up" footer
instead of more posts. Likely a LinkedIn-side change.

Implication: backfill `--max` over 60 will silently stop early without an
error. The fetch loop should treat the "You're caught up" footer as a
hard stop and emit `pair.fetch.exhausted` rather than retrying. Already
hits `pair.dedupe.local` cleanly afterward, so no duplicate publishes —
but the user should be told the actual count if they asked for more.
```

## Bad entry example (do NOT write entries like this)

```markdown
## 2026-05-12 14:25 — Run worked

The run succeeded. Posted 1 item from LinkedIn to X. Telegram confirmed.
Nothing weird happened.
```

Why it's bad: zero signal. The audit log already records `pair.publish.success`
+ `pair.publish.notify.success`. A future run gains nothing from reading this
entry. A learnings file full of "nothing weird happened" entries actively
slows future runs because the agent has to read past the noise to find the
real quirks.

If a run was uneventful, write nothing. The file is for deltas, not
heartbeats.

## Append snippet (Bash)

```bash
PAIR_ID="<id>"
LEARNINGS="$HOME/.repost-with-agent/pairs/$PAIR_ID/learnings.md"
TS="$(date -u +'%Y-%m-%d %H:%M')"
SUMMARY="<one-line summary>"
{
  printf '\n## %s — %s\n\n' "$TS" "$SUMMARY"
  printf '%s\n' "<2–5 sentences of detail.>"
} >> "$LEARNINGS"
```

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
