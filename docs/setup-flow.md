# Repost-with-agent setup flow (v3.0.0)

The setup flow should feel conversational, but the thing being configured is always a user-owned repost workflow: a saved (source platform → destination platform) pair stored in `~/.repost-with-agent/pairs.json`.

## Non-negotiable rule — Telegram-confirm every successful publish

> Every successful post from this tool MUST trigger a Telegram message to Ethan confirming what was posted, the source URL, and the destination URL. The CLI does this automatically via the configured `notify.telegram` channel. If you are an agent operating on this repo and you trigger a publish through any non-CLI path you MUST also fire a Telegram confirmation. Silent publishes are a bug. (Ethan voice 5977 + 5978, 2026-05-01.)

**First-time setup MUST include `notify configure`.** Before flipping any pair to a non-`preview-only` mode, run:

```bash
repost-with-agent notify configure --bot-token <TELEGRAM_BOT_TOKEN> --chat-id <CHAT_ID> --test
```

`--test` sends a verification message immediately. Verify with `repost-with-agent notify status` (should report `Resolved source: file` or `env`, never `none`).

## Pair creation script

Agent:

> Let's make a reusable repost pair. Which platform should I watch as the source?

User gives a source platform + URL, for example:

- `linkedin` + `https://www.linkedin.com/in/example/recent-activity/all/`
- `x` + `https://x.com/example`
- `bluesky` + `https://bsky.app/profile/example.bsky.social`

Agent:

> Which platform should the posts go to, and what's the destination account?

User gives the destination, for example:

- `x` + `@example`
- `bluesky` + `example.bsky.social`
- `threads` + `@example`
- `facebook` + `<page-handle>`

Agent then:

1. Confirms the user is logged into BOTH source and destination platforms in the agent's persistent browser profile (the agent CANNOT log in for the user).
2. Asks for the run-mode: `listen-for-future` (default — tail new posts via the host scheduler) or `backfill` (walk-back through history newest-first).
3. Creates the pair with `repost-with-agent pair create --source-platform <p> --destination-platform <p> --source-url ... --destination-account ... --run-mode <m>`.
4. Runs `repost-with-agent pair preview <id>`. The CLI emits a `[agent-task fetch-source ...]` banner; the agent fulfils the task by driving the browser; the CLI prints the draft + dedupe decision.
5. Asks for a pair name and schedule preference.
6. Captures schedule via `pair edit <id> --schedule-kind cron --schedule-expression "..." --timezone "..."`.
7. **Runs `repost-with-agent notify configure --bot-token <T> --chat-id <C> --test` if it's the first install on this machine.**
8. Saves the setup.

## Modes

| Pair mode | Behavior |
| --- | --- |
| `preview-only` | Default. Never publishes; only drafts / previews. |
| `approval-required` | Scheduled / manual runs can find candidates but need explicit `--approve` before publish. |
| `live-approved` | Can publish under the saved policy when the host scheduler passes `--allow-publish`. Required for unattended scheduled posting. |

| Run mode | Behavior |
| --- | --- |
| `listen-for-future` | Default. Continuous tail; host scheduler invokes `pair scheduled-run <id>` at the configured cadence. |
| `backfill` | Walk-back through historical posts newest-first. Run via `pair backfill <id>`. Optional resume state survives kills. |

New pairs default to `mode: preview-only`, `runMode: listen-for-future`, `enabled: false`.

## Browser-MCP prereq

The agent needs a working browser MCP. Common options:

- **Claude Code**: `chrome-devtools-mcp` (preferred — DOM-aware), `claude-in-chrome` extension.
- **OpenClaw**: built-in browser tool.

The same persistent profile that the user logs into IS what the agent will drive. There is no separate Playwright stack — v3.0.0 deliberately removed Playwright from `src/` (Ethan voice 6016).

## OpenClaw cron setup

For recurring runs, schedule an OpenClaw cron job that invokes this skill on the configured pair. The scheduled prompt should say to:

1. Use the `repost-with-agent` skill.
2. Work from the repo or installed plugin location.
3. Load `~/.repost-with-agent/pairs.json` plus the pair history / learnings.
4. Run `pair scheduled-run <id> --json`.
5. Pass `--allow-publish` ONLY when the saved pair mode is `live-approved` AND the user explicitly authorized live posting.
6. Enforce `policy.maxItemsPerRun: 1` (default).
7. Announce candidates, blockers, or a clean no-op.

Render-only:

```bash
repost-with-agent pair schedule <id>
```

This prints the launchd plist + crontab line + ready-to-run `openclaw cron add` command. Apply with:

```bash
repost-with-agent pair schedule <id> --apply launchd
launchctl load ~/Library/LaunchAgents/com.repost-with-agent.<id>.plist
```

See [docs/scheduling.md](scheduling.md) for the full host-scheduler contract.

## Example successful setup

```text
User: Make a pair from my LinkedIn posts to my X account.
Agent: Got it. Source = linkedin, destination = x. Are you logged into both on this machine's browser profile?
User: Yes
Agent: Which LinkedIn URL should I watch?
User: https://www.linkedin.com/in/example/recent-activity/all/
Agent: And the X handle?
User: @example
Agent: Run-mode? listen-for-future (continuous tail) or backfill (walk-back through history)?
User: listen-for-future
Agent: Creating pair... [pair create --source-platform linkedin --destination-platform x --source-url ... --destination-account @example --run-mode listen-for-future --mode preview-only]
Agent: Running preview. The CLI emitted a fetch-source agent-task; let me drive the browser to scrape your LinkedIn profile...
Agent: I found 2 candidate posts. The most recent one looks new; one looks already posted. Here is the draft for the new one...
User: Save it as LinkedIn to X and run daily around 10am.
Agent: Setting schedule. [pair edit linkedin-to-x --schedule-kind cron --schedule-expression "0 10 * * *" --timezone Europe/London]
Agent: It will run in preview mode until you explicitly enable live posting via [pair edit linkedin-to-x --mode live-approved].
```

## Safety wording

Use this framing:

- "responsible automation"
- "preview-first"
- "avoid accidental spam/duplicates"
- "respect platform login / security prompts"
- "browser-driven posting via the user's logged-in session"

Avoid this framing:

- "ban evasion"
- "anti-detection"
- "human-like stealth"
- "bypass CAPTCHA / 2FA"
