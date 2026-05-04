---
name: repost-run
description: Run a single Repost-with-agent pair end-to-end — scrape source, dedupe (local + destination), expand URLs, publish via the user's logged-in browser, append history, and Telegram-confirm Ethan. Use when the user asks to "run pair <id>", "post the latest from <pair>", "tick the <pair-id> pair", or invokes /repost-run. Also invoked by scheduled agents for listen-for-future pairs.
when_to_trigger: User wants to run a single pair manually, OR a scheduled subagent is ticking a listen-for-future pair, OR the user asks to "post the next one from <pair>". Single-post operation.
---

# Repost Run

You are the running agent. This skill instructs you how to do ONE end-to-end
repost: pick the next non-duplicate item from the source, expand any shortened
URLs, post it via the user's logged-in browser, append history, and Telegram-
confirm.

For multi-post historical walks, see `skills/repost-backfill/SKILL.md` instead.

## Required tools

You MUST have these available in the current session:

- **Read, Edit, Write, Bash** — built-in.
- **Native browser automation in the current harness** — for example OpenClaw's
  built-in browser, `chrome-devtools-mcp` when the current harness is Claude
  Code, or another explicit browser adapter. Used to navigate, scrape, and
  click. Do not hand the run to Claude Code merely because Claude Code is one
  supported harness; the current agent owns the run unless Ethan explicitly
  asks for a different harness.
  - **OpenClaw hard rule:** when this workflow is running in OpenClaw, use
    OpenClaw's own browser/profile (`profile: openclaw`, CDP port `18800`). Do
    **not** use Ethan's personal browser, Chrome relay, or `profile="user"`
    for Repost-with-agent unless Ethan explicitly overrides this for a specific
    run.
- **Telegram/message delivery in the current harness** — OpenClaw should use
  its first-class `message` tool / Telegram channel; Claude Code should use
  `plugin:telegram:telegram`; other harnesses should use their equivalent
  configured Telegram delivery path. If no Telegram/message delivery path is
  loaded in this session, surface the error and stop — do not silently skip the
  confirmation.

If any of these is missing, tell the user which one and stop. Don't try to
substitute curl/Playwright/etc.

## Step 1 — Load pair config

1. Read `~/.repost-with-agent/pairs.json`.
2. Find the requested pair by `id`. If not found, list available ids and stop.
3. Verify `pair.enabled === true`. If false, tell the user the pair is
   disabled and stop.
4. Note `mode`, `runMode`, `source`, `destination`, `policy.maxItemsPerRun`
   (default 1), `policy.overlengthStrategy` (default `"skip"`),
   `policy.blockOnUncertainDuplicate` (default true).
5. Note optional destination identity fields:
   - `destination.targetType` (`profile`, `page`, or `group`; default `profile`).
   - `destination.accountDisplayName` (visible account/page name to verify).
   - `destination.accountHint` (handle / vanity path). These fields are
     especially important on Facebook and Meta surfaces where one login can
     post as multiple identities.

## Browser tab reuse rule

Reuse the current harness browser's existing tabs whenever possible.

Before navigating for source scrape, destination dedupe, or compose:

1. List / inspect open browser tabs using the current harness browser adapter.
2. If an existing tab is already on the same platform origin, profile URL, or
   compose surface you need, focus that tab and navigate / refresh it in place.
3. Only open a new tab when no suitable existing tab exists.
4. Do not leave repeated duplicate login/profile/compose tabs behind on
   scheduled runs.

This matters because scheduled ticks should behave like a careful human reusing
the same browser session, not a process that opens the same platform from
scratch over and over.

## Step 1.5 — Read pair learnings (institutional memory)

Read `~/.repost-with-agent/pairs/<id>/learnings.md` if it exists. Treat the
file as up-front context — it accumulates platform quirks, account-specific
DOM changes, pagination caps, and rate-limit signatures the agent has
discovered on prior runs.

**Priority order — read this carefully:**

1. **First, scan the most-recent entry's `### Selectors` and `### Step
   playbook` sub-sections.** Those are a recipe the prior run already
   verified worked. Use them VERBATIM in steps 3 (scrape) and 8 (publish)
   below — they save the most time when correct, because you don't have
   to re-discover the platform's DOM from scratch.
2. **Second, scan the entry's `### Quirks` block** for edge cases to
   guard against (e.g. "skip reposts that have a 'Reposted by' header",
   "modal needs 200ms sleep before accepting input", "scroll past 60th
   item triggers 'You're caught up' footer"). These usually wrap or
   gate the playbook steps.
3. **Third, scan older entries** for any superseding context the most
   recent entry references (`Supersedes the YYYY-MM-DD entry.`).
4. **Fall back to `docs/destinations/<platform>.md` ONLY when learnings.md
   is silent on the step you're about to do**, OR when a cached selector
   from learnings.md fails to match the live DOM (the platform changed
   again).

When a cached selector / step FAILS, that's a new quirk worth recording
in the **Final step** below — treat the failure as evidence the DOM has
shifted again, and capture the updated mechanics.

If the file doesn't exist or contains only the placeholder stub, proceed
using `docs/destinations/<platform>.md` defaults — and seed the file with
selectors + a step playbook as you discover what works during this run.

Examples of what you might find in a learnings.md entry:

- A `### Selectors` block listing the actual CSS selectors that worked
  for the share modal textbox + Post button on the user's account.
- A `### Step playbook` numbering the click-and-wait sequence the prior
  run used to publish successfully.
- A `### Quirks` block flagging "Bluesky's compose button moved from the
  top-right `+` to a sidebar 'New post' button on mobile-narrow viewports"
  or "X's profile-page recent-posts require scrolling 4× before old
  posts appear".

Track newly-discovered quirks in your reasoning (don't append mid-run; batch
the writes at the **Final step** below to avoid corrupting the file on a
crash). Full rules + entry shape: `skills/repost-learnings/SKILL.md`.

## Step 2 — Decide what we're allowed to do

- If `mode === "preview-only"`: do steps 3–5 (scrape + show draft) but STOP
  before publish. Tell the user what we would have published.
- If `mode === "approval-required"`: do steps 3–6, then ASK the user to
  authorize the post explicitly in chat. Only proceed if they say yes in this
  same conversation.
- If `mode === "live-approved"`: do everything end-to-end. This is the only
  mode the scheduled agent should encounter (the install skill refuses
  to schedule non-live-approved pairs).

## Step 3 — Scrape the source

Use your current-harness browser automation. Per-platform DOM hints live in
`docs/destinations/<platform>.md` — read the matching one before you start.

For platform `linkedin`:

1. Navigate to `pair.source.url` (typically `https://www.linkedin.com/in/<handle>/recent-activity/all/`).
2. Wait for the feed to render. Scroll 1–2 times to load ~10 recent posts.
3. For each post, extract:
   - `sourceItemId` — the activity URN (`urn:li:activity:NNNNNNNN`) parsed
     from the post's data attributes or the canonical URL fragment.
   - `canonicalUrl` — the full `https://www.linkedin.com/feed/update/<urn>/` URL.
   - `text` — the visible post body, in reading order.
   - `publishedAt` — the relative timestamp resolved to ISO-8601.

For platform `x` / `bluesky` / `threads` / `facebook`: see the matching
`docs/destinations/<platform>.md`.

If the page shows a logged-out indicator (login modal, "sign in to continue"
CTA), STOP and tell the user "needs-login on <platform>". Do not try to log
in.

## Step 4 — Layer 1 dedupe (local + destination, exact + fuzzy-string match)

Use the `repost-dedup` skill semantics. This is **Layer 1** — cheap string
ops that catch verbatim and near-verbatim re-posts.

1. **Local dedupe.** Read `~/.repost-with-agent/pairs/<id>/posted.jsonl`
   (line-delimited JSON, may be empty). For each candidate from step 3, drop it
   if its `sourceItemId` already appears in any line.
2. **Destination dedupe.** Use your current-harness browser automation to navigate to
   `pair.destination.profileUrl`. Scroll to load ~50–100 recent posts. **Keep
   this scrape in your reasoning** — Layer 2 (step 4.5) reuses it. For each
   *remaining* candidate, fuzzy-match the candidate text against the scraped
   destination posts:
   - Normalize: collapse whitespace, lowercase, strip trailing punctuation,
     strip URLs (X / Bluesky rewrite URLs into shortened aliases that won't
     match the source).
   - Match: exact-normalized OR ≥80-char prefix overlap → duplicate.
3. If `policy.blockOnUncertainDuplicate === true` and you cannot positively
   determine for any reason (page failed to load, content was paywalled,
   etc.), treat the candidate as "uncertain" and SKIP it (do not publish).

## Step 4.5 — Layer 2 dedupe (semantic similarity, agent reasoning)

Use the `repost-dedup-semantic` skill. This is **Layer 2** — your own
semantic judgment over the candidate vs. the destination scrape from step 4.
Catches paraphrased duplicates that Layer 1's string-match cannot
("essentially the same announcement / opinion / claim, different words").

> Ethan voice 6106 (2026-05-01): *"It should make sure the agent actually
> semantically looks and processes the content of the message and checks the
> target destination and sees if there's a post with similar wording already
> there... that'll be embarrassing."*

1. Check `pair.policy.semanticDedupeEnabled` (default `true`). If `false`,
   skip Layer 2 entirely and go to step 5 — the user explicitly opted out.
2. Take the most-recent `pair.policy.semanticDedupeWindowSize` (default 30)
   destination posts from the step 4 scrape.
3. For each candidate that survived Layer 1, ask yourself: *"Would a reader
   who has already seen any of these existing posts find this candidate
   redundant?"* Apply the worked examples in `skills/repost-dedup-semantic/SKILL.md`
   (announcements, opinions, claims with the same communicative function →
   skip; same theme but different specifics or different communicative
   function → proceed).
4. **Lean conservative.** When on the fence, skip — Ethan would rather miss
   a post than ship an embarrassing paraphrased duplicate.
5. If you decide **semantic-duplicate**: append a
   `pair.publish.semantic_duplicate` audit event with
   `{candidateExcerpt, matchedExistingUrl, matchedExistingExcerpt,
   agentReasoning, windowSize}`, append a catch-up entry to `posted.jsonl`,
   and drop the candidate from the publish set. (See
   `skills/repost-dedup-semantic/SKILL.md` for the full audit shape.)
6. If you decide **semantic-unique**: proceed to step 5.

Layer 2 is OPTIONAL but RECOMMENDED — it's enabled by default. A candidate
must clear BOTH Layer 1 and Layer 2 before it's eligible for publish.

## Step 5 — Pick the next item

Filter to items NOT marked as duplicates by step 4. If none remain, write a
`pair.run.no_new_items` line to `~/.repost-with-agent/pairs/<id>/audit.jsonl`
and stop. Tell the user "No new posts to repost from <pair>."

If items remain, pick the **newest** one (highest `publishedAt`). For backfill
runs, see `skills/repost-backfill/SKILL.md`.

## Step 6 — Expand URLs in the draft

Use the `repost-url-expand` skill semantics:

1. Find every URL in the candidate text via regex.
2. For each URL whose host is in the shortener list (`lnkd.in`, `t.co`,
   `bit.ly`, `buff.ly`, `goo.gl`, `tinyurl.com`, `ow.ly`, `is.gd`, `rebrand.ly`,
   `tr.im`), or any URL that returns a 30x: follow redirects up to 5 hops with
   a 5-second timeout per hop using `curl -sIL --max-time 5 -o /dev/null -w '%{url_effective}'` via Bash.
3. Substitute the resolved URL into the draft.
4. If expansion fails for any URL: keep the original (fail-soft). Append
   `pair.publish.url_expand_failed` to audit with the error.
5. Append a `pair.publish.url_expanded` audit event per successful expansion.

Do **not** append the source platform's canonical URL to the public draft.
The destination post should read like a fresh native post on that destination,
not like a cross-post receipt. Keep the source canonical URL only in
`posted.jsonl`, audit events, and the Telegram confirmation.

If the source body contains URLs, expand/resolve them to the non-source-platform
final URL before publishing (for example `lnkd.in` / LinkedIn safety redirect →
the underlying article or video URL). Do not leave LinkedIn wrapper URLs in an X
post unless the LinkedIn URL itself is the intended content.

## Step 7 — Length check

Look up the destination char cap (X = 280 default, X Premium = 25 000, Bluesky
= 300, Threads = 500, LinkedIn = 3 000, Facebook = 63 206). See
`docs/destinations/<platform>.md`.

If the draft exceeds the cap:

- `policy.overlengthStrategy === "skip"`: append a `pair.publish.skipped_overlength` audit event and stop. Tell the user.
- `policy.overlengthStrategy === "truncate"`: shrink to fit the destination
  cap without adding a source-platform backlink. Append `pair.publish.truncated`
  audit.

## Step 8 — Publish

This is where the running agent drives the user's logged-in browser.

1. Reuse an existing destination tab if one is already open; otherwise navigate
   to the destination's compose URL (see `docs/destinations/<platform>.md`).
2. Verify the active posting identity matches the pair config BEFORE typing:
   - Match `destination.accountHint` and/or `destination.accountDisplayName`.
   - Respect `destination.targetType` (`profile`, `page`, `group`).
   - If the platform exposes a profile/page/account switcher, switch to the
     configured identity first.
   - If you cannot confirm or switch to the configured identity, append
     `pair.publish.failed` with `category: "needs-account-switch"`, tell Ethan,
     and stop. Do not publish from the wrong profile/page.
3. Wait for the textarea / contenteditable.
4. Click into it.
5. Type the draft EXACTLY. Don't paraphrase, don't add hashtags.
6. Click the Post / Share / Tweet button.
7. Wait for the success indicator (URL changes, modal dismisses, toast appears).
8. Capture the resulting `posted_url` (e.g. `https://x.com/<handle>/status/<id>`).
   - For X: the URL changes to `/status/<id>` after posting. Read it from the page.
   - For Bluesky: the toast or feed shows the new post; navigate to your
     profile and grab the topmost post URL.
   - For LinkedIn / Threads / Facebook: see per-platform docs.

If publish fails (login expired, rate limit, platform error):

- Append `pair.publish.failed` audit with `category: "needs-login" | "rate-limit" | "platform-error" | "unknown"`.
- Tell the user what happened.
- Telegram Ethan with the failure using the current harness's Telegram/message delivery tool.
- DO NOT append to `posted.jsonl` (we did not actually post).

## Step 9 — Append history

Append to `~/.repost-with-agent/pairs/<id>/posted.jsonl` ONE line of JSON:

```json
{"ts":"2026-05-01T12:00:00Z","sourceItemId":"urn:li:activity:7000","canonicalSourceUrl":"https://www.linkedin.com/feed/update/urn:li:activity:7000/","destinationUrl":"https://x.com/REEEthan_YT/status/123","destinationId":"123","draftText":"<the exact text we posted>"}
```

Append (DO NOT overwrite). Use `>>` via Bash to be safe:

```bash
echo '<json-line>' >> ~/.repost-with-agent/pairs/<id>/posted.jsonl
```

Append `pair.publish.success` to `audit.jsonl` with the `posted_url`.

## Step 10 — Telegram-confirm Ethan (non-negotiable)

> Every successful post from this plugin MUST trigger a Telegram message to
> Ethan confirming the source and destination URL. Silent publishes are a bug.
> (Ethan voice 5977 + 5978, 2026-05-01.)

Use the current harness's Telegram/message delivery tool (OpenClaw `message`, Claude Code `plugin:telegram:telegram` reply, or equivalent). Message format:

```
[Repost-with-agent] ✅ Posted: <pair-id>
Source: <canonical source URL>
→ Destination: <destination URL>
```

If the Telegram send fails:

- Append `pair.publish.notify.failure` audit with the error.
- Tell the user in chat (so the missed ping is replaced).
- DO NOT roll back the post — it's already up.

If you reach this step and Telegram is unconfigured / unavailable, append
`pair.publish.notify_skipped_unconfigured` audit. Treat that as an alert: the
plugin shipped a silent publish. Tell the user immediately.

See `skills/repost-notify/SKILL.md` for the Telegram payload spec.

## Step 11 — Final summary

Print to the user (in the agent transcript, NOT Telegram):

```
✅ Reposted from <pair-id>
  Source:      <canonical source URL>
  Destination: <destination URL>
  Posted at:   <ts>
  Telegram:    delivered
```

## Final step — Append discovered quirks to learnings.md

Before exiting, flush any quirks you tracked during this run to
`~/.repost-with-agent/pairs/<id>/learnings.md`. Use `>>` via Bash —
append-only. Each entry uses the structured shape:

```
## YYYY-MM-DD HH:MM — <one-line summary>

<2–5 sentences of prose: what you saw, why it matters, implication.>

### Selectors          (optional — STRONGLY preferred when you have any)
- <label>: `<selector>` (<platform>, <where in flow>)

### Step playbook     (optional — STRONGLY preferred when you have any)
1. <imperative step using the selectors above>
2. ...

### Quirks            (optional)
- <one-line edge case>
```

The `###` sub-sections are optional but **strongly preferred** whenever
you have actionable mechanics — they let the next run grep + skim for
selectors and follow your playbook verbatim instead of re-discovering
the DOM. If a cached selector from a prior entry FAILED in this run,
record the new working selector in your `### Selectors` block and add a
quirk like `Supersedes the YYYY-MM-DD entry — DOM moved.` (and edit the
older entry's heading to add ` [obsoleted YYYY-MM-DD]`).

If a fresh observation contradicts an older entry, do NOT delete the older
one. Use `Edit` to add ` [obsoleted YYYY-MM-DD]` to the older heading, then
append a new entry at the bottom that mentions which prior entry it
supersedes.

If nothing weird happened — write nothing. The file is for deltas, not
heartbeats. See `skills/repost-learnings/SKILL.md` for the full
"signal vs noise" rules + the good/bad entry example showing all three
optional sub-sections.

## Scheduled-run context

When invoked from a fresh agent/subagent spawned by the scheduler:

- The subagent has no chat user. All interactive prompts above are skipped — it
  just runs the pair end-to-end if `mode === "live-approved"`.
- It must still Telegram-confirm Ethan via the current harness's Telegram/message delivery tool.
- It must still append to `posted.jsonl` and `audit.jsonl`.
- After running, the agent exits. The next scheduled tick spawns a fresh agent/subagent.

## Error categories

When you hit a failure, append the appropriate audit event and tell the user
which category:

- `needs-login` — destination or source session expired. User must log in via
  the current harness browser profile, then re-run.
- `needs-config` — Telegram not configured, pair config missing required field, etc.
- `rate-limit` — destination platform rejected with a 429 or rate-limit modal.
  Wait and retry later.
- `platform-error` — destination platform error not in the above categories.
  Capture the error text and audit it.
- `unknown` — anything else. Tell the user what you saw.

## See also

- `skills/repost-dedup/SKILL.md` — Layer 1 dedupe (exact + fuzzy string match).
- `skills/repost-dedup-semantic/SKILL.md` — Layer 2 dedupe (agent semantic reasoning).
- `skills/repost-url-expand/SKILL.md` — URL expansion details.
- `skills/repost-notify/SKILL.md` — Telegram payload spec.
- `skills/repost-learnings/SKILL.md` — pair-level institutional-memory file.
- `skills/repost-backfill/SKILL.md` — multi-post historical walks.
- `docs/destinations/<platform>.md` — per-platform DOM hints.
- `docs/state-files.md` — formal state-file schemas.
