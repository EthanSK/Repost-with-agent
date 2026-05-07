---
name: repost-run
description: Run Repost-with-agent for one pair, all enabled pairs, or an explicit subset — scrape source, dedupe (local + destination), expand URLs, publish when allowed, append history, and notify the user. Use when the user asks to "run pair <id>", "post the latest from <pair>", "tick the <pair-id> pair", "run all pairs", or invokes /repost-run. Also invoked by scheduled agents for listen-for-future pairs.
when_to_trigger: User wants to run one pair manually, an all-pairs sweep, a scoped subset, OR a scheduled subagent is ticking listen-for-future pairs.
---

# Repost Run

You are the running agent. This skill instructs you how to run Repost-with-agent
for a requested scope: one pair, `all`, or an explicit subset. For each pair in
scope, pick the next non-duplicate item from the source, expand any shortened
URLs, post only when the requested mode and pair safety mode allow it, append
history, and notify the user via configured delivery.

The default scheduled scope is `all`: one fresh agent sweeps every enabled
`listen-for-future` pair sequentially. Live jobs publish only `live-approved`
pairs; preview/dry jobs never publish. Custom scheduler jobs may run one pair,
a named subset, or a dry/preview sweep. Honor those requests without treating
the default all-pairs sweep as the only valid architecture.

For multi-post historical walks, see `skills/repost-backfill/SKILL.md` instead.
For scheduled/source-level backfill slots, `skills/repost-source-fanout/SKILL.md`
is the unit of work: one source item across all enabled destinations before the
slot moves on.

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
- **User-facing message delivery in the current harness** — read
  `notification.delivery` from `~/.repost-with-agent/pairs.json` and map it to
  the harness's message tool (OpenClaw `message`, Claude Code's configured
  channel tool, Slack/Discord/etc. equivalents). If no delivery route/tool is
  loaded in this session, surface the error and stop — do not silently skip the
  confirmation.

If any of these is missing, tell the user which one and stop. Don't try to
substitute curl/Playwright/etc.

## Step 1 — Load pair config and resolve scope

1. Read `~/.repost-with-agent/pairs.json`.
2. Resolve the requested scope:
   - `<pair-id>` → exactly that pair. If not found, list available ids and stop.
   - `all` → every pair where `enabled === true` and `runMode === "listen-for-future"`.
   - explicit subset/natural-language scheduler prompt → the named pair ids or
     exact criteria in the prompt. If ambiguous, stop and ask in interactive
     sessions; scheduled agents should fail closed with a clear transcript.
3. For each scoped pair, verify `pair.enabled === true`. If false, skip it in
   all/subset sweeps or stop for a single-pair request.
4. Note `mode`, `runMode`, `source`, `destination`, `customRules` (top-level
   and pair-level), `policy.maxItemsPerRun` (default 1),
   `policy.overlengthStrategy` (default `"compact"` for Ethan/OpenClaw),
   `policy.blockOnUncertainDuplicate` (default true), and
   `policy.globalDedupeEnabled` (default true).
5. Note optional destination identity fields. These are **UI matching hints**,
   not an external account registry:
   - `destination.accountDisplayName` — the visible logged-in name/page/profile
     name the agent should see in the browser UI. Prefer this over exact handles
     when Ethan says "use whatever is logged in".
   - `destination.accountHint` — optional loose hint (name, handle, vanity path,
     or page label). Do not treat it as a hard identity id unless Ethan
     explicitly configured an exact handle.
   - `destination.targetType` (`profile`, `page`, or `group`; default `profile`).

If a scope contains multiple pairs, process them sequentially with a small
jittered pause (30–60s) between pairs. Each pair is still a single-post run; use
`repost-backfill` for historical multi-post walks, and use
`repost-source-fanout` when the requested backfill unit is one source item to all
enabled destinations.

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
  before publish. Tell the user what we would have published, and append
  `pair.preview.success` to `audit.jsonl` with the candidate id, canonical
  source URL, draft character count, and `wouldPublish: true`.
- If `mode === "approval-required"`: do steps 3–6, append
  `pair.preview.success`, then ASK the user to authorize the post explicitly
  in chat. Only proceed if they say yes in this same conversation.
- If `mode === "live-approved"`: do everything end-to-end when the current
  request/scheduler job is a live publish job. This is the only mode that may
  publish unattended.

For scheduled preview/dry jobs, stop before publish regardless of pair mode. For
scheduled live jobs, skip any scoped pair that is not `live-approved` rather
than trying to prompt. Approval-required pairs can only publish in an interactive
session where the user explicitly approves the specific post.

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

When scraping, include `mediaTypes` / `mediaEvidence` if the source platform
exposes obvious media signals (video player, Live badge, image alt text, link
card). If media cannot be determined, use `mediaTypes: ["unknown"]` rather than
pretending the post is text-only; custom rules may depend on this.

## Step 3.5 — Apply custom user rules + considered state

Use `skills/repost-custom-rules/SKILL.md` before any dedupe or publish work.

1. Read top-level `customRules` and optional `pair.customRules` from
   `~/.repost-with-agent/pairs.json`. Missing arrays mean no custom rules.
2. Read `~/.repost-with-agent/considered.jsonl` if it exists. Drop candidates
   already recorded as `status: "skipped-rule"` for this source id/URL and
   matching global/pair/destination scope.
3. Evaluate enabled custom skip rules. When a rule matches:
   - append `candidate.custom_rule.skipped` to `considered.jsonl` unless that
     exact skip is already present,
   - append `pair.custom_rule.skipped` to this pair's `audit.jsonl`, and
   - remove the candidate from the publish set.
4. Do NOT append to `posted.jsonl` or `global-posted.jsonl` for a pure
   custom-rule skip. Those files are publish/duplicate proof; custom rules are
   not-post-worthy preference state.

Current Ethan rule to respect if present in config: X source video/livestream
promos matching `vibe coding an ai slop machine #ai #programming #developer`
(rule id `skip-x-ai-slop-machine-videos`) are skipped for future reposts.

## Step 4 — Layer 1 dedupe (local + global + destination)

Use the `repost-dedup` skill semantics. This is **Layer 1** — cheap string
ops plus the global cross-pair ledger that catch verbatim, near-verbatim, and
already-routed reposts.

1. **Local dedupe.** Read `~/.repost-with-agent/pairs/<id>/posted.jsonl`
   (line-delimited JSON, may be empty). For each candidate remaining after step
   3.5, group rows by `sourceItemId` and use the newest live-success verdict.
   Only `posted`, `caught-up`, and `skipped-duplicate` rows with a live
   `destinationUrl`/`destinationId` and no remediation flags prove a duplicate.
   Newer rows such as `deleted-malformed`, `deleted-runaway`,
   `deleted-source-url-leak`, `posted-malformed`, `needs-repost`,
   `needsRemediation: true`, or `event: "global.publish.deleted"` explicitly do
   **not** count as posted proof; they mean repair/repost/skip is still needed.
2. **Global cross-pair dedupe.** Use `skills/repost-global-dedupe/SKILL.md`
   unless `pair.policy.globalDedupeEnabled === false`. Read
   `~/.repost-with-agent/global-posted.jsonl`, resolve the candidate
   `contentKey` (including lineage inheritance from earlier destination URLs),
   and drop it only if the latest same-destination verdict for that `contentKey`
   is live success. Do not treat deleted/malformed/remediation ledger rows as
   duplicates. This is mandatory for routes such as LinkedIn→X→Bluesky plus
   X→Bluesky: whichever path first proves the Bluesky destination has the
   content wins, and the other path skips.
3. **Destination dedupe.** Use your current-harness browser automation to navigate to
   `pair.destination.profileUrl`. Scroll to load ~50–100 recent posts. **Keep
   this scrape in your reasoning** — Layer 2 (step 4.5) reuses it. For each
   *remaining* candidate, fuzzy-match the candidate text against the scraped
   destination posts:
   - Normalize: collapse whitespace, lowercase, strip trailing punctuation,
     strip URLs (X / Bluesky rewrite URLs into shortened aliases that won't
     match the source).
   - Match: exact-normalized OR ≥80-char prefix overlap → duplicate.
4. If `policy.blockOnUncertainDuplicate === true` and you cannot positively
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
   append a matching global ledger catch-up to
   `~/.repost-with-agent/global-posted.jsonl`, and drop the candidate from the
   publish set. (See
   `skills/repost-dedup-semantic/SKILL.md` for the full audit shape.)
6. If you decide **semantic-unique**: proceed to step 5.

Layer 2 is OPTIONAL but RECOMMENDED — it's enabled by default. A candidate
must clear BOTH Layer 1 and Layer 2 before it's eligible for publish.

## Step 5 — Pick the next item

Filter to items NOT removed by custom rules / considered state and NOT marked
as duplicates by step 4. If none remain, write a `pair.run.no_new_items` line
to `~/.repost-with-agent/pairs/<id>/audit.jsonl` and stop. Include a `reason`
such as `"custom-rules"`, `"duplicates"`, or `"no-source-candidates"` when
known, plus `ruleId`, `sourceItemId`, `canonicalSourceUrl`, and
`destinationPlatform` when custom rules caused the skip.

Final transcript shape for a no-new-items run:

```text
No new posts to repost from <pair-id>.
  Reason:      <custom-rules|duplicates|no-source-candidates>
  Rule:        <ruleId or n/a>
  Source item: <sourceItemId or n/a>
  Source URL:  <canonicalSourceUrl or n/a>
```

In scheduled runs, always end with this short non-empty transcript summary (not
a Telegram ping) so the cron run is visibly complete.

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

### Mandatory source URL leak guard

Immediately before composing/publishing, run this fail-closed check against the
final public draft:

1. If `canonicalSourceUrl` is non-empty and appears in the draft, do **not**
   publish.
2. For LinkedIn sources, also block drafts containing LinkedIn source permalink
   markers such as `linkedin.com/feed/update/`, `/posts/`, or
   `urn:li:activity:` unless the source post's own human-visible body clearly
   contains that URL as the content being discussed and the run records an
   explicit `allowSourceUrlInPublicDraft: true` rationale.
3. Rebuild the draft from the source body only, expand any body URLs, and run
   the leak guard again.
4. If the guard still trips, mark the destination `blocked` with category
   `source-url-leak-guard`, write an audit event
   `pair.publish.source_url_leak_blocked`, and do not touch the browser compose
   box.

This guard exists because source canonical URLs belong in state/audit/user
confirmation, not in destination post bodies.

If the source body contains URLs, expand/resolve them to the non-source-platform
final URL before publishing (for example `lnkd.in` / LinkedIn safety redirect →
the underlying article or video URL). Do not leave LinkedIn wrapper URLs in an X
post unless the LinkedIn URL itself is the intended content.

## Step 7 — Length check

Look up the destination char cap (X = 280 default, X Premium = 25 000, Bluesky
= 300, Threads = 500, LinkedIn = 3 000, Facebook = 63 206). See
`docs/destinations/<platform>.md`.

**Destination-wide Ethan rule:** do not pre-compact merely because a local
character count or static cap assumption says the draft might be too long. Many
platforms/accounts expose longer-post modes, and Ethan wants the source text
preserved whenever the live UI accepts it. For every destination, first put the
exact leak-guarded draft into the live composer and inspect the live UI. Only
compact if the UI itself clearly reports overlength/cutoff — for example an
over-limit counter, disabled Post/Share button with overlength feedback, or
visible truncation/cutoff warning. If the destination UI accepts the exact draft,
publish that exact draft.

If the destination UI gives explicit live feedback that the exact draft is
overlength/cut off:

- `policy.overlengthStrategy === "compact"` (Ethan/OpenClaw default): rewrite the draft to fit while making it sound as close to the original as possible and preserving the essence, intent, tone, URLs, and key claims. Do not add a source-platform backlink. Reinsert the compacted draft and confirm the UI no longer shows overlength/cutoff feedback before posting. After compacting, re-run a quick duplicate check against the compacted text. Append `pair.publish.compacted` audit with original length, compacted length, destination UI feedback, and a 1-sentence note. If it still cannot fit without losing the point, append `pair.publish.skipped_overlength` and stop.
- `policy.overlengthStrategy === "skip"`: append a `pair.publish.skipped_overlength` audit event and stop. Tell the user.
- `policy.overlengthStrategy === "truncate"`: mechanically shrink to fit the destination
  cap without adding a source-platform backlink. Append `pair.publish.truncated`
  audit. Prefer `compact` over `truncate` unless Ethan explicitly asks for mechanical truncation.

## Step 8 — Publish

This is where the running agent drives the user's logged-in browser.

1. Reuse an existing destination tab if one is already open; otherwise navigate
   to the destination's compose URL (see `docs/destinations/<platform>.md`).
2. Verify the active posting identity by **visible UI name** BEFORE typing:
   - Match `destination.accountDisplayName` first; use `destination.accountHint`
     only as a loose human hint. The pair is not meant to maintain a separate
     external account identity database.
   - If Ethan asked to use "whatever is logged in", configure the destination to
     the currently visible logged-in name/profile, then match that name in the UI.
   - Respect `destination.targetType` (`profile`, `page`, `group`) only as a UI
     expectation for where the composer appears.
   - If the platform exposes a profile/page/account switcher, switch to the
     visible configured name if available.
   - If no configured/visible name can be confirmed, append `pair.publish.failed`
     with `category: "needs-account-switch"`, capture/report the visible screen,
     and stop. Do not publish from an obviously wrong profile/page.
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
9. **Mandatory live-post text proof gate for every destination:** before
   treating any browser publish as successful, open the captured `posted_url`
   in the browser and verify the live destination post text matches the
   intended `draftText`.
   - Compare the actual post card/text, not the compose box DOM. Normalize only
     harmless platform rendering differences such as repeated whitespace or URL
     wrapper display; do not accept missing paragraphs, duplicated fragments,
     stale editor text, or a different recent post.
   - For X specifically, this gate protects against Draft.js/contenteditable
     desync after interrupted typing. If the live X post says something other
     than the intended draft, the publish is **not** successful even if X
     returned a status URL.
   - For Facebook, also prefer a same-card `Boost post` `target_id` numeric
     permalink when available, but still open and verify the normalized URL
     before using it as proof.
   - If the live text proof gate fails, do **not** append
     `pair.publish.success`, do **not** append `global.publish.success`, and do
     **not** send a success notification. Instead append
     `pair.publish.live_text_mismatch` to `audit.jsonl`; append quarantine proof
     with `status: "posted-malformed"` to the pair `posted.jsonl` and
     `event: "global.publish.malformed"` / `status: "posted-malformed"` to
     `global-posted.jsonl` so a later run does not accidentally duplicate the
     same source item; then mark the destination blocked with category
     `live-text-mismatch` and ask Ethan whether to delete/repost or accept it.

If publish fails (login expired, account mismatch, missing config, rate limit, platform error):

- Append `pair.publish.failed` audit with `category: "needs-login" | "needs-config" | "needs-account-switch" | "rate-limit" | "platform-error" | "unknown"`.
- Tell the user what happened.
- Notify the user of the failure using `notification.delivery` and the current harness's message-delivery tool.
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

This step is forbidden until the destination URL has been re-opened and the
live destination post text has passed the mandatory proof gate in Step 8. A
publish with an unverified/wrong permalink or mismatched live text is
`pair.publish.live_text_mismatch` / `live-text-mismatch`, not a success, even if
the platform created a public post somewhere on the feed. Record it only as
`posted-malformed` quarantine proof so future runs do not duplicate it.

Append the same proof to `~/.repost-with-agent/global-posted.jsonl` using the
`repost-global-dedupe` schema. Include `pairId`, `contentKey`, source platform
/ id / URL, destination platform / account / URL / id, `draftText`,
`event: "global.publish.success"`, and `status: "posted"`. This global append is
not optional: it is how other pairs learn that this content already reached
this destination.

## Step 10 — Confirm to the user with post links (non-negotiable)

> Every successful source item from this plugin MUST trigger a message to the
> user on the primary current-harness communication channel, confirming the
> source URL and every destination post URL created. For source fanout /
> all-destination runs, send one message per source post containing all platform
> outcomes, not one message per platform. Silent publishes are a bug.
> (Ethan voice 5977 + 5978, 2026-05-01; link-list clarification 2026-05-04;
> aggregate fanout clarification 2026-05-06.)

Use the configured primary user communication channel / message delivery tool.
Read `notification.delivery` from `~/.repost-with-agent/pairs.json`; do not infer
from the current/default account when multiple accounts/bots exist. In OpenClaw,
call `message(action="send", channel=delivery.channel, accountId=delivery.accountId, target=delivery.target, threadId=delivery.threadId?, message=<payload>)`.
For Ethan's current OpenClaw config, those values are Telegram + `clordlethird` +
`telegram:6164541473`, but other users/harnesses should write their own route.
Never paste raw JSON/tool output into user-facing messages.

Notification shape depends on scope:

- **Single-pair run:** send the normal one-pair confirmation after success:

  ```
  [Repost-with-agent] ✅ Posted: <pair-id>
  Source: <canonical source URL>
  → Destination: <destination URL>
  ```

- **Source fanout / all-destination run:** do not send individual per-platform
  pings. Collect every enabled destination outcome for the same source item,
  then send one aggregate message after the source item is fully evaluated:

  ```
  [Repost-with-agent] ✅ Source fanout: <sourceItemId>
  Source: <canonical source URL>
  - X: posted <destination URL>
  - Bluesky: already-posted <proof URL>
  - Threads: posted <destination URL>
  - Facebook: blocked — <reason / next action>
  ```

If the user-message send fails:

- Append `pair.publish.notify.failure` for single-pair messages, or
  `source.fanout.notify.failure` for aggregate fanout messages.
- Tell the user in chat (so the missed ping is replaced).
- DO NOT roll back the post — it's already up.

If you reach this step and user-message delivery is unconfigured / unavailable,
append `pair.publish.notify_skipped_unconfigured` or
`source.fanout.notify_skipped_unconfigured` as appropriate. Treat that as an
alert: the plugin shipped a silent publish. Tell the user immediately.

See `skills/repost-notify/SKILL.md` for the payload spec.

## Step 11 — Final summary

Print to the user (in the agent transcript, NOT Telegram):

```
✅ Reposted from <pair-id>
  Source item: <sourceItemId>
  Source:      <canonical source URL>
  Destination: <destination URL>
  Destination ID: <destinationId if available>
  Posted at:   <ts>
  Notify:      delivered
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

- The subagent has no chat user. All interactive prompts above are skipped.
- Default sweep: `/repost-run all` scans every enabled `listen-for-future` pair
  sequentially; live jobs publish only `live-approved` pairs.
- Custom scheduled jobs may run a single pair, an explicit subset, or a
  preview/dry sweep. Follow the scheduler prompt literally, but fail closed:
  preview jobs never publish; live jobs publish only `live-approved` pairs.
- It must still confirm to Ethan via the primary current-harness communication channel / message delivery tool: one single-pair message for single-pair runs, or one aggregate message per source item for source fanout / all-destination runs, including every destination URL or reason.
- It must still append to `posted.jsonl`, `audit.jsonl`, and the global
  cross-pair ledger when a publish/catch-up proves destination state.
- After running, the agent exits. The next scheduled tick spawns a fresh agent/subagent.

## Error categories

When you hit a failure, append the appropriate audit event and tell the user
which category:

- `needs-login` — destination or source session expired. User must log in via
  the current harness browser profile, then re-run.
- `needs-config` — Telegram not configured, pair config missing required field, etc.
- `needs-account-switch` — login exists, but the visible posting identity does
  not match `destination.accountDisplayName` / target profile/page/group.
- `rate-limit` — destination platform rejected with a 429 or rate-limit modal.
  Wait and retry later.
- `platform-error` — destination platform error not in the above categories.
  Capture the error text and audit it.
- `unknown` — anything else. Tell the user what you saw.

## See also

- `skills/repost-custom-rules/SKILL.md` — user preference skip rules +
  append-only considered state (runs before dedupe).
- `skills/repost-dedup/SKILL.md` — Layer 1 dedupe (exact + fuzzy string match).
- `skills/repost-global-dedupe/SKILL.md` — global cross-pair content ledger.
- `skills/repost-dedup-semantic/SKILL.md` — Layer 2 dedupe (agent semantic reasoning).
- `skills/repost-url-expand/SKILL.md` — URL expansion details.
- `skills/repost-notify/SKILL.md` — Telegram payload spec.
- `skills/repost-learnings/SKILL.md` — pair-level institutional-memory file.
- `skills/repost-backfill/SKILL.md` — multi-post historical walks.
- `docs/destinations/<platform>.md` — per-platform DOM hints.
- `docs/state-files.md` — formal state-file schemas.
