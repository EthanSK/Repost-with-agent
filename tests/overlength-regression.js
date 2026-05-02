// Regression tests for `pair backfill --overlength-strategy {skip,truncate}`.
// Exercises the plan-time filter + the publish-time truncate flag end-to-end
// through runBackfill with a fully mocked source/destination. Run via
// `npm test`.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rwa-overlength-test-"));
process.env.REPOST_DATA_DIR = tmpDataDir;

const { runBackfill, buildBackfillPlan } = require("../dist/core/backfill.js");
const {
  ensurePairDirs,
  loadAuditHistory,
} = require("../dist/core/runtime.js");

const pair = {
  id: "test-overlength-pair",
  name: "Test Overlength Pair",
  enabled: true,
  mode: "live-approved",
  source: { type: "mock-source", url: "https://example.test/profile" },
  destination: { type: "mock-destination", accountHint: "@mock" },
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
  return {
    sourceItemId: opts.sourceItemId ?? `item-${idx}`,
    canonicalUrl: opts.canonicalUrl ?? `https://example.test/post/${idx}`,
    text: opts.text ?? `mock-${idx}-body`,
    metadata: { adapter: "mock-source" },
  };
}

function buildMockDestination({ maxLength, capturePublished } = {}) {
  return {
    type: "mock-destination",
    maxLength,
    async test() {
      return { ok: true, status: "ok", message: "ok" };
    },
    async preview(item) {
      // Pass-through preview: draft text equals item.text. Tests control
      // length by setting item.text directly.
      return {
        destinationType: "mock-destination",
        text: item.text,
        warnings: [],
      };
    },
    async publish(item, draft) {
      const id = `mock-${item.sourceItemId}`;
      capturePublished?.push({ id, text: draft.text });
      return {
        success: true,
        destinationId: id,
        destinationUrl: `https://mock/${id}`,
      };
    },
  };
}

// ---------- 1. Strategy "skip" — overlength items filtered at plan time ----------
async function skipStrategyTest() {
  const fixturePair = { ...pair, id: "test-overlength-skip" };
  ensurePairDirs(fixturePair.id);
  const items = [
    makeItem(1, { text: "short post" }),
    makeItem(2, { text: "x".repeat(400) }), // way over 280
    makeItem(3, { text: "another short post" }),
  ];
  const source = {
    type: "mock-source",
    async test() { return { ok: true, status: "ok", message: "ok" }; },
    async fetchCandidates() { return items; },
    async fetchPage() { return { items, hasMore: false }; },
  };
  const destination = buildMockDestination({ maxLength: 280 });

  const lines = [];
  const result = await runBackfill(fixturePair, source, destination, {
    max: 5,
    pages: 1,
    intervalMinutes: 0,
    dryRun: true,
    allowPublish: false,
    overlengthStrategy: "skip",
    sleep: async () => {},
    writeLine: (line) => lines.push(line),
    now: () => new Date("2026-05-02T12:00:00.000Z"),
  });

  assert.equal(result.plan.skippedOverlength, 1, "expected 1 overlength skip");
  assert.equal(result.plan.truncatedCount, 0, "no truncations under skip strategy");
  // Plan candidates: item-1, item-2 (skip-too-long), item-3.
  // The skip-too-long item is INCLUDED in plan.candidates with that decision
  // so audit traces its ID, but doesn't enter the publish loop.
  const skipped = result.plan.candidates.find(
    (c) => c.decisionAtPlan === "skip-too-long"
  );
  assert.ok(skipped, "expected one candidate with decisionAtPlan=skip-too-long");
  assert.equal(skipped.sourceItemId, "item-2");
  assert.equal(skipped.draftChars, 400);
  assert.equal(skipped.destinationMaxLength, 280);

  // Audit event must be emitted.
  const audit = loadAuditHistory(fixturePair.id);
  const overlengthEvents = audit.filter(
    (e) => e.event === "pair.backfill.skipped_overlength"
  );
  assert.equal(overlengthEvents.length, 1, "expected 1 skipped_overlength audit event");
  assert.equal(overlengthEvents[0].details.sourceItemId, "item-2");
  assert.equal(overlengthEvents[0].details.draftChars, 400);
  assert.equal(overlengthEvents[0].details.destinationMaxLength, 280);
  assert.equal(overlengthEvents[0].details.strategy, "skip");
}

// ---------- 2. Strategy "truncate" — produces ≤maxLength output ----------
async function truncateStrategyTest() {
  const fixturePair = { ...pair, id: "test-overlength-truncate" };
  ensurePairDirs(fixturePair.id);
  const longText =
    "First sentence is fine. Second sentence is also fine. " +
    "Then we go on for a long time without much punctuation just rambling and rambling and rambling. ".repeat(
      6
    );
  const items = [
    makeItem(1, { text: "tiny" }),
    makeItem(2, { text: longText }),
  ];
  const source = {
    type: "mock-source",
    async test() { return { ok: true, status: "ok", message: "ok" }; },
    async fetchCandidates() { return items; },
    async fetchPage() { return { items, hasMore: false }; },
  };
  const published = [];
  const destination = buildMockDestination({
    maxLength: 280,
    capturePublished: published,
  });

  const result = await runBackfill(fixturePair, source, destination, {
    max: 5,
    pages: 1,
    intervalMinutes: 0,
    dryRun: false,
    allowPublish: true,
    overlengthStrategy: "truncate",
    sleep: async () => {},
    writeLine: () => {},
    now: () => new Date("2026-05-02T12:00:00.000Z"),
  });

  assert.equal(result.plan.skippedOverlength, 0);
  assert.equal(result.plan.truncatedCount, 1);
  // Both items should publish.
  assert.equal(result.totals.published, 2);
  assert.equal(result.totals.truncated, 1);

  // Verify the truncated post is actually within the cap when published.
  const longPublished = published.find((p) => p.id === "mock-item-2");
  assert.ok(longPublished);
  assert.ok(
    longPublished.text.length <= 280,
    `published text length ${longPublished.text.length} exceeds cap 280`
  );
  assert.ok(longPublished.text.endsWith("…"), "truncated post should end with ellipsis");
  // Tiny item should NOT have been truncated.
  const tinyPublished = published.find((p) => p.id === "mock-item-1");
  assert.equal(tinyPublished.text, "tiny");

  // Audit: pair.backfill.truncated emitted at plan time, and published.end
  // result has truncated:true.
  const audit = loadAuditHistory(fixturePair.id);
  const truncatedEvents = audit.filter(
    (e) => e.event === "pair.backfill.truncated"
  );
  assert.equal(truncatedEvents.length, 1);
  assert.equal(truncatedEvents[0].details.sourceItemId, "item-2");
  assert.equal(truncatedEvents[0].details.strategy, "truncate");
  assert.ok(truncatedEvents[0].details.originalDraftChars > 280);
  assert.ok(truncatedEvents[0].details.truncatedDraftChars <= 280);

  const publishEnds = audit.filter(
    (e) => e.event === "pair.backfill.publish.end" && e.details.decision === "published"
  );
  assert.equal(publishEnds.length, 2, "expected 2 publish.end events");
  const truncatedPublish = publishEnds.find((e) => e.details.sourceItemId === "item-2");
  assert.equal(truncatedPublish.details.truncated, true, "publish.end must record truncated:true");
  const tinyPublish = publishEnds.find((e) => e.details.sourceItemId === "item-1");
  // For non-truncated, the audit should either have truncated absent or undefined.
  assert.ok(
    tinyPublish.details.truncated === undefined ||
      tinyPublish.details.truncated === false,
    "non-truncated publish must not flag truncated"
  );
}

// ---------- 3. No maxLength on destination → strategy is a no-op ----------
async function noMaxLengthTest() {
  const fixturePair = { ...pair, id: "test-overlength-nomax" };
  ensurePairDirs(fixturePair.id);
  const items = [
    makeItem(1, { text: "x".repeat(1000) }),
  ];
  const source = {
    type: "mock-source",
    async test() { return { ok: true, status: "ok", message: "ok" }; },
    async fetchCandidates() { return items; },
    async fetchPage() { return { items, hasMore: false }; },
  };
  const destination = buildMockDestination({}); // no maxLength

  const result = await runBackfill(fixturePair, source, destination, {
    max: 5,
    pages: 1,
    intervalMinutes: 0,
    dryRun: true,
    allowPublish: false,
    overlengthStrategy: "skip",
    sleep: async () => {},
    writeLine: () => {},
    now: () => new Date("2026-05-02T12:00:00.000Z"),
  });

  // No maxLength → nothing is overlength regardless of size.
  assert.equal(result.plan.skippedOverlength, 0);
  assert.equal(result.plan.truncatedCount, 0);
  assert.equal(result.plan.candidates.length, 1);
  assert.equal(result.plan.candidates[0].decisionAtPlan, "publish");
}

// ---------- 4. buildBackfillPlan — pure-function overlength filtering ----------
{
  const items = [
    { sourceItemId: "a", canonicalUrl: "https://e.test/a", text: "short" },
    { sourceItemId: "b", canonicalUrl: "https://e.test/b", text: "x".repeat(500) },
    { sourceItemId: "c", canonicalUrl: "https://e.test/c", text: "another short" },
  ];
  const plan = buildBackfillPlan({
    pair,
    pages: [{ page: 1, items }],
    posted: [],
    options: {
      max: 20,
      pages: 1,
      pageSize: 10,
      intervalMinutes: 0,
      allowPublish: false,
      overlengthStrategy: "skip",
    },
    destinationLookupSupported: false,
    generatedAt: new Date("2026-05-02T00:00:00.000Z"),
    destinationMaxLength: 280,
  });
  assert.equal(plan.skippedOverlength, 1);
  const overlength = plan.candidates.find((c) => c.decisionAtPlan === "skip-too-long");
  assert.equal(overlength.sourceItemId, "b");
  assert.equal(overlength.destinationMaxLength, 280);
}

// ---------- 5. buildBackfillPlan — truncate decision captured ----------
{
  const items = [
    { sourceItemId: "x", canonicalUrl: "https://e.test/x", text: "a".repeat(500) },
  ];
  const plan = buildBackfillPlan({
    pair,
    pages: [{ page: 1, items }],
    posted: [],
    options: {
      max: 20,
      pages: 1,
      pageSize: 10,
      intervalMinutes: 0,
      allowPublish: false,
      overlengthStrategy: "truncate",
    },
    destinationLookupSupported: false,
    generatedAt: new Date("2026-05-02T00:00:00.000Z"),
    destinationMaxLength: 100,
  });
  assert.equal(plan.skippedOverlength, 0);
  assert.equal(plan.truncatedCount, 1);
  const c = plan.candidates[0];
  assert.equal(c.decisionAtPlan, "truncate");
  assert.equal(c.draftChars, 500);
  assert.ok(c.truncatedDraftChars <= 100);
  assert.ok(c.truncatedDraftText.endsWith("…"));
}

(async () => {
  await skipStrategyTest();
  await truncateStrategyTest();
  await noMaxLengthTest();
  console.log("overlength regression passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
