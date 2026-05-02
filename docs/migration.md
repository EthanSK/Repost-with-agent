# Migration history

> **For migrating from v2 to v3.0.0** (the agent-driven rewrite, 2026-05-01) → see [migration-v2-to-v3.md](migration-v2-to-v3.md).
>
> This page documents the older v1 (`linkedin-to-x`) → v2 (`repost-with-agent`, pair-based) migration. v3 dropped the explicit `migrate linkedin-to-x` CLI verb because v2 has been the public surface for several months. If you still have a v1 install, run `repost-with-agent` v2.6.0 first to migrate, then upgrade to v3.

## v1 (linkedin-to-x) → v2 (repost-with-agent)

The original project was a hardcoded LinkedIn → X/Facebook cross-poster. v2 generalized that into saved source → destination pairs.

### Old locations

```text
~/Projects/linkedin-to-x       # old local repo path, if present
~/.linkedin-to-x               # old runtime state
```

### Old state to preserve

- `posted.md` — old X posting tracker.
- `posted-facebook.json` if present.
- `x-tokens.json` token location/reference; do not copy secrets into repo.
- logs: `sync.log`, `loop.log`, launchd logs.

### v1 → v2 migration command (deprecated in v3)

The `repost-with-agent migrate linkedin-to-x` verb shipped in v2 imported `posted.md` snippets into the v2 `pairs/<id>/posted.jsonl` shape. v3.0.0 removed the verb (it was a one-shot tool only relevant to legacy v1 installs). If you need to import legacy `posted.md` history into a v3 pair, do it manually:

```bash
# Pseudocode — the format conversion is straightforward.
# v1 format: ID + datestamp + snippet, one per line.
# v3 format: NDJSON entry per line in ~/.repost-with-agent/pairs/<id>/posted.jsonl.
```

Or check out the v2.6.0 tag, run `repost-with-agent migrate linkedin-to-x`, then upgrade to v3.0.0 (which auto-migrates the v2-shaped `pairs.json`).

## Known old failure to keep as regression

On 2026-03-24 the v1 app posted a duplicate to X:

```text
https://x.com/i/status/2036422890271215716
```

The duplicate involved a Producer Player LinkedIn post that was already on X. A later v1 commit fixed the dedupe bug:

```text
9d37108 Fix deduplication bug causing duplicate cross-posts
```

The fix is exercised by `tests/dedupe-regression.js` — the test fixture replicates the v1 entry shape and asserts that re-posting the same content (different URL) produces `decidePreviewStatus: duplicate`. v3.0.0 retains this test untouched.
