# Migration from linkedin-to-x

The old project was a hardcoded LinkedIn → X/Facebook cross-poster. Repost-with-agent generalizes that into saved source→destination pairs.

## Old locations

```text
~/Projects/linkedin-to-x       # old local repo path, if present
~/.linkedin-to-x               # old runtime state
```

The local repo folder should be renamed to something like:

```text
~/Projects/Repost-with-agent
```

The public GitHub remote may still point at `EthanSK/linkedin-to-x` until the public repo rename step.

## Old state to preserve

- `posted.md` — old X posting tracker.
- `posted-facebook.json` if present.
- `x-tokens.json` token location/reference; do not copy secrets into repo.
- logs: `sync.log`, `loop.log`, launchd logs.

Deprecated legacy commands continue to use `~/.linkedin-to-x/posted.md` by default so old dedupe history is preserved. New pair workflows use `~/.repost-with-agent/`.

## New state location

```text
~/.repost-with-agent/
  pairs.json
  pairs/<pair-id>/state.json
  pairs/<pair-id>/posted.jsonl
  pairs/<pair-id>/audit.jsonl
  pairs/<pair-id>/learnings.md
```

## Migration command

```bash
repost-with-agent migrate linkedin-to-x
```

Expected behavior:

1. create a default `linkedin-to-x` pair;
2. import old posted snippets/ids into per-pair posted history;
3. preserve old files untouched;
4. write a migration audit event;
5. report any auth/token paths that need manual verification.

## Known old failure to keep as regression

On 2026-03-24 the old app posted a duplicate to X:

```text
https://x.com/i/status/2036422890271215716
```

The duplicate involved a Producer Player LinkedIn post that was already on X. A later commit fixed the dedupe bug:

```text
9d37108 Fix deduplication bug causing duplicate cross-posts
```

Repost-with-agent must preserve a regression test or fixture for duplicate prevention.
