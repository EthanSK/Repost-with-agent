# Safety and compliance guardrails

Repost-with-agent is for responsible, user-controlled reposting. It must not become a stealth or evasion toolkit.

## Hard boundaries

- No CAPTCHA bypass.
- No 2FA bypass.
- No credential scraping.
- No deceptive fake-human simulation.
- No anti-detection or ban-evasion logic.
- No publishing without explicit user authorization.
- Do not ask users to paste passwords into chat.

## Defaults

- New pairs start in `preview-only` mode and `enabled: false`.
- First run must be preview / dry-run.
- Live posting requires explicit current-request approval (`--approve`) or an explicit saved approval state (`pair.mode: live-approved` + `--allow-publish` on scheduled / backfill).
- Max 1 item per scheduled run by default (`policy.maxItemsPerRun: 1`).
- Min-delay between posts enforced (`policy.minDelayBetweenPostsMinutes`).
- Block on uncertain duplicate (unless `--allow-uncertain` is explicitly set).
- Block overlength drafts by default (`--overlength-strategy skip`); user must opt into truncation.
- Browser-driven posting via the user's logged-in session — no API SDKs, no parallel browser stack.
- Keep detailed audit logs.

## Browser automation

Browser automation is acceptable for transparent, user-controlled workflows where the user is logged in and the platform allows the behavior. It should not be used to bypass platform security or pretend to be a human. The agent drives the user's actual logged-in browser via its own browser MCP — there is no "second" browser stack maintained by this repo.

The user CANNOT delegate login to the agent. Every platform must already be logged into the persistent browser profile the agent uses.

## Rate/cadence policy

Cadence limits exist to reduce accidental spam, duplicate posts, and operational mistakes. Do not describe them as a way to avoid detection.

## Audit log requirements

Every run should log:

- pair id and version;
- source checked;
- destination checked;
- auth/login health;
- candidates found;
- dedupe decisions;
- drafts generated;
- approvals requested/received;
- posts published and resulting destination ids;
- errors and retries.
