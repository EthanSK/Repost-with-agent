const assert = require("node:assert/strict");
const { decidePreviewStatus, contentHash } = require("../dist/core/dedupe.js");

const policy = {
  requirePreviewBeforeFirstLiveRun: true,
  maxItemsPerRun: 1,
  minDelayBetweenPostsMinutes: 60,
  preferOfficialApi: true,
  blockOnUncertainDuplicate: true,
};

const oldProducerPlayerPost = [
  "Producer Player update",
  "We shipped a new version with better collaboration and review flow.",
  "Read more at https://example.com/producer-player",
].join("\n");

const posted = [
  {
    sourceItemId: "urn:li:activity:producer-player-old",
    canonicalUrl: "https://www.linkedin.com/feed/update/urn:li:activity:producer-player-old/",
    contentHash: contentHash(oldProducerPlayerPost),
    destinationType: "x-account",
    destinationId: "2036422890271215716",
    postedAt: "2026-03-24T00:00:00.000Z",
    summary: oldProducerPlayerPost.slice(0, 120),
    importedFrom: "duplicate-regression",
  },
];

const sameContentDifferentUrl = {
  sourceItemId: "urn:li:activity:producer-player-new-url",
  canonicalUrl: "https://www.linkedin.com/feed/update/urn:li:activity:producer-player-new-url/",
  text: oldProducerPlayerPost,
};

const decision = decidePreviewStatus(sameContentDifferentUrl, posted, policy);
assert.equal(decision.status, "duplicate");
assert.match(decision.reason, /content hash/i);

const newPost = {
  sourceItemId: "urn:li:activity:new-post",
  canonicalUrl: "https://www.linkedin.com/feed/update/urn:li:activity:new-post/",
  text: "A genuinely new post that has not been reposted yet.",
};
assert.equal(decidePreviewStatus(newPost, posted, policy).status, "new");

// Re-post protection — exercises the format the live `pair post` command writes.
// 2026-05-01 test post wrote {sourceItemId, canonicalUrl, contentHash, summary,
// destinationId, postedAt}. All three independent identity checks must catch
// it on a re-publish attempt:
//   1. sourceItemId match
//   2. canonicalUrl match (when sourceItemId is missing)
//   3. contentHash match (when both ids drifted)
const liveFormatText = "Prompt of the day: I want you to add a new rule to your ClaudeMD and commit it.";
const liveFormatEntry = {
  sourceItemId: "https://www.linkedin.com/feed/update/urn:li:activity:7455738751454019584/",
  canonicalUrl: "https://www.linkedin.com/feed/update/urn:li:activity:7455738751454019584/",
  contentHash: contentHash(liveFormatText),
  destinationType: "x-account",
  destinationId: "2050303942857310541",
  postedAt: "2026-05-01T19:58:47.558Z",
  summary: liveFormatText.slice(0, 240),
};

// 1. Same source item id ⇒ duplicate by id.
assert.equal(
  decidePreviewStatus(
    { sourceItemId: liveFormatEntry.sourceItemId, canonicalUrl: null, text: "irrelevant" },
    [liveFormatEntry],
    policy
  ).status,
  "duplicate"
);

// 2. Different source id but same canonical URL ⇒ duplicate by URL.
assert.equal(
  decidePreviewStatus(
    {
      sourceItemId: "urn:li:activity:different",
      canonicalUrl: liveFormatEntry.canonicalUrl,
      text: "different text",
    },
    [liveFormatEntry],
    policy
  ).status,
  "duplicate"
);

// 3. Different ids but same content text ⇒ duplicate by hash.
assert.equal(
  decidePreviewStatus(
    {
      sourceItemId: "urn:li:activity:rehosted",
      canonicalUrl: "https://www.linkedin.com/feed/update/urn:li:activity:rehosted/",
      text: liveFormatText,
    },
    [liveFormatEntry],
    policy
  ).status,
  "duplicate"
);

console.log("dedupe regression passed");
