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

console.log("dedupe regression passed");
