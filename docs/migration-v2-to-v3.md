# Migrating Repost-with-agent v2 → v3

v3.0.0 is a major architectural change. This guide walks through what changed, what auto-migrates, and what you need to do by hand.

## What changed

| Area | v2 | v3 |
| --- | --- | --- |
| Where the posting happens | `src/x-client.ts` (520 LOC X API), `src/linkedin-scraper.ts` (279 LOC Playwright), `src/facebook-client.ts` | The agent's own browser MCP (chrome-devtools-mcp / OpenClaw browser) |
| Per-platform code | Adapter classes in `src/adapters/{sources,destinations}/` | None. Platform names are free-form string labels in pair config. |
| Dependencies | `playwright`, `dotenv`, `commander` | `commander` only. |
| Pair config | `source.type` / `destination.type` (adapter ids like `linkedin-profile-activity`) | `source.platform` / `destination.platform` (free-form labels like `linkedin`). v2 fields preserved for back-compat. |
| Run modes | Single path (always continuous tail) | Two modes: `backfill` (newest-first walk-back), `listen-for-future` (continuous tail). Field is `pair.runMode`. |
| Backfill ordering | Oldest-first | Newest-first (Ethan voice 6021) |
| URL expansion | None | New `expandUrlsInText` over every draft (5-hop, 5-sec, fail-soft) |
| Substack support | Investigation doc only | Dropped per Ethan voice 6021 ("not really social media") |
| Node entry point | `dist/index.js` (legacy `linkedin-to-x` bin removed in v3) | `dist/index.js` |

## What auto-migrates

When you first run any `repost-with-agent pair ...` command on a v2-shaped `pairs.json`, the runtime layer:

1. Detects v2 shape (`source.type` / `destination.type` set without `platform`, or `schemaVersion` undefined).
2. Backs up `~/.repost-with-agent/pairs.json` to `~/.repost-with-agent/pairs.json.v2.bak` (one-shot — won't overwrite an existing backup).
3. Translates the v2 adapter ids to v3 platform labels using a fixed mapping:
   - `linkedin-profile-activity` → `linkedin`
   - `x-account` / `x-post` → `x`
   - `facebook-page` → `facebook`
   - `bluesky-account` → `bluesky`
   - `threads-account` → `threads`
4. Sets `runMode: "listen-for-future"` (preserves v2's only-mode-it-had semantics).
5. Stamps `schemaVersion: 3`.
6. Writes the migrated form back to `pairs.json`.

The original `source.type` and `destination.type` fields are preserved on the pair record. You can ignore them; the v3 code reads `platform` exclusively.

## What needs your attention

### 1. Auth state — you need to log in via the browser, not via env vars

v2 supported X API auth via `X_CLIENT_ID` / `X_CLIENT_SECRET` / OAuth tokens written to `~/.repost-with-agent/x-tokens.json`. v3 has no API path. Instead:

- Open the browser the agent uses (chrome-devtools-mcp's persistent profile, or whatever your harness drives).
- Log into every source AND destination platform you'll cross-post to.
- The agent will reuse those sessions every time it runs a task.

There's nothing for the CLI to do here — the persistent profile lives in the agent's domain, not the CLI's.

### 2. Existing X API tokens are now ignored

`~/.repost-with-agent/x-tokens.json` and `~/.linkedin-to-x/x-tokens.json` are no longer read. Safe to delete (or leave — they don't hurt anything).

### 3. `--source-type` / `--destination-type` flags are gone

v2:

```bash
repost-with-agent pair create --source-type linkedin-profile-activity --destination-type x-account ...
```

v3:

```bash
repost-with-agent pair create --source-platform linkedin --destination-platform x ...
```

Existing v2 pairs that you migrate do NOT need to be re-created — the auto-migrator handles them.

### 4. Backfill ordering flipped

If you have an existing `pair backfill` script that expected oldest-first ordering, it's now newest-first. The most-recent historical posts will land on the destination first.

### 5. Substack pair? You need to re-do it on a different platform

v3 dropped Substack support per Ethan voice 6021 ("not really social media"). If you had a `--source-type substack-publication` pair, the auto-migrator will set `platform: "substack-publication"` (it doesn't match the v2_TYPE_TO_V3_PLATFORM mapping so it falls through to the literal type string). The CLI will let you create / preview / post with `platform: "substack-publication"`, but no skill / docs ship for it.

### 6. New `pair.runMode` field

v2 didn't distinguish backfill from continuous tail. v3 does. The auto-migrator defaults all v2 pairs to `runMode: "listen-for-future"` (the v2 semantic). To switch a pair to backfill mode:

```bash
repost-with-agent pair edit <id> --run-mode backfill
```

This doesn't change behavior at the pair level — `pair backfill` and `pair scheduled-run` are different CLI verbs. The `runMode` field is a hint for tooling (host scheduler integrations, dashboards) about which verb the pair is "for".

## Existing live pair migration — verified

Ethan's existing `linkedin-to-x` pair is the production test case. v3 auto-migrates it cleanly:

```
$ node dist/index.js pair list
linkedin-to-x | enabled | live-approved | listen-for-future | linkedin -> x

$ ls ~/.repost-with-agent/
pairs.json          pairs.json.v2.bak     pairs/

$ wc -l ~/.repost-with-agent/pairs/linkedin-to-x/posted.jsonl
11

$ node dist/index.js pair history linkedin-to-x
Pair: linkedin-to-x (Legacy LinkedIn to X)
Posted history: ~/.repost-with-agent/pairs/linkedin-to-x/posted.jsonl
Audit log: ~/.repost-with-agent/pairs/linkedin-to-x/audit.jsonl

Posted entries: 11
- [...] (all 11 entries preserved)
```

## Rollback

If for any reason you want to roll back to v2:

1. `git checkout v2.6.0` (or the last v2 commit on `main`).
2. `cp ~/.repost-with-agent/pairs.json.v2.bak ~/.repost-with-agent/pairs.json` (restore the v2 shape).
3. `npm install` (re-pulls Playwright + dotenv).
4. `npm run build`.

The `posted.jsonl` history is forward-compatible across both versions — no rollback needed there.

## When to bump pairs to use new v3 features

- **URL expansion** is automatic and applies to every existing pair without changes.
- **Newest-first backfill ordering** is automatic.
- **`runMode`** is set to `listen-for-future` on migrated pairs; flip to `backfill` only when you want a one-shot historical sync.
- **New platforms** (Bluesky, Threads, Facebook): create a new pair with the appropriate `--source-platform` / `--destination-platform` flag. Make sure the agent has the destination DOM hints — see `docs/destinations/<platform>.md`.

## Notify config — unchanged

`~/.repost-with-agent/notify.json` and `REPOST_TELEGRAM_BOT_TOKEN` / `REPOST_TELEGRAM_CHAT_ID` work exactly as in v2. The `notify configure | status | test` subcommands are bit-identical.
