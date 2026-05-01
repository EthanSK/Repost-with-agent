// Regression tests for the backfill mode. Pure-function tests + a fully
// mocked end-to-end runBackfill() so we never hit network or Playwright.
// Run via `npm test`.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Steer runtime IO into an isolated tmp dir so this test never touches the
// real ~/.repost-with-agent state. Must be set before requiring config.js.
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rwa-backfill-test-"));
process.env.REPOST_DATA_DIR = tmpDataDir;

const {
  buildBackfillPlan,
  fetchAllPages,
  orderOldestFirst,
  runBackfill,
} = require("../dist/core/backfill.js");
const { contentHash } = require("../dist/core/dedupe.js");
const {
  ensurePairDirs,
  appendPostedHistory,
  loadAuditHistory,
  loadPostedHistory,
} = require("../dist/core/runtime.js");

// ---------- Fixtures ----------
const pair = {
  id: "test-backfill-pair",
  name: "Test Backfill Pair",
  enabled: true,
  mode: "live-approved",
  source: {
    type: "mock-source",
    url: "https://example.test/profile",
  },
  destination: {
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
    metadata: { adapter: "mock-source" },
  };
}

// ---------- 1. orderOldestFirst — explicit publishedAt sort + tie-break ----------
{
  const a = { id: "a", publishedAt: "2026-05-01T00:00:00.000Z" };
  const b = { id: "b", publishedAt: "2026-04-30T00:00:00.000Z" };
  const c = { id: "c", publishedAt: "2026-04-30T00:00:00.000Z" };
  const out = orderOldestFirst([a, b, c]);
  assert.deepEqual(out.map((x) => x.id), ["b", "c", "a"]);
}

// ---------- 2. orderOldestFirst — fallback when no publishedAt ----------
{
  // Original order is newest-first (typical of the LinkedIn scraper).
  // Without publishedAt, the function reverses to produce oldest-first.
  const items = [
    { id: "newest" },
    { id: "middle" },
    { id: "oldest" },
  ];
  const out = orderOldestFirst(items);
  assert.deepEqual(out.map((x) => x.id), ["oldest", "middle", "newest"]);
}

// ---------- 3. buildBackfillPlan — pagination boundary, no double-counting ----------
{
  const page1 = [makeItem(1), makeItem(2), makeItem(3)];
  // Item 3 appears on both pages (LinkedIn re-renders); dedupe must not
  // include it twice.
  const page2 = [makeItem(3), makeItem(4), makeItem(5)];
  const plan = buildBackfillPlan({
    pair,
    pages: [
      { page: 1, items: page1 },
      { page: 2, items: page2 },
    ],
    posted: [],
    options: { max: 20, pages: 2, pageSize: 3, intervalMinutes: 10, allowPublish: false },
    destinationLookupSupported: false,
    generatedAt: new Date("2026-05-02T00:00:00.000Z"),
  });
  assert.equal(plan.totalConsidered, 5, "should dedupe page boundary item-3");
  // Without publishedAt, oldest-first reverses original order. Combined
  // (deduped) order is item-1, item-2, item-3, item-4, item-5; reversed:
  // item-5, item-4, item-3, item-2, item-1.
  assert.deepEqual(
    plan.candidates.map((c) => c.sourceItemId),
    ["item-5", "item-4", "item-3", "item-2", "item-1"]
  );
}

// ---------- 4. buildBackfillPlan — local dedupe filters posted items ----------
{
  const items = [makeItem(1), makeItem(2), makeItem(3)];
  const posted = [
    {
      sourceItemId: items[1].sourceItemId, // item-2 already posted
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
    destinationLookupSupported: false,
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
    destinationLookupSupported: false,
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
    destinationLookupSupported: false,
    generatedAt: baseTime,
  });
  for (let i = 0; i < plan.candidates.length; i += 1) {
    const expected = new Date(baseTime.getTime() + i * 10 * 60 * 1000).toISOString();
    assert.equal(plan.candidates[i].scheduledAt, expected, `candidate ${i} schedule`);
  }
}

// ---------- 7. fetchAllPages — uses fetchPage when present ----------
async function pageFetchTest() {
  let calls = 0;
  const source = {
    type: "mock-source",
    async test() { return { ok: true, status: "ok", message: "ok" }; },
    async fetchCandidates() { return []; },
    async fetchPage(_pair, opts) {
      calls += 1;
      return {
        items: [makeItem(opts.page * 100)],
        hasMore: opts.page < 2,
      };
    },
  };
  const pages = await fetchAllPages(pair, source, 2, 5);
  assert.equal(calls, 2, "fetchPage should be called once per page");
  assert.equal(pages.length, 2);
  assert.equal(pages[0].items[0].sourceItemId, "item-100");
  assert.equal(pages[1].items[0].sourceItemId, "item-200");
}

// ---------- 8. fetchAllPages — falls back to fetchCandidates when no fetchPage ----------
async function pageFallbackTest() {
  const source = {
    type: "mock-source",
    async test() { return { ok: true, status: "ok", message: "ok" }; },
    async fetchCandidates() { return [makeItem(42)]; },
  };
  const pages = await fetchAllPages(pair, source, 3, 5);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].items[0].sourceItemId, "item-42");
}

// ---------- 9. runBackfill — dry run produces plan, doesn't publish ----------
async function dryRunTest() {
  const fixturePair = { ...pair, id: "test-backfill-dryrun" };
  ensurePairDirs(fixturePair.id);
  const items = [makeItem(101), makeItem(102), makeItem(103)];
  const source = {
    type: "mock-source",
    async test() { return { ok: true, status: "ok", message: "ok" }; },
    async fetchCandidates() { return items; },
    async fetchPage() { return { items, hasMore: false }; },
  };
  let publishCalls = 0;
  const destination = {
    type: "mock-destination",
    async test() { return { ok: true, status: "ok", message: "ok" }; },
    async preview(item) {
      return { destinationType: "mock-destination", text: item.text, warnings: [] };
    },
    async publish() {
      publishCalls += 1;
      return { success: true, destinationId: "should-not-happen" };
    },
  };
  const lines = [];
  const result = await runBackfill(fixturePair, source, destination, {
    max: 5,
    pages: 1,
    pageSize: 10,
    intervalMinutes: 0,
    dryRun: true,
    allowPublish: false,
    sleep: async () => {},
    writeLine: (line) => lines.push(line),
    now: () => new Date("2026-05-02T12:00:00.000Z"),
  });
  assert.equal(publishCalls, 0, "dry-run must not publish");
  assert.equal(result.dryRun, true);
  assert.equal(result.totals.dryRunSkipped, 3);
  assert.equal(result.totals.published, 0);
  assert.equal(result.plan.candidates.length, 3);
  assert.ok(lines.some((l) => l.includes("[backfill] start")));
  assert.ok(lines.some((l) => l.includes("[backfill] plan")));
  assert.ok(lines.some((l) => l.includes("[backfill] complete")));
  // Audit events must include start, plan, complete.
  const audit = loadAuditHistory(fixturePair.id);
  const events = audit.map((e) => e.event);
  assert.ok(events.includes("pair.backfill.start"));
  assert.ok(events.includes("pair.backfill.plan"));
  assert.ok(events.includes("pair.backfill.complete"));
}

// ---------- 10. runBackfill — destination dedupe filter (mocked) ----------
async function destinationDedupeTest() {
  const fixturePair = { ...pair, id: "test-backfill-destdedupe" };
  ensurePairDirs(fixturePair.id);
  const items = [makeItem(201), makeItem(202), makeItem(203)];
  const source = {
    type: "mock-source",
    async test() { return { ok: true, status: "ok", message: "ok" }; },
    async fetchCandidates() { return items; },
    async fetchPage() { return { items, hasMore: false }; },
  };
  const published = [];
  const destination = {
    type: "mock-destination",
    async test() { return { ok: true, status: "ok", message: "ok" }; },
    async preview(item) {
      return { destinationType: "mock-destination", text: item.text, warnings: [] };
    },
    async publish(item) {
      const id = `mock-${item.sourceItemId}`;
      published.push(id);
      return { success: true, destinationId: id, destinationUrl: `https://mock/${id}` };
    },
    async findExistingPost(draft) {
      // Pretend item-202 is already on the destination.
      if (draft.text.includes("number 202")) {
        return { exists: true, id: "destination-202", url: "https://mock/destination-202", reason: "mock prefix match" };
      }
      return { exists: false, reason: "no match" };
    },
  };
  const lines = [];
  const result = await runBackfill(fixturePair, source, destination, {
    max: 5,
    pages: 1,
    intervalMinutes: 0,
    allowPublish: true,
    dryRun: false,
    sleep: async () => {},
    writeLine: (line) => lines.push(line),
    now: () => new Date("2026-05-02T12:00:00.000Z"),
  });
  assert.equal(result.totals.published, 2, "should publish 2 of 3 items");
  assert.equal(result.totals.skippedDestination, 1, "should skip 1 by destination dedupe");
  assert.equal(published.length, 2);
  assert.ok(!published.some((id) => id.endsWith("item-202")), "item-202 must not be published");
  // posted.jsonl should contain 2 published + 1 destination-dedupe entry (for future short-circuit).
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
  const source = {
    type: "mock-source",
    async test() { return { ok: true, status: "ok", message: "ok" }; },
    async fetchCandidates() { return items; },
    async fetchPage() { return { items, hasMore: false }; },
  };
  const published = [];
  const destination = {
    type: "mock-destination",
    async test() { return { ok: true, status: "ok", message: "ok" }; },
    async preview(item) {
      return { destinationType: "mock-destination", text: item.text, warnings: [] };
    },
    async publish(item) {
      const id = `mock-${item.sourceItemId}`;
      published.push(id);
      return { success: true, destinationId: id, destinationUrl: `https://mock/${id}` };
    },
  };
  // First run: succeeds and produces 3 entries in posted.jsonl + clears state.
  const r1 = await runBackfill(fixturePair, source, destination, {
    max: 5,
    pages: 1,
    intervalMinutes: 0,
    allowPublish: true,
    dryRun: false,
    sleep: async () => {},
    writeLine: () => {},
    now: () => new Date("2026-05-02T12:00:00.000Z"),
  });
  assert.equal(r1.totals.published, 3);
  // Second run: every candidate is in posted.jsonl now → skip-local for each.
  const r2 = await runBackfill(fixturePair, source, destination, {
    max: 5,
    pages: 1,
    intervalMinutes: 0,
    allowPublish: true,
    dryRun: false,
    sleep: async () => {},
    writeLine: () => {},
    now: () => new Date("2026-05-02T13:00:00.000Z"),
  });
  assert.equal(r2.totals.published, 0, "second run must publish nothing");
  // skippedLocal lives in the plan's pre-filter; the candidates list is empty
  // because all items are filtered out at plan time.
  assert.equal(r2.plan.candidates.length, 0, "all items filtered at plan time");
  assert.equal(r2.plan.skippedLocal, 3, "all 3 items recognized as already published");
  assert.equal(published.length, 3, "publish() must only have run 3 times total across both runs");
}

// ---------- 12. runBackfill — auth-failed halts the backfill ----------
async function authFailedTest() {
  const fixturePair = { ...pair, id: "test-backfill-authfail" };
  ensurePairDirs(fixturePair.id);
  const items = [makeItem(401), makeItem(402), makeItem(403)];
  const source = {
    type: "mock-source",
    async test() { return { ok: true, status: "ok", message: "ok" }; },
    async fetchCandidates() { return items; },
    async fetchPage() { return { items, hasMore: false }; },
  };
  let testCalls = 0;
  const destination = {
    type: "mock-destination",
    async test() {
      testCalls += 1;
      return { ok: false, status: "needs-config", message: "auth missing" };
    },
    async preview(item) {
      return { destinationType: "mock-destination", text: item.text, warnings: [] };
    },
    async publish() {
      return { success: false, error: "should not be called" };
    },
  };
  const result = await runBackfill(fixturePair, source, destination, {
    max: 5,
    pages: 1,
    intervalMinutes: 0,
    allowPublish: true,
    dryRun: false,
    sleep: async () => {},
    writeLine: () => {},
    now: () => new Date("2026-05-02T12:00:00.000Z"),
  });
  assert.equal(result.totals.failed, 1, "first auth failure recorded");
  assert.equal(result.totals.published, 0);
  assert.equal(testCalls, 1, "auth check should halt after first failure");
  assert.ok(result.items.some((i) => i.decision === "auth-failed"));
}

// ---------- Run async tests sequentially ----------
(async () => {
  await pageFetchTest();
  await pageFallbackTest();
  await dryRunTest();
  await destinationDedupeTest();
  await idempotentTest();
  await authFailedTest();
  console.log("backfill regression passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
