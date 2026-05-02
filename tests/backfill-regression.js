// Regression tests for the v3.0.0 backfill mode. Pure-function tests +
// fully mocked end-to-end runBackfill() via an in-process agent task
// handler. No browser, no API. Run via `npm test`.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Steer runtime IO into an isolated tmp dir so this test never touches the
// real ~/.repost-with-agent state.
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rwa-backfill-test-"));
process.env.REPOST_DATA_DIR = tmpDataDir;

const {
  buildBackfillPlan,
  fetchAllPages,
  orderNewestFirst,
  runBackfill,
} = require("../dist/core/backfill.js");
const { contentHash } = require("../dist/core/dedupe.js");
const {
  ensurePairDirs,
  loadAuditHistory,
  loadPostedHistory,
} = require("../dist/core/runtime.js");

// ---------- Fixtures ----------
const pair = {
  id: "test-backfill-pair",
  name: "Test Backfill Pair",
  enabled: true,
  mode: "live-approved",
  runMode: "backfill",
  source: {
    platform: "mock-source",
    type: "mock-source",
    url: "https://example.test/profile",
  },
  destination: {
    platform: "mock-destination",
    type: "mock-destination",
    accountHint: "@mock",
  },
  schedule: { kind: "manual", tz: "UTC" },
  policy: {
    requirePreviewBeforeFirstLiveRun: true,
    maxItemsPerRun: 1,
    minDelayBetweenPostsMinutes: 0,
    preferOfficialApi: true,
    blockOnUncertainDuplicate: true,
  },
  dedupe: { strategy: "source-id-url-content-hash" },
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-01T00:00:00.000Z",
  schemaVersion: 3,
};

ensurePairDirs(pair.id);

function makeItem(idx, opts = {}) {
  const id = opts.sourceItemId ?? `item-${idx}`;
  const url = opts.canonicalUrl ?? `https://example.test/post/${idx}`;
  return {
    sourceItemId: id,
    canonicalUrl: url,
    text: opts.text ?? `Backfill item number ${idx} text body content here.`,
    publishedAt: opts.publishedAt,
  };
}

/**
 * Build a mock agent task handler. Tests pass in (a) the items the source
 * task should return, plus optional handlers for post + check tasks.
 */
function makeAgentHandler(opts) {
  return async function handler(task) {
    if (task.kind === "fetch-source") {
      const items = typeof opts.fetchItems === "function"
        ? opts.fetchItems(task)
        : opts.fetchItems || [];
      return {
        kind: "fetch-source-result",
        correlation_id: task.correlation_id,
        items,
        hasMore: opts.hasMore ?? false,
        auth_message: "mock source ok",
      };
    }
    if (task.kind === "post-to-destination") {
      if (opts.postHandler) return opts.postHandler(task);
      return {
        kind: "post-to-destination-result",
        correlation_id: task.correlation_id,
        posted_url: `https://mock/${task.correlation_id}`,
        posted_id: `mock-id-${task.correlation_id}`,
        posted_at: "2026-05-02T12:00:00.000Z",
      };
    }
    if (task.kind === "check-destination") {
      if (opts.checkHandler) return opts.checkHandler(task);
      return {
        kind: "check-destination-result",
        correlation_id: task.correlation_id,
        exists: false,
        reason: "mock no match",
      };
    }
    throw new Error(`Unhandled task kind: ${task.kind}`);
  };
}

// ---------- 1. orderNewestFirst — explicit publishedAt sort + tie-break ----------
{
  const a = { id: "a", publishedAt: "2026-05-01T00:00:00.000Z" };
  const b = { id: "b", publishedAt: "2026-04-30T00:00:00.000Z" };
  const c = { id: "c", publishedAt: "2026-04-30T00:00:00.000Z" };
  const out = orderNewestFirst([a, b, c]);
  // newest first: a (2026-05-01), then b/c tied (stable original order: b, c).
  assert.deepEqual(out.map((x) => x.id), ["a", "b", "c"]);
}

// ---------- 2. orderNewestFirst — fallback when no publishedAt ----------
{
  // Original order is newest-first (typical of LinkedIn/X scrapers).
  // Without publishedAt, the function preserves the original order.
  const items = [
    { id: "newest" },
    { id: "middle" },
    { id: "oldest" },
  ];
  const out = orderNewestFirst(items);
  assert.deepEqual(out.map((x) => x.id), ["newest", "middle", "oldest"]);
}

// ---------- 3. buildBackfillPlan — pagination boundary, no double-counting ----------
{
  const page1 = [makeItem(1), makeItem(2), makeItem(3)];
  const page2 = [makeItem(3), makeItem(4), makeItem(5)];
  const plan = buildBackfillPlan({
    pair,
    pages: [
      { page: 1, items: page1 },
      { page: 2, items: page2 },
    ],
    posted: [],
    options: { max: 20, pages: 2, pageSize: 3, intervalMinutes: 10, allowPublish: false },
    destinationLookupSupported: true,
    generatedAt: new Date("2026-05-02T00:00:00.000Z"),
  });
  assert.equal(plan.totalConsidered, 5, "should dedupe page boundary item-3");
  // v3.0.0: newest-first preserves source order (page1 then page2 dedupe).
  // Combined deduped order: item-1, item-2, item-3, item-4, item-5.
  assert.deepEqual(
    plan.candidates.map((c) => c.sourceItemId),
    ["item-1", "item-2", "item-3", "item-4", "item-5"]
  );
}

// ---------- 4. buildBackfillPlan — local dedupe filters posted items ----------
{
  const items = [makeItem(1), makeItem(2), makeItem(3)];
  const posted = [
    {
      sourceItemId: items[1].sourceItemId,
      canonicalUrl: items[1].canonicalUrl,
      contentHash: contentHash(items[1].text),
      destinationType: "mock-destination",
      destinationId: "mock-tweet-1",
      postedAt: "2026-04-29T00:00:00.000Z",
      summary: items[1].text.slice(0, 120),
    },
  ];
  const plan = buildBackfillPlan({
    pair,
    pages: [{ page: 1, items }],
    posted,
    options: { max: 20, pages: 1, pageSize: 10, intervalMinutes: 10, allowPublish: false },
    destinationLookupSupported: true,
    generatedAt: new Date("2026-05-02T00:00:00.000Z"),
  });
  assert.equal(plan.skippedLocal, 1, "item-2 should be skip-local");
  assert.equal(plan.candidates.length, 2, "only item-1 and item-3 should remain");
  for (const c of plan.candidates) {
    assert.notEqual(c.sourceItemId, "item-2");
  }
}

// ---------- 5. buildBackfillPlan — cap enforcement (--max) ----------
{
  const items = Array.from({ length: 30 }, (_, i) => makeItem(i + 1));
  const plan = buildBackfillPlan({
    pair,
    pages: [{ page: 1, items }],
    posted: [],
    options: { max: 20, pages: 1, pageSize: 30, intervalMinutes: 10, allowPublish: false },
    destinationLookupSupported: true,
    generatedAt: new Date("2026-05-02T00:00:00.000Z"),
  });
  assert.equal(plan.candidates.length, 20, "must cap at --max=20");
}

// ---------- 6. buildBackfillPlan — interval scheduling math ----------
{
  const items = Array.from({ length: 5 }, (_, i) => makeItem(i + 1));
  const baseTime = new Date("2026-05-02T12:00:00.000Z");
  const plan = buildBackfillPlan({
    pair,
    pages: [{ page: 1, items }],
    posted: [],
    options: { max: 5, pages: 1, pageSize: 10, intervalMinutes: 10, allowPublish: false },
    destinationLookupSupported: true,
    generatedAt: baseTime,
  });
  for (let i = 0; i < plan.candidates.length; i += 1) {
    const expected = new Date(baseTime.getTime() + i * 10 * 60 * 1000).toISOString();
    assert.equal(plan.candidates[i].scheduledAt, expected, `candidate ${i} schedule`);
  }
}

// ---------- 7. fetchAllPages — uses the agent fetch task ----------
async function pageFetchTest() {
  let calls = 0;
  const handler = async (task) => {
    if (task.kind !== "fetch-source") {
      throw new Error("unexpected kind");
    }
    calls += 1;
    return {
      kind: "fetch-source-result",
      correlation_id: task.correlation_id,
      items: [makeItem(task.page * 100)],
      hasMore: task.page < 2,
    };
  };
  const pages = await fetchAllPages(pair, 2, 5, { handler });
  assert.equal(calls, 2, "fetch-source task should fire once per page");
  assert.equal(pages.length, 2);
  assert.equal(pages[0].items[0].sourceItemId, "item-100");
  assert.equal(pages[1].items[0].sourceItemId, "item-200");
}

// ---------- 8. fetchAllPages — bails when hasMore=false on a non-final page ----------
async function pageEarlyBailTest() {
  const handler = async (task) => ({
    kind: "fetch-source-result",
    correlation_id: task.correlation_id,
    items: [makeItem(42)],
    hasMore: false,
  });
  const pages = await fetchAllPages(pair, 3, 5, { handler });
  assert.equal(pages.length, 1, "should stop after first page when hasMore=false");
  assert.equal(pages[0].items[0].sourceItemId, "item-42");
}

// ---------- 9. runBackfill — dry run produces plan, doesn't publish ----------
async function dryRunTest() {
  const fixturePair = { ...pair, id: "test-backfill-dryrun" };
  ensurePairDirs(fixturePair.id);
  const items = [makeItem(101), makeItem(102), makeItem(103)];
  let postCalls = 0;
  const handler = makeAgentHandler({
    fetchItems: items,
    postHandler: () => {
      postCalls += 1;
      return {
        kind: "post-to-destination-result",
        correlation_id: "should-not-happen",
        posted_url: "https://mock/should-not-happen",
        posted_at: "2026-05-02T12:00:00.000Z",
      };
    },
  });
  const lines = [];
  const result = await runBackfill(fixturePair, {
    max: 5,
    pages: 1,
    pageSize: 10,
    intervalMinutes: 0,
    dryRun: true,
    allowPublish: false,
    sleep: async () => {},
    writeLine: (line) => lines.push(line),
    now: () => new Date("2026-05-02T12:00:00.000Z"),
    agent: { handler },
    destinationMaxLength: null,
  });
  assert.equal(postCalls, 0, "dry-run must not publish");
  assert.equal(result.dryRun, true);
  assert.equal(result.totals.dryRunSkipped, 3);
  assert.equal(result.totals.published, 0);
  assert.equal(result.plan.candidates.length, 3);
  assert.ok(lines.some((l) => l.includes("[backfill] start")));
  assert.ok(lines.some((l) => l.includes("[backfill] plan")));
  assert.ok(lines.some((l) => l.includes("[backfill] complete")));
  const audit = loadAuditHistory(fixturePair.id);
  const events = audit.map((e) => e.event);
  assert.ok(events.includes("pair.backfill.start"));
  assert.ok(events.includes("pair.backfill.plan"));
  assert.ok(events.includes("pair.backfill.complete"));
}

// ---------- 10. runBackfill — destination dedupe filter (mocked agent) ----------
async function destinationDedupeTest() {
  const fixturePair = { ...pair, id: "test-backfill-destdedupe" };
  ensurePairDirs(fixturePair.id);
  const items = [makeItem(201), makeItem(202), makeItem(203)];
  const published = [];
  const handler = makeAgentHandler({
    fetchItems: items,
    checkHandler: (task) => {
      if (task.candidate_text.includes("number 202")) {
        return {
          kind: "check-destination-result",
          correlation_id: task.correlation_id,
          exists: true,
          posted_id: "destination-202",
          url: "https://mock/destination-202",
          reason: "mock prefix match",
        };
      }
      return {
        kind: "check-destination-result",
        correlation_id: task.correlation_id,
        exists: false,
        reason: "no match",
      };
    },
    postHandler: (task) => {
      published.push(task.draft_text);
      return {
        kind: "post-to-destination-result",
        correlation_id: task.correlation_id,
        posted_url: `https://mock/${task.correlation_id}`,
        posted_id: `mock-id-${task.correlation_id}`,
        posted_at: "2026-05-02T12:00:00.000Z",
      };
    },
  });
  const lines = [];
  const result = await runBackfill(fixturePair, {
    max: 5,
    pages: 1,
    intervalMinutes: 0,
    allowPublish: true,
    dryRun: false,
    sleep: async () => {},
    writeLine: (line) => lines.push(line),
    now: () => new Date("2026-05-02T12:00:00.000Z"),
    agent: { handler },
    destinationMaxLength: null,
  });
  assert.equal(result.totals.published, 2, "should publish 2 of 3 items");
  assert.equal(result.totals.skippedDestination, 1, "should skip 1 by destination dedupe");
  assert.equal(published.length, 2);
  for (const text of published) {
    assert.ok(!text.includes("number 202"), "item-202 must not be published");
  }
  const posted = loadPostedHistory(fixturePair.id);
  assert.equal(posted.length, 3, "posted.jsonl must record both publish + destination-dedupe entries");
  const destSkip = posted.find((p) => p.importedFrom === "backfill-destination-dedupe");
  assert.ok(destSkip, "destination-dedupe entry must be tagged as such");
}

// ---------- 11. runBackfill — idempotent restart skips already-published ----------
async function idempotentTest() {
  const fixturePair = { ...pair, id: "test-backfill-idempotent" };
  ensurePairDirs(fixturePair.id);
  const items = [makeItem(301), makeItem(302), makeItem(303)];
  const published = [];
  const handler = makeAgentHandler({
    fetchItems: items,
    postHandler: (task) => {
      published.push(task.draft_text);
      return {
        kind: "post-to-destination-result",
        correlation_id: task.correlation_id,
        posted_url: `https://mock/${task.correlation_id}`,
        posted_id: `mock-id-${task.correlation_id}`,
        posted_at: "2026-05-02T12:00:00.000Z",
      };
    },
  });
  const r1 = await runBackfill(fixturePair, {
    max: 5,
    pages: 1,
    intervalMinutes: 0,
    allowPublish: true,
    dryRun: false,
    sleep: async () => {},
    writeLine: () => {},
    now: () => new Date("2026-05-02T12:00:00.000Z"),
    agent: { handler },
    destinationMaxLength: null,
  });
  assert.equal(r1.totals.published, 3);
  const r2 = await runBackfill(fixturePair, {
    max: 5,
    pages: 1,
    intervalMinutes: 0,
    allowPublish: true,
    dryRun: false,
    sleep: async () => {},
    writeLine: () => {},
    now: () => new Date("2026-05-02T13:00:00.000Z"),
    agent: { handler },
    destinationMaxLength: null,
  });
  assert.equal(r2.totals.published, 0, "second run must publish nothing");
  assert.equal(r2.plan.candidates.length, 0, "all items filtered at plan time");
  assert.equal(r2.plan.skippedLocal, 3, "all 3 items recognized as already published");
  assert.equal(published.length, 3, "post task must only have run 3 times total across both runs");
}

// ---------- 12. runBackfill — auth-failed halts the backfill ----------
async function authFailedTest() {
  const fixturePair = { ...pair, id: "test-backfill-authfail" };
  ensurePairDirs(fixturePair.id);
  const items = [makeItem(401), makeItem(402), makeItem(403)];
  let postAttempts = 0;
  const handler = async (task) => {
    if (task.kind === "fetch-source") {
      return {
        kind: "fetch-source-result",
        correlation_id: task.correlation_id,
        items,
      };
    }
    if (task.kind === "check-destination") {
      return {
        kind: "check-destination-result",
        correlation_id: task.correlation_id,
        exists: false,
      };
    }
    if (task.kind === "post-to-destination") {
      postAttempts += 1;
      return {
        kind: "error-result",
        correlation_id: task.correlation_id,
        error: "auth missing",
        category: "needs-config",
      };
    }
    throw new Error("unexpected");
  };
  const result = await runBackfill(fixturePair, {
    max: 5,
    pages: 1,
    intervalMinutes: 0,
    allowPublish: true,
    dryRun: false,
    sleep: async () => {},
    writeLine: () => {},
    now: () => new Date("2026-05-02T12:00:00.000Z"),
    agent: { handler },
    destinationMaxLength: null,
  });
  assert.equal(result.totals.failed, 1, "first auth failure recorded");
  assert.equal(result.totals.published, 0);
  assert.equal(postAttempts, 1, "auth failure must halt after first attempt");
  assert.ok(result.items.some((i) => i.decision === "auth-failed"));
}

// ---------- Run async tests sequentially ----------
(async () => {
  await pageFetchTest();
  await pageEarlyBailTest();
  await dryRunTest();
  await destinationDedupeTest();
  await idempotentTest();
  await authFailedTest();
  console.log("backfill regression passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
