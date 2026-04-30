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

- New pairs start in `preview-only` mode.
- Queue workspaces start with `publish_mode: manual` and `run_policy.approval: manual`.
- First run must be preview/dry-run.
- Live posting requires explicit current-request approval or an explicit saved approval state.
- Max 1 item per scheduled run by default.
- Block on uncertain duplicate.
- Prefer official APIs where available.
- Keep detailed audit logs.

## Facebook and other destination adapters

Facebook support is legacy/experimental until it is exposed through a cautious destination adapter. Treat it as disabled by default, require explicit configuration, and keep public posting approval-gated.

## Browser automation

Browser automation is acceptable for transparent, user-controlled workflows where the user is logged in and the platform allows the behavior. It should not be used to bypass platform security or pretend to be a human.

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
