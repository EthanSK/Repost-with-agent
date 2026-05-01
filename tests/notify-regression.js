// Regression tests for the Telegram-on-publish notifier. Pure-function tests
// only — no real network. Run via `npm test`.
//
// Covers:
//   1. buildPublishMessage shape (HTML escape, fields, truncation)
//   2. notifyPublishSuccess success path (mock fetch, asserts URL + body)
//   3. notifyPublishSuccess HTTP-error path (records error, never throws)
//   4. notifyPublishSuccess unconfigured path (no fetch attempt, returns
//      attempted=false delivered=false)
//   5. sendTelegramMessage non-2xx response surfaces an error
//   6. sendTelegramMessage success uses correct API URL + JSON body shape

const assert = require("node:assert/strict");
const {
  buildPublishMessage,
  notifyPublishSuccess,
  sendTelegramMessage,
} = require("../dist/core/notify.js");

(async () => {
// --- 1. buildPublishMessage shape -------------------------------------------

const baseInput = {
  pairId: "linkedin-to-x",
  pairName: "LinkedIn to X",
  sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:123/",
  destinationUrl: "https://x.com/example/status/2050000000000000000",
  destinationType: "x-account",
  destinationId: "2050000000000000000",
  content: "We shipped Repost-with-agent v2.5.0 with Telegram-on-publish.",
  trigger: "pair-post",
};

const body = buildPublishMessage(baseInput);
assert.match(body, /\[Repost-with-agent\]/);
assert.match(body, /linkedin-to-x/);
assert.match(body, /LinkedIn to X/);
assert.match(body, /https:\/\/www\.linkedin\.com/);
assert.match(body, /https:\/\/x\.com\/example/);
assert.match(body, /<blockquote>/);
assert.match(body, /Repost-with-agent v2\.5\.0/);
assert.match(body, /Trigger:.*pair-post/);

// HTML-special characters in content are escaped.
const escaped = buildPublishMessage({
  ...baseInput,
  content: "Heading <h1> & <script>alert('x')</script>",
});
assert.match(escaped, /&lt;h1&gt;/);
assert.match(escaped, /&amp;/);
assert.match(escaped, /&lt;script&gt;/);
assert.doesNotMatch(escaped, /<h1>/);
assert.doesNotMatch(escaped, /<script>alert/);

// Long content is truncated with an ellipsis.
const longContent = "x".repeat(2000);
const truncated = buildPublishMessage({ ...baseInput, content: longContent });
assert.ok(truncated.length < 2000);
assert.match(truncated, /…<\/blockquote>/);

// Falls back to destination type when destinationUrl is absent.
const noDestUrl = buildPublishMessage({
  ...baseInput,
  destinationUrl: undefined,
});
assert.match(noDestUrl, /→ x-account/);

// --- 2. notifyPublishSuccess success path -----------------------------------

let capturedUrl;
let capturedInit;
const okFetch = async (url, init) => {
  capturedUrl = url;
  capturedInit = init;
  return {
    ok: true,
    status: 200,
    text: async () => "",
  };
};

const successOutcome = await notifyPublishSuccess(baseInput, {
  config: {
    source: "file",
    telegram: { enabled: true, botToken: "TESTTOKEN", chatId: "12345" },
  },
  fetchImpl: okFetch,
});

assert.equal(successOutcome.attempted, true);
assert.equal(successOutcome.delivered, true);
assert.equal(successOutcome.source, "file");
assert.equal(successOutcome.error, undefined);
assert.equal(
  capturedUrl,
  "https://api.telegram.org/botTESTTOKEN/sendMessage"
);
assert.equal(capturedInit.method, "POST");
assert.equal(capturedInit.headers["Content-Type"], "application/json");
const parsed = JSON.parse(capturedInit.body);
assert.equal(parsed.chat_id, "12345");
assert.equal(parsed.parse_mode, "HTML");
assert.match(parsed.text, /\[Repost-with-agent\]/);
assert.match(parsed.text, /linkedin-to-x/);

// --- 3. notifyPublishSuccess HTTP-error path --------------------------------

const failFetch = async () => ({
  ok: false,
  status: 401,
  text: async () => '{"description":"Unauthorized"}',
});

const failOutcome = await notifyPublishSuccess(baseInput, {
  config: {
    source: "file",
    telegram: { enabled: true, botToken: "BAD", chatId: "12345" },
  },
  fetchImpl: failFetch,
});

assert.equal(failOutcome.attempted, true);
assert.equal(failOutcome.delivered, false);
assert.match(failOutcome.error || "", /401/);
assert.match(failOutcome.error || "", /Unauthorized/);

// Network-throwing fetch is also handled.
const throwFetch = async () => {
  throw new Error("ENOTFOUND api.telegram.org");
};

const throwOutcome = await notifyPublishSuccess(baseInput, {
  config: {
    source: "file",
    telegram: { enabled: true, botToken: "T", chatId: "C" },
  },
  fetchImpl: throwFetch,
});
assert.equal(throwOutcome.attempted, true);
assert.equal(throwOutcome.delivered, false);
assert.match(throwOutcome.error || "", /ENOTFOUND/);

// --- 4. notifyPublishSuccess unconfigured path ------------------------------

let unconfiguredFetchCalled = false;
const unconfiguredFetch = async () => {
  unconfiguredFetchCalled = true;
  return { ok: true, status: 200, text: async () => "" };
};

const unconfiguredOutcome = await notifyPublishSuccess(baseInput, {
  config: { source: "none" },
  fetchImpl: unconfiguredFetch,
});

assert.equal(unconfiguredOutcome.attempted, false);
assert.equal(unconfiguredOutcome.delivered, false);
assert.equal(unconfiguredOutcome.source, "none");
assert.equal(unconfiguredFetchCalled, false, "must not hit network when unconfigured");

// Disabled flag is treated as unconfigured.
const disabledOutcome = await notifyPublishSuccess(baseInput, {
  config: {
    source: "file",
    telegram: { enabled: false, botToken: "T", chatId: "C" },
  },
  fetchImpl: unconfiguredFetch,
});
assert.equal(disabledOutcome.attempted, false);
assert.equal(disabledOutcome.delivered, false);

// --- 5. sendTelegramMessage non-2xx surfaces an error ----------------------

let threw = false;
try {
  await sendTelegramMessage(
    { enabled: true, botToken: "X", chatId: "Y" },
    "hello",
    {
      fetchImpl: async () => ({
        ok: false,
        status: 502,
        text: async () => "Bad Gateway",
      }),
    }
  );
} catch (err) {
  threw = true;
  assert.match(err.message, /502/);
  assert.match(err.message, /Bad Gateway/);
}
assert.equal(threw, true, "sendTelegramMessage must throw on non-2xx");

// --- 6. sendTelegramMessage success URL + body shape -----------------------

let passedUrl;
let passedInit;
await sendTelegramMessage(
  { enabled: true, botToken: "ABCDEF", chatId: "987" },
  "<b>hi</b>",
  {
    fetchImpl: async (url, init) => {
      passedUrl = url;
      passedInit = init;
      return { ok: true, status: 200, text: async () => "" };
    },
  }
);
assert.equal(passedUrl, "https://api.telegram.org/botABCDEF/sendMessage");
const passedBody = JSON.parse(passedInit.body);
assert.equal(passedBody.chat_id, "987");
assert.equal(passedBody.parse_mode, "HTML");
assert.equal(passedBody.text, "<b>hi</b>");
assert.equal(passedBody.disable_web_page_preview, false);

console.log("notify regression passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
