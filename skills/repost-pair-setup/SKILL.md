---
name: repost-pair-setup
description: Create or save a new Repost-with-agent source → destination pair. Use when the user wants to set up cross-posting from one social platform (LinkedIn, X, Bluesky, Threads, Facebook) to another, or asks to "configure a repost pair", "set up reposting", "wire up cross-posting", or "add a new pair to repost-with-agent / repost_with_agent".
when_to_trigger: User asks to set up, create, configure, or save a new repost pair, e.g. "set up reposting from LinkedIn to X", "add a Bluesky → Threads pair", "configure repost-with-agent for my new account".
---

# Repost Pair Setup

You are the running agent. Repost-with-agent v4 ships ZERO code that does the
work — this skill is the instructions for you to set up a new source →
destination pair using your own native tools (Read, Edit, Write, Bash,
current-harness Telegram/message delivery).

## Goals

1. Ask the user for the source platform + URL/handle.
2. Ask for the destination platform + account.
3. Ask for the run mode + safety mode.
4. Write or update `~/.repost-with-agent/pairs.json`.
5. Verify the user is logged into both platforms in the current harness browser profile.
6. Confirm success and explain next steps.

## State files

All state lives at `~/.repost-with-agent/`:

- `~/.repost-with-agent/pairs.json` — array of pair configs (see schema below).
- `~/.repost-with-agent/pairs/<pair-id>/posted.jsonl` — append-only history.
- `~/.repost-with-agent/pairs/<pair-id>/audit.jsonl` — append-only audit events.
- `~/.repost-with-agent/pairs/<pair-id>/learnings.md` — free-form notes.

The directories are created lazily on first run for a pair.

## pairs.json schema (schemaVersion 4)

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
        "accountDisplayName": "<visible account/page name>",
        "targetType": "profile | page | group",
        "profileUrl": "https://x.com/<handle>"
      },
      "schedule": {
        "kind": "manual | cron",
        "tz": "Europe/London",
        "expression": "0 10 * * *",
        "everyHours": 24
      },
      "policy": {
        "maxItemsPerRun": 1,
        "minDelayBetweenPostsMinutes": 60,
        "blockOnUncertainDuplicate": true,
        "overlengthStrategy": "skip | compact | truncate",
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

Field invariants:

- `id` is kebab-case, unique. Default form: `<source-platform>-to-<destination-platform>`.
- New pairs default to `mode: "preview-only"` and `enabled: false`. **Never flip to live without explicit user authorization in the current conversation.**
- `runMode: "listen-for-future"` is the default — tail new posts on a schedule.
- `runMode: "backfill"` is for one-shot historical walks (newest-first).
- `mode: "live-approved"` is the only mode that allows scheduled live publishes.
- `mode: "approval-required"` requires the agent to ask the user per-post.
- `policy.overlengthStrategy: "compact"` is the Ethan/OpenClaw default for tight destinations: if a draft is over the cap, rewrite it shorter while preserving the original voice, intent, links, and meaning as much as possible. Use `"skip"` only when Ethan wants overlength drafts dropped; use `"truncate"` only if he explicitly asks for mechanical shortening.
- `policy.globalDedupeEnabled` defaults to true; every pair reads the global cross-pair ledger before publishing so alternate routes do not double-post the same content to the same destination.
- `policy.semanticDedupeEnabled` defaults to true; Layer 2 semantic dedupe runs after Layer 1 string/fuzzy dedupe.
- `policy.semanticDedupeWindowSize` defaults to 30 recent destination posts.
- `schedule.everyHours` defaults to 24 (daily) when `runMode = "listen-for-future"` (see `repost-listen-for-future-setup` skill).

## Conversation flow

1. **Source.** "What's the source platform and the profile URL? (linkedin / x / bluesky / threads / facebook)"
2. **Destination.** "What's the destination platform and the account handle? (one of the same five)"
   - If the destination platform can contain multiple posting identities inside
     one login (Facebook profile/page/group, Meta/Threads account switchers,
     Bluesky multi-account sessions), also capture:
     - `destination.targetType` — `profile`, `page`, or `group`.
     - `destination.accountDisplayName` — the visible name to confirm in the UI
       before composing (for example `Reetham`).
   - If Ethan only gives a brand/account name, preserve it literally and infer
     the likely handle conservatively (`Reetham` → `@reetham` or
     `reetham.bsky.social`) until the logged-in browser confirms the exact
     platform handle.
3. **Pair name + id.** Suggest `<source>-to-<destination>` as the id; let the user override the human-readable name.
4. **Run mode.** "`listen-for-future` (tail new posts on a schedule) or `backfill` (one-shot walk back through history)?" Default to `listen-for-future` if unsure.
5. **Safety mode.** Default to `preview-only`. Only set `approval-required` or `live-approved` if the user explicitly asks for live posting now.
6. **Schedule (if listen-for-future).** Ask for cadence in hours. Default 24 (daily).

## Destination account / page switching

Some sites authenticate through a parent account and then require selecting the
actual posting identity. Save the intended identity in the pair config and make
the run skill verify it before typing any draft.

- `destination.accountDisplayName` is the primary human-visible name to match in
  the browser UI. When Ethan says "use whatever is logged in", configure this to
  the currently logged-in visible name.
- `destination.accountHint` is a loose human hint (name, handle, vanity path, or
  page label), not a separate authoritative account id unless Ethan explicitly
  gives an exact handle.
- `destination.targetType` tells the agent whether to expect a `profile`,
  `page`, or `group` composer.

When configuring Facebook/Meta surfaces, prefer the visible logged-in name Ethan
expects the browser to use. If the UI shows a profile/page switcher, the running
agent must switch to, or verify it is already using, `accountDisplayName` before
posting. Do not block merely because a stale handle differs from the logged-in
profile; update the pair to the logged-in visible name.

## Writing the pair

1. **Read** `~/.repost-with-agent/pairs.json` if it exists. If not, initialise with `{"schemaVersion": 4, "pairs": []}`.
2. **Validate** that `id` is unique in the existing pairs.
3. **Append** the new pair object with the fields above. Set `createdAt` and `updatedAt` to the current ISO-8601 UTC timestamp (`date -u +%Y-%m-%dT%H:%M:%SZ` via Bash).
4. **Write** the updated JSON with two-space indentation.
5. **Verify** with `jq . ~/.repost-with-agent/pairs.json` (Bash) — if jq exits non-zero, restore from a `pairs.json.bak.<unix-ts>` backup taken before the write and tell the user.
6. **Create** the per-pair dir `~/.repost-with-agent/pairs/<pair-id>/` if missing (`mkdir -p`). Create empty `posted.jsonl`, `audit.jsonl`, `learnings.md` files (touch).

## Login checkpoint (CRITICAL)

You CANNOT log in for the user. Before the first preview / publish, the user must
have an existing logged-in session for both source and destination platforms in
the current harness browser profile that you'll drive (OpenClaw's built-in
browser, `chrome-devtools-mcp` when the current harness is Claude Code, or another
explicit browser adapter).

Tell the user:

> "Before I can run `/repost-run <pair-id>`, please open the current agent's
> browser profile and confirm you're logged into both **<source>** and
> **<destination>**. I cannot log in for you. Once both sessions exist, I'll
> reuse them on every run."

You can verify by navigating the current harness browser to the source profile
URL and taking a snapshot — if you see logged-out indicators
(login modal, "Sign in to continue" CTA, etc.), tell the user and stop.

## Telegram-confirm every successful publish — non-negotiable

> Every successful post from this plugin MUST trigger a Telegram message to
> Ethan confirming the source and destination URL. Silent publishes are a bug.
> (Ethan voice 5977 + 5978, 2026-05-01.)

The agent (you) is responsible for sending this Telegram via
the current harness's Telegram/message delivery tool immediately after
appending to `posted.jsonl`. This behavior is enforced by the `repost-notify`
and `repost-run` skills.

If you've never sent a Telegram from this plugin on this machine, tell the user
to test once with the `repost-notify` skill before flipping any pair to a
non-`preview-only` mode.

## Final summary

After writing the pair, print a short summary to the user:

```
✅ Pair created: <id>
  Source:      <platform> · <url>
  Destination: <platform> · <accountHint>
  Mode:        <mode>
  Run mode:    <runMode>
  Schedule:    <schedule.kind> · <schedule.expression or everyHours>

Next steps:
  1. Verify you're logged into both platforms in the current harness browser profile.
  2. Run /repost-run <id> to do one preview + (if safety mode allows) one live publish.
  3. Run /repost-setup-cron <id> to install a current-harness scheduler entry that runs every <N> hours.
```

## Safety

- New pairs default to `preview-only` + `enabled: false`. That's intentional.
- Never flip to `live-approved` without explicit, current-conversation authorization.
- No stealth, CAPTCHA bypass, 2FA bypass, or anti-detection guidance. Browser
  automation only operates on user-controlled, transparent login sessions.
- Refuse to scrape or post on behalf of an account the user is not the operator
  of (e.g. don't repost from someone else's profile to another account without
  explicit written authorization).

## See also

- `skills/repost-pair-list/SKILL.md` — list pairs.
- `skills/repost-pair-show/SKILL.md` — inspect one pair.
- `skills/repost-run/SKILL.md` — run a pair (single-post).
- `skills/repost-listen-for-future-setup/SKILL.md` — install the current-harness scheduler trigger.
- `docs/state-files.md` — formal state-file schemas.
- `docs/destinations/<platform>.md` — per-platform DOM hints.
