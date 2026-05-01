# Repost-with-agent setup flow

The setup flow should feel conversational, but the thing being configured is always a user-owned repost workflow: either a saved source→destination pair or a queue workspace with setup/state/log files.

## Pair creation script

Agent:

> Let’s make a reusable repost pair. What source website, account, or feed should I watch?

User gives a source, for example:

- `https://www.linkedin.com/in/example/recent-activity/all/`
- `my LinkedIn posts`
- `this RSS feed`
- `my Bluesky profile`

Agent:

> Where should those posts go?

User gives a destination, for example:

- `my X account @example`
- `this Facebook Page`
- `my Mastodon account`
- `a local drafts file first`

Agent then:

1. identifies source/destination adapter types;
2. checks auth/login state;
3. asks the user to log in through browser/OAuth if needed;
4. creates a queue workspace with `scripts/init_repost_with_agent_workspace.py` when the task is queue-based, or creates a saved pair when the task is pair-based;
5. runs `preview` only;
6. shows candidate items/drafts;
7. asks for a pair/workspace name;
8. captures schedule preference in `run_policy` or the pair schedule;
9. saves the setup.

## Modes

- `preview-only`: never publishes; only drafts/previews.
- `approval-required`: scheduled/manual runs can find candidates but need approval before publish.
- `live-approved`: can publish under the saved policy; must be explicitly enabled.

New pairs default to `preview-only`. Queue workspaces default to `publish_mode: manual` and `run_policy.approval: manual`.

## OpenClaw cron setup

When a user wants recurring OpenClaw runs, schedule an isolated cron job that invokes this skill and names the repo, pair, or queue workspace explicitly.

For saved pairs, the scheduled prompt should say to:

1. use the `repost-with-agent` skill;
2. work from the repo or installed plugin location;
3. load `~/.repost-with-agent/pairs.json` plus the pair history/learnings;
4. run preview/history only unless live posting is explicitly authorized;
5. enforce `max_items_per_run: 1` by default;
6. announce candidates, blockers, or a clean no-op.

For queue workspaces, the scheduled prompt should say to:

1. read `user-setup.json`, `queue.jsonl`, `state.json`, and `logs/`;
2. select the next eligible item not completed, skipped, blocked, or locked;
3. stop at draft/preview if `publish_mode` or `run_policy.approval` is manual;
4. update `state.json` and append a concise log entry after each meaningful outcome;
5. capture proof URL/screenshot only when useful and privacy-safe.

Example OpenClaw CLI command:

```bash
openclaw cron add \
  --name "Repost workspace preview" \
  --cron "0 10 * * *" \
  --tz "Europe/London" \
  --session isolated \
  --message "Use the repost-with-agent skill with ~/repost_with_agent_workspace. Read user-setup.json, queue.jsonl, state.json, and logs; process at most 1 eligible item; stop at draft/preview when publish_mode or approval is manual; update state/logs; announce the result." \
  --announce
```

Keep the schedule in `user-setup.json.run_policy.schedule` too, so humans and future agents can see the intended cadence even if the host cron job is edited separately.

## Example successful setup

```text
User: Make a pair from my LinkedIn posts to my X.
Agent: Let’s make a reusable repost pair. I’ll use LinkedIn as the source and X as the destination. Which LinkedIn profile/activity URL should I watch?
User: https://www.linkedin.com/in/example/recent-activity/all/
Agent: Great. Which X account should receive posts?
User: @example
Agent: I’ll check login/auth and run a preview. Nothing will be posted yet.
Agent: I found 2 candidate posts; 1 looks new, 1 looks already posted. Here is the draft for the new one...
User: Save it as LinkedIn to X and run daily around 10am.
Agent: Saved. I’ll put that cadence in the run policy/schedule. It will run in preview/approval mode until you explicitly enable live posting.
```

## Safety wording

Use this framing:

- “responsible automation”
- “preview-first”
- “avoid accidental spam/duplicates”
- “respect platform login/security prompts”
- “official APIs where possible”

Avoid this framing:

- “ban evasion”
- “anti-detection”
- “human-like stealth”
- “bypass CAPTCHA/2FA”
