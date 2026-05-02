// Regression tests for the agent-task contract + the orchestrator's
// preview/publish flow driven by an in-process agent task handler.
// Run via `npm test`.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rwa-agent-contract-test-"));
process.env.REPOST_DATA_DIR = tmpDataDir;

const {
  newCorrelationId,
  writeAgentTask,
  readAgentTask,
  writeAgentResult,
  readAgentResult,
  clearAgentTask,
  isErrorResult,
  summarizeTask,
} = require("../dist/core/agent-task-contract.js");
const { runAgentTask, runAgentTaskExpect } = require("../dist/core/agent-runner.js");
const { previewPair, publishNextForPair } = require("../dist/core/orchestrator.js");
const { ensurePairDirs, loadPostedHistory } = require("../dist/core/runtime.js");

// ---------- 1. Correlation id format ----------
{
  const id1 = newCorrelationId();
  const id2 = newCorrelationId();
  assert.notEqual(id1, id2, "correlation ids must be unique");
  assert.match(id1, /^[a-f0-9]{16}$/);
  const prefixed = newCorrelationId("preview-mypair");
  assert.match(prefixed, /^preview-mypair-[a-f0-9]{16}$/);
}

// ---------- 2. Inbox round-trip ----------
{
  const correlationId = newCorrelationId("test-roundtrip");
  const task = {
    kind: "fetch-source",
    platform: "linkedin",
    source_url: "https://linkedin.com/in/test",
    max_items: 5,
    correlation_id: correlationId,
    pair_id: "test-pair",
  };
  const taskPath = writeAgentTask(task);
  assert.ok(fs.existsSync(taskPath));
  const back = readAgentTask(correlationId);
  assert.deepEqual(back, task);

  const result = {
    kind: "fetch-source-result",
    correlation_id: correlationId,
    items: [{ text: "hello", canonicalUrl: "https://e.test/p/1" }],
  };
  const resultPath = writeAgentResult(result);
  assert.ok(fs.existsSync(resultPath));
  const backResult = readAgentResult(correlationId);
  assert.deepEqual(backResult, result);

  clearAgentTask(correlationId);
  assert.equal(fs.existsSync(taskPath), false);
  assert.equal(fs.existsSync(resultPath), false);
}

// ---------- 3. Error result type guard ----------
{
  const ok = {
    kind: "post-to-destination-result",
    correlation_id: "x",
    posted_url: "y",
    posted_at: "z",
  };
  const err = {
    kind: "error-result",
    correlation_id: "x",
    error: "boom",
  };
  assert.equal(isErrorResult(ok), false);
  assert.equal(isErrorResult(err), true);
}

// ---------- 4. summarizeTask formatting ----------
{
  const task = {
    kind: "fetch-source",
    platform: "x",
    source_url: "https://x.com/test",
    max_items: 10,
    correlation_id: "abc",
    pair_id: "pp",
  };
  const summary = summarizeTask(task);
  assert.match(summary, /\[agent-task fetch-source\]/);
  assert.match(summary, /platform=x/);
  assert.match(summary, /correlation_id=abc/);
}

// ---------- 5. runAgentTask with in-process handler ----------
async function inProcessRun() {
  const handler = async (task) => ({
    kind: "fetch-source-result",
    correlation_id: task.correlation_id,
    items: [{ text: "from handler" }],
  });
  const task = {
    kind: "fetch-source",
    platform: "test",
    source_url: "x",
    max_items: 1,
    correlation_id: "in-proc",
    pair_id: "p",
  };
  const result = await runAgentTask(task, { handler });
  assert.equal(result.kind, "fetch-source-result");
  assert.equal(result.items[0].text, "from handler");
}

// ---------- 6. runAgentTaskExpect throws on type mismatch ----------
async function typeMismatchTest() {
  const handler = async (task) => ({
    kind: "post-to-destination-result",
    correlation_id: task.correlation_id,
    posted_url: "x",
    posted_at: "y",
  });
  const task = {
    kind: "fetch-source",
    platform: "test",
    source_url: "x",
    max_items: 1,
    correlation_id: "mismatch",
    pair_id: "p",
  };
  let threw = false;
  try {
    await runAgentTaskExpect(task, "fetch-source-result", { handler });
  } catch (err) {
    threw = true;
    assert.match(err.message, /wrong result kind/);
  }
  assert.equal(threw, true);
}

// ---------- 7. Orchestrator preview path with mock agent ----------
async function previewPairTest() {
  const pair = {
    id: "preview-test-pair",
    name: "Preview test pair",
    enabled: true,
    mode: "preview-only",
    runMode: "listen-for-future",
    source: { platform: "linkedin", url: "https://linkedin.com/in/test" },
    destination: { platform: "x", accountHint: "@test" },
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
  const handler = async (task) => {
    if (task.kind === "fetch-source") {
      return {
        kind: "fetch-source-result",
        correlation_id: task.correlation_id,
        items: [
          {
            sourceItemId: "src-1",
            canonicalUrl: "https://linkedin.com/posts/src-1",
            text: "Hello world from LinkedIn.",
          },
        ],
        auth_message: "linkedin ok",
      };
    }
    throw new Error(`unexpected kind ${task.kind}`);
  };
  const result = await previewPair(pair, {
    agent: { handler },
    skipUrlExpand: true, // avoid network for this test
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].decision.status, "new");
  assert.match(result.auth.source, /linkedin ok/);
  assert.match(result.items[0].draft.text, /Hello world from LinkedIn/);
  // The draft should also include the canonical URL since source text doesn't.
  assert.match(result.items[0].draft.text, /https:\/\/linkedin\.com\/posts\/src-1/);
}

// ---------- 8. Orchestrator publish path with mock agent — happy path ----------
async function publishHappyPath() {
  const pair = {
    id: "publish-test-pair",
    name: "Publish test pair",
    enabled: true,
    mode: "live-approved",
    runMode: "listen-for-future",
    source: { platform: "linkedin", url: "https://linkedin.com/in/test" },
    destination: { platform: "x", accountHint: "@test" },
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
  let posted = false;
  const handler = async (task) => {
    if (task.kind === "fetch-source") {
      return {
        kind: "fetch-source-result",
        correlation_id: task.correlation_id,
        items: [
          {
            sourceItemId: "src-2",
            canonicalUrl: "https://linkedin.com/posts/src-2",
            text: "Short post content.",
          },
        ],
      };
    }
    if (task.kind === "post-to-destination") {
      posted = true;
      return {
        kind: "post-to-destination-result",
        correlation_id: task.correlation_id,
        posted_url: "https://x.com/test/status/12345",
        posted_id: "12345",
        posted_at: "2026-05-02T12:00:00.000Z",
      };
    }
    throw new Error(`unexpected kind ${task.kind}`);
  };
  const outcome = await publishNextForPair(pair, {
    approve: true,
    agent: { handler },
  });
  assert.equal(outcome.status, "published");
  assert.equal(posted, true);
  assert.equal(outcome.publishResult.destinationUrl, "https://x.com/test/status/12345");
  // Posted history should now have 1 entry.
  const history = loadPostedHistory(pair.id);
  assert.equal(history.length, 1);
  assert.equal(history[0].destinationUrl, "https://x.com/test/status/12345");
  assert.equal(history[0].sourceItemId, "src-2");
}

// ---------- 9. Orchestrator publish path — agent error result halts ----------
async function publishAgentErrorPath() {
  const pair = {
    id: "publish-fail-pair",
    name: "Publish fail pair",
    enabled: true,
    mode: "live-approved",
    runMode: "listen-for-future",
    source: { platform: "linkedin", url: "https://linkedin.com/in/test" },
    destination: { platform: "x", accountHint: "@test" },
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
  const handler = async (task) => {
    if (task.kind === "fetch-source") {
      return {
        kind: "fetch-source-result",
        correlation_id: task.correlation_id,
        items: [
          {
            sourceItemId: "src-3",
            canonicalUrl: "https://linkedin.com/posts/src-3",
            text: "Another short post.",
          },
        ],
      };
    }
    if (task.kind === "post-to-destination") {
      return {
        kind: "error-result",
        correlation_id: task.correlation_id,
        error: "x.com login required",
        category: "needs-login",
      };
    }
    throw new Error(`unexpected kind ${task.kind}`);
  };
  const outcome = await publishNextForPair(pair, {
    approve: true,
    agent: { handler },
  });
  assert.equal(outcome.status, "auth-failed");
  assert.match(outcome.reason, /x\.com login required/);
  // No posted history.
  assert.equal(loadPostedHistory(pair.id).length, 0);
}

(async () => {
  await inProcessRun();
  await typeMismatchTest();
  await previewPairTest();
  await publishHappyPath();
  await publishAgentErrorPath();
  console.log("agent-task-contract regression passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
