// Regression tests for the scheduling layer. Pure-function tests only — no
// network, no Playwright, no real OpenClaw. Run via `npm test`.
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  parseCronToCalendar,
  renderLaunchdPlist,
  renderCrontabLine,
  renderOpenClawCronCommand,
  renderShellCommand,
  buildScheduledRunArgv,
  isMinDelayWindowOpen,
} = require("../dist/core/scheduling.js");

const basePair = {
  id: "test-pair",
  name: "Test pair",
  enabled: true,
  mode: "preview-only",
  source: {
    type: "linkedin-profile-activity",
    url: "https://www.linkedin.com/in/example/",
  },
  destination: {
    type: "x-account",
    accountHint: "@example",
  },
  schedule: { kind: "manual", tz: "Europe/London" },
  policy: {
    requirePreviewBeforeFirstLiveRun: true,
    maxItemsPerRun: 1,
    minDelayBetweenPostsMinutes: 60,
    preferOfficialApi: true,
    blockOnUncertainDuplicate: true,
  },
  dedupe: { strategy: "source-id-url-content-hash" },
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-01T00:00:00.000Z",
};

// 1. Cron parser handles 5-field cron expressions and rejects malformed ones.
assert.deepEqual(parseCronToCalendar("0 10 * * *"), { Minute: 0, Hour: 10 });
assert.deepEqual(parseCronToCalendar("30 9 1 * *"), {
  Minute: 30,
  Hour: 9,
  Day: 1,
});
assert.deepEqual(parseCronToCalendar("0 19 * * 5"), {
  Minute: 0,
  Hour: 19,
  Weekday: 5,
});
assert.equal(parseCronToCalendar(""), null);
assert.equal(parseCronToCalendar("0 10"), null);
assert.equal(parseCronToCalendar("not a cron"), null);

// 2. Argv builder uses dist/index.js and the pair id, with optional
//    --allow-publish flag when requested.
const argvA = buildScheduledRunArgv({ pair: basePair, repoDir: "/tmp/repo" });
assert.deepEqual(argvA.slice(1), ["pair", "scheduled-run", "test-pair"]);
assert.ok(argvA[0].endsWith(path.join("dist", "index.js")));

const argvB = buildScheduledRunArgv({
  pair: basePair,
  repoDir: "/tmp/repo",
  allowPublish: true,
});
assert.ok(argvB.includes("--allow-publish"));

// 3. Manual schedule does NOT emit StartCalendarInterval (would auto-fire on
//    load) — only a comment.
const manual = renderLaunchdPlist({ pair: basePair, repoDir: "/tmp/repo" });
assert.match(manual.contents, /Label/);
assert.match(manual.contents, /com\.repost-with-agent\.test-pair/);
assert.doesNotMatch(manual.contents, /StartCalendarInterval/);
assert.match(manual.contents, /<key>RunAtLoad<\/key>\s*<false\/>/);

// 4. Cron schedule renders a launchd StartCalendarInterval with the right
//    fields, omitting wildcards.
const cronPair = {
  ...basePair,
  schedule: { ...basePair.schedule, kind: "cron", expression: "0 10 * * *" },
};
const cronPlist = renderLaunchdPlist({ pair: cronPair, repoDir: "/tmp/repo" });
assert.match(cronPlist.contents, /<key>StartCalendarInterval<\/key>/);
assert.match(cronPlist.contents, /<key>Minute<\/key>\s*<integer>0<\/integer>/);
assert.match(cronPlist.contents, /<key>Hour<\/key>\s*<integer>10<\/integer>/);
assert.doesNotMatch(cronPlist.contents, /<key>Day<\/key>/);
assert.doesNotMatch(cronPlist.contents, /<key>Weekday<\/key>/);

// 5. Every-N-minutes schedule renders StartInterval (seconds).
const everyPair = {
  ...basePair,
  schedule: { ...basePair.schedule, kind: "every", everyMinutes: 30 },
};
const everyPlist = renderLaunchdPlist({
  pair: everyPair,
  repoDir: "/tmp/repo",
});
assert.match(everyPlist.contents, /<key>StartInterval<\/key>\s*<integer>1800<\/integer>/);

// 6. Crontab line uses the pair's cron expression when present, falls back to
//    daily otherwise.
const cronLine = renderCrontabLine({ pair: cronPair, repoDir: "/tmp/repo" });
assert.match(cronLine, /^0 10 \* \* \* /);
assert.match(cronLine, /scheduled-run test-pair/);
const fallbackLine = renderCrontabLine({ pair: basePair, repoDir: "/tmp/repo" });
assert.match(fallbackLine, /^0 10 \* \* \* /);

// 7. OpenClaw cron command embeds the right pair id, cron expr, and tz.
const ocCmd = renderOpenClawCronCommand({
  pair: cronPair,
  repoDir: "/tmp/repo",
});
assert.match(ocCmd, /openclaw cron add/);
assert.match(ocCmd, /scheduled-run test-pair/);
assert.match(ocCmd, /'0 10 \* \* \*'/);
assert.match(ocCmd, /Europe\/London/);
// must NOT include --allow-publish in the actual scheduled-run invocation
// unless explicitly requested (the prose mentions it as a warning).
assert.doesNotMatch(ocCmd, /scheduled-run test-pair --allow-publish/);

const ocCmdLive = renderOpenClawCronCommand({
  pair: cronPair,
  repoDir: "/tmp/repo",
  allowPublish: true,
});
assert.match(ocCmdLive, /scheduled-run test-pair --allow-publish/);

// 8. Direct shell invocation contains the absolute repo path + scheduled-run.
const shell = renderShellCommand({ pair: basePair, repoDir: "/tmp/repo" });
assert.match(shell, /scheduled-run test-pair/);

// 9. Min-delay enforcement: window is open when no prior post exists.
const open0 = isMinDelayWindowOpen(basePair, new Date(), null);
assert.equal(open0.open, true);
assert.equal(open0.remainingMinutes, 0);

// 10. Min-delay enforcement: closed when a post happened recently.
const recent = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
const closed = isMinDelayWindowOpen(basePair, new Date(), recent);
assert.equal(closed.open, false);
assert.ok(closed.remainingMinutes >= 49 && closed.remainingMinutes <= 51);

// 11. Min-delay enforcement: open after the configured window passes.
const longAgo = new Date(Date.now() - 120 * 60 * 1000); // 2 hours ago
const open2 = isMinDelayWindowOpen(basePair, new Date(), longAgo);
assert.equal(open2.open, true);

// 12. Min-delay enforcement: zero policy means always open.
const zeroPolicyPair = {
  ...basePair,
  policy: { ...basePair.policy, minDelayBetweenPostsMinutes: 0 },
};
const open3 = isMinDelayWindowOpen(zeroPolicyPair, new Date(), recent);
assert.equal(open3.open, true);

console.log("scheduling regression passed");
