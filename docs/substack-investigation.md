# Substack destination — feasibility & architecture investigation

> Investigation only. No code shipped here. This is the spec for a future implementation subagent.
>
> Date: 2026-05-01
> Author: investigation subagent

## 1. Goal

Add a Substack destination to Repost-with-agent so a short post (LinkedIn / X / Telegram voice transcript) can be **expanded by an LLM** into a full Substack-ready essay and published to the user's Substack publication.

This is materially different from the existing LinkedIn-source → X-destination pair, which is "copy verbatim with light formatting". Substack output requires a **transform stage** between source and destination that an LLM owns.

## 2. Existing architecture map

Two interfaces, two registries, one orchestrator. All paths under `src/`.

### Interfaces (`src/adapters/source.ts`, `src/adapters/destination.ts`)

```ts
interface SourceAdapter {
  type: string;
  test(pair): Promise<AuthHealth>;
  fetchCandidates(pair): Promise<SourceItem[]>;
}

interface DestinationAdapter {
  type: string;
  test(pair): Promise<AuthHealth>;
  preview(item, pair): Promise<DraftPost>;        // returns draft text + warnings
  publish?(item, draft, pair): Promise<PublishResult>;  // approval-gated live post
}
```

### Orchestrator (`src/core/orchestrator.ts`)

`previewPair()` and `publishNextForPair()` wire it as:

```
sourceAdapter.fetchCandidates  →  destinationAdapter.preview  →  decidePreviewStatus (dedupe)
                                                              →  destinationAdapter.publish (only if --approve)
```

There is **no transform stage** today. The destination adapter's `preview()` is responsible for both producing the draft text *and* declaring its formatter. For X, that formatter is `formatForX()` — a deterministic char-trim, never an LLM call.

### Registry (`src/index.ts`)

```ts
const SOURCE_ADAPTERS = new Map([[linkedInSourceAdapter.type, linkedInSourceAdapter]]);
const DESTINATION_ADAPTERS = new Map([[xDestinationAdapter.type, xDestinationAdapter]]);
```

Adding an adapter = add an entry to one of these maps. Pair records pick the adapter via `pair.source.type` / `pair.destination.type` strings.

### Pair record (`src/core/types.ts`)

`PairRecord.destination` is `PairEndpoint { type, authRef, profileUrl, url, accountHint, pageHint }` — flexible enough for Substack's `(publication subdomain, optional collection/section)` shape without schema changes.

### Implication for Substack

The existing `DestinationAdapter` contract is sufficient. The LLM-expansion step lives **inside** `substackDestinationAdapter.preview()`, which receives the raw `SourceItem` and returns a `DraftPost` whose `text` is the expanded essay (markdown). No new "Transformer" abstraction is required — `preview()` is already the natural transform hook. (See §4 for the ergonomic case for adding one anyway.)

## 3. Substack publishing API state (May 2026)

### Official API: read-only

Substack shipped a public Developer API but it is **strictly read-only over public profile data** — no draft creation, no publish. Verified via Substack's own help center page "Substack Developer API" plus tella.com's API explainer. There is no official endpoint to create or publish posts.

Source: [Substack Developer API help article](https://support.substack.com/hc/en-us/articles/45099095296916-Substack-Developer-API).

### Reverse-engineered private endpoints

The `connect.sid` session cookie + the JSON endpoints behind `substack.com/api/v1/` are the only way to post programmatically. Two mature wrappers exist:

- **`ma2za/python-substack`** — three auth modes: email/password, cookies-from-file, cookies-as-string copied from devtools "Copy as fetch (Node.js)". Endpoints: `post_draft()`, `put_draft()`, `prepublish_draft()`, `publish_draft()`, plus image upload + section management.
- **`jakub-k-slys/substack-api`** — TypeScript client, entity-based interface (`OwnProfile`, `Publication`, `Post`, `Note`), supports content creation. Closer match for our Node.js codebase.

Neither is officially endorsed. Both work today (verified by community usage as of Apr 2026), both depend on undocumented endpoints that Substack can change without notice.

### Email-to-Substack

Substack does not expose a public "email-to-publish" address per publication (unlike Tumblr / classic blog platforms). The only email-related publishing flow is "send the published post to subscribers" — outbound, not inbound. Not a viable workaround.

### Notes vs Posts

`Notes` (Substack's Twitter-like feed) is the surface community automation has converged on — `n8n-nodes-substack` only writes Notes, not full posts. Notes have a 280-ish char limit and no markdown body. **For Ethan's "fuller essay" use case, Notes are the wrong target.** The pair must produce a real Post (draft + publish), which means committing to the reverse-engineered Post-creation endpoints.

### Auth flow we'd actually use

Best of the bunch: **cookie-string auth via the persistent Playwright profile that Repost-with-agent already maintains**. The user logs into substack.com once in `~/.claude/playwright-profile/` (same dir already used for LinkedIn). The Substack adapter reads `connect.sid` directly from the Playwright profile's cookie store at runtime — zero new credential surface, no env vars, no separate token file. This is consistent with how LinkedIn source works today.

### Risks (binding for §5)

- **TOS exposure.** Substack's TOS does not explicitly forbid programmatic posting via your own session, but it forbids "interfering with normal site operation" — vague enough that aggressive automation could trigger account review. **Mitigation:** keep `maxItemsPerRun: 1`, `minDelayBetweenPostsMinutes >= 60`, mark adapter as `experimental` in pair metadata, document in README.
- **Endpoint drift.** Reverse-engineered endpoints break silently. **Mitigation:** the adapter's `test()` should hit a cheap auth-validating endpoint (e.g. `/api/v1/me`) and fail fast with `AuthHealth { status: "needs-config" }` if the response shape changed. Adapter version-pins to a `python-substack`/`jakub-k-slys` minor version and bumps deliberately.
- **Account suspension.** Lower than for X / LinkedIn because Substack's anti-automation posture is softer. Still non-zero. **Mitigation:** preview-only by default per existing pair safety policy.

## 4. LLM expansion design

### Pipeline shape

```
SourceItem  →  expandPostWithLLM(text, ctx)  →  ExpandedPost { title, subtitle, body_markdown, tags }
                                            ↓
                                       DraftPost  →  decidePreviewStatus (dedupe)
                                                  →  publish  →  Substack draft → publish
```

### Where it lives

Two viable shapes:

**(a) Inside `substackDestinationAdapter.preview()`** — minimal, no new abstractions. The adapter calls Anthropic's API directly and returns an `ExpandedPost`-ified `DraftPost`.

**(b) New `Transformer` interface in `src/adapters/transformer.ts`** —

```ts
interface Transformer {
  type: string;
  transform(item: SourceItem, pair: PairRecord): Promise<SourceItem>;  // SourceItem in, SourceItem out
}
```

with `pair.transform?: { type: "llm-substack-expand", model, promptTemplate }` and the orchestrator running it between fetch and preview.

**Recommendation: (b).** Reasons:

- The transform output is reusable across destination types (today: Substack only, but tomorrow: long-form Medium, long-form LinkedIn article, blog post). Couples cleanly.
- Dedupe runs against the *transformed* content, not the raw seed — and the contentHash should reflect the post-expansion text or every re-expansion looks "new". Putting transform inside `preview()` muddles whether dedupe sees pre- or post-transform content.
- Explicit `pair.transform` field in the pair record is auditable: a user reading `pairs.json` can see "this pair runs LLM expansion before publish". Hidden inside the destination adapter, that's invisible.

### Model + prompt

- **Model: Claude Sonnet 4.7** as default (good quality:cost ratio for ~1500-word essays). Configurable via `pair.transform.model` for users who want Opus quality or Haiku cost.
- **Input length:** 200-3000 chars (LinkedIn long-form caps higher than X).
- **Output target:** 800-1500 word essay, markdown body, with title (≤60 chars), subtitle (≤140 chars), 3-5 tags.
- **Prompt template** (sketch — tune iteratively against learnings.md):

```
You are expanding {{author_name}}'s short social post into a fuller Substack essay
that reads in {{author_name}}'s voice. Keep their core idea — DON'T add new claims,
DON'T water it down, DON'T add corporate filler. Expand by adding context,
examples, and connective tissue that helps a reader who hasn't been following
the original thread understand the idea.

Source post:
"""
{{source_text}}
"""

Source URL (for "Originally posted at..." footer): {{canonical_url}}

Output JSON only:
{
  "title": "...",       // ≤60 chars, punchy, no clickbait
  "subtitle": "...",    // ≤140 chars
  "body_markdown": "...",  // 800-1500 words, markdown
  "tags": ["...", "...", "..."]
}
```

The prompt should pull `learnings.md` for the pair as a system-prompt addendum so accumulated voice/style notes get applied.

### Cost estimate

Sonnet 4.7 pricing (as of May 2026): ~$3 / 1M input tokens, ~$15 / 1M output tokens.

Per post:
- Input: ~600 tokens (system prompt + source post + learnings) → $0.0018
- Output: ~2000 tokens (1500-word essay) → $0.030
- **~$0.032 per post.**

At 1 post/day cadence, ~$1/month. Rounding error. Even at Opus pricing (5x), ~$5/month. Not a budget concern.

### Rate limits

- Anthropic API: 50 requests/min on default tier — irrelevant at 1 post/day.
- Substack: undocumented. Conservative: 1 post per 60+ minutes per publication.

## 5. Architecture recommendation: Path A — extend Repost-with-agent

| Question | Path A: extend | Path B: fork to `Substack-with-agent` |
|---|---|---|
| Code reuse | All pair/dedupe/audit/CLI machinery reused as-is | Duplicate ~1500 LOC of orchestrator/runtime/CLI |
| Pair semantics | Substack pair sits next to LinkedIn-to-X pair, same `pair list` UX | User has two CLIs, two state dirs, two host plugin entries |
| Future destinations | Adding Medium / Mastodon / Bluesky stays in one repo | Each new long-form destination forces another fork |
| Source flexibility | Substack pair can take *any* registered source (LinkedIn, X, manual, RSS later) | Forked project would re-implement source adapters |
| Risk localization | Substack endpoint flakiness is one adapter, sibling pairs unaffected | Same — but pays for fork in maintenance forever |

**Path A wins.** No architectural reason to fork. The "long-form vs short-form" axis is a destination property, not a top-level project distinction.

## 6. Implementation plan (8 steps)

### Step 1 — add `Transformer` interface + registry

- New file: `src/adapters/transformer.ts` — interface above.
- New file: `src/adapters/transformers/llm-substack-expand.ts` — Anthropic SDK call, prompt template, JSON-mode response parsing into a new `SourceItem` whose `text` is the expanded markdown body and `metadata` carries `{ title, subtitle, tags, originalText }`.
- New env var: `ANTHROPIC_API_KEY`.
- Modify: `src/index.ts` to register `TRANSFORMERS` map alongside `SOURCE_ADAPTERS` / `DESTINATION_ADAPTERS`.

### Step 2 — extend pair schema

- Modify: `src/core/types.ts` — add optional `transform?: { type: string; model?: string; promptTemplate?: string }` to `PairRecord`.
- Modify: `src/index.ts` `pair create` command — add `--transform-type`, `--transform-model` flags.
- Backward compatible: existing X pairs leave `transform` undefined and skip the stage.

### Step 3 — wire transform into orchestrator

- Modify: `src/core/orchestrator.ts` `previewPair()` — between `fetchCandidates` and the `for (item of limited)` loop, run each item through the configured transformer (if any).
- The dedupe `contentHash` is computed from the *transformed* text, not the raw seed, to avoid re-expansion looking like a new post on every preview.
- Audit event additions: `pair.preview.transform.success` / `pair.preview.transform.failed`.

### Step 4 — Substack destination adapter

- New file: `src/adapters/destinations/substack.ts`.
- Pick lib: **`jakub-k-slys/substack-api`** (TypeScript, native fit). Add as dep in `package.json`.
- `test()` — read `connect.sid` from the Playwright profile cookie store (`~/.claude/playwright-profile/Default/Network/Cookies` SQLite read), call Substack `/api/v1/me`, fail fast on 401.
- `preview()` — return `DraftPost` with `text` = body_markdown, `metadata` = `{ title, subtitle, tags }`, `warnings` for missing fields. **No LLM call here** — that ran in step 3's transformer.
- `publish()` — `post_draft → prepublish_draft → publish_draft` flow. `PublishResult.destinationUrl` = the published post URL.

### Step 5 — Substack auth health UX

- The persistent Playwright profile must be logged into `https://substack.com/`. Document in README under "Persistent browser login".
- `test()` returns `AuthHealth { status: "needs-login", message: "Open the Playwright profile and log into substack.com" }` when cookie missing or expired.
- Mirror the LinkedIn pattern — user logs in once, agent never bypasses 2FA.

### Step 6 — pair create UX + skill update

- Modify: `skills/repost-pair-setup/SKILL.md` — add Substack to the destination options, prompt for publication subdomain (e.g. `ethansk.substack.com`).
- Modify: `commands/pair.md` example — show a LinkedIn → Substack pair create.
- Default policy for Substack pairs: `preview-only`, `maxItemsPerRun: 1`, `minDelayBetweenPostsMinutes: 60`, `requirePreviewBeforeFirstLiveRun: true`.

### Step 7 — tests + smoke run

- Unit test: transformer with a recorded Anthropic response (HTTP fixture, no network).
- Unit test: Substack adapter `test()` against a fake cookie file → 401 / 200 paths.
- E2E (manual, gated): `pair preview substack-test` → verify drafted markdown looks reasonable.
- Live publish to a *test* Substack publication before docs.

### Step 8 — docs + version bump

- Update `README.md` env-var table (`ANTHROPIC_API_KEY`).
- Update `docs/architecture.md` adapter contract section to include `Transformer`.
- New `docs/substack-pair.md` — concrete walk-through (create pair, log in, preview, approve).
- Bump version to `2.3.0` (minor — additive).

## 7. Open questions for Ethan

- **Voice match:** Does he want the LLM to mimic his existing Substack voice? If yes, we'd want to seed `learnings.md` with 2-3 of his existing essays as style anchors before the first live run.
- **Title/subtitle veto:** Approve flow today is binary (publish or don't). For Substack, he probably wants a "regenerate title" or "edit subtitle" loop. Out of scope for v1; queue as v1.1.
- **Notes vs Posts:** confirm he wants full Posts. Notes are an easier integration if he'd accept that scope first as a stepping stone.
- **Source breadth:** initial source = LinkedIn (existing) only? Or also Telegram voice notes and X posts? Each new source = separate `SourceAdapter`. Telegram would be net-new.

## 8. TL;DR

- **Substack has no official posting API; reverse-engineered cookie-auth is the only path.** `jakub-k-slys/substack-api` (TS) is the right wrapper.
- **Path A: extend Repost-with-agent**, don't fork. Add `Transformer` interface + `substackDestinationAdapter` + LLM-expand transformer.
- **Cost: ~$0.03/post** at Sonnet 4.7. Not a concern.
- **8-step plan above** ships v2.3.0 with backward-compatible additions only.
- **Risks:** mainly endpoint drift (low blast radius — one adapter) and TOS-grey-area programmatic posting (mitigate via 1-item-per-run + 60min spacing + preview-first defaults).
